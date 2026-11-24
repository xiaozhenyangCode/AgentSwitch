import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TranscriptEntry } from '@shared/transcript'
import type { RunRequest } from '@shared/types'
import type { RunSpec } from './agentRunner'
import { nativeSessionEntries, type NativeSessions } from './historyResume'
import { loadThreadHistory } from './threadHistoryTools'
import { Orchestrator } from './orchestrator'
import { Checkpoints } from './checkpoints'

let data: string
const runAgent = vi.hoisted(() => vi.fn())
vi.mock('electron', () => ({ app: { getPath: () => data } }))
vi.mock('./legacy', () => ({ LEGACY_PROJECT_DIR: '.agentmux', LEGACY_USER_DATA: '/tmp/agentswitch-nonexistent' }))
vi.mock('./fileProtocol', () => ({ allowRoot: vi.fn() }))
vi.mock('./usage', () => ({ recordRun: vi.fn(), refreshCodexQuota: vi.fn() }))
vi.mock('./agentRunner', () => ({ runAgent }))
vi.mock('./profiles', () => ({
  KIND_LABEL: { codex: 'Codex' },
  getConfig: () => ({ id: 'a', kind: 'codex', name: 'Codex', defaultModel: 'small' }),
  hasProfile: () => true
}))

const entry = (n: number, text: string, profileId: string | null): TranscriptEntry => ({
  id: `m${n}`, turnId: `turn-${n}`, profileId, speaker: profileId ?? '用户', time: n, text
})
const userText = 'CURRENT-START ' + '🌏'.repeat(50_000) + ' CURRENT-END'

function request(transcript: TranscriptEntry[], sessionScope?: string): RunRequest {
  return {
    threadId: 'fixture', turnId: 'new-turn', projectDir: null, text: userText, attachments: [],
    driver: { profileId: 'a', model: 'small' }, mentions: [], participants: [], transcript, sessionScope
  }
}

function start(req: RunRequest) {
  return new Promise<void>((resolve) => {
    const orchestrator = new Orchestrator((event) => { if (event.kind === 'turn-end') resolve() }, vi.fn(), vi.fn())
    orchestrator.start(req)
  })
}

beforeEach(() => {
  data = mkdtempSync(join(tmpdir(), 'agentswitch-orchestrator-test-'))
  mkdirSync(join(data, 'threads'))
  writeFileSync(join(data, 'threads', 'fixture.json'), JSON.stringify({ sessions: { a: 'previous-session' }, models: { a: 'small' } }))
  runAgent.mockReset()
})

afterEach(() => rmSync(data, { recursive: true, force: true }))

describe('orchestrator history handoff', () => {
  it('uses fresh budgeted history for a portable import and sends the entire current user message once', async () => {
    const transcript = [
      entry(1, 'ORIGINAL', null), entry(2, 'old'.repeat(60_000), 'a'),
      entry(3, 'RECENT REQUEST', null), entry(4, 'RECENT REPLY', 'a')
    ]
    let snapshot = ''
    runAgent.mockImplementation((spec: RunSpec) => {
      expect(spec.resume).toBeNull()
      expect(spec.prompt.split('## 用户消息\n')[1].startsWith(userText)).toBe(true)
      expect(spec.prompt.indexOf(userText)).toBe(spec.prompt.lastIndexOf(userText))
      expect(spec.prompt).toContain('ORIGINAL')
      expect(spec.prompt).toContain('RECENT REQUEST')
      expect(spec.prompt).toContain('RECENT REPLY')
      expect(spec.prompt).toContain('第 2 条')
      expect(spec.prompt).toContain('read_thread')
      expect(spec.prompt).not.toContain('old'.repeat(100))
      snapshot = spec.threadHistory!.args[1]
      expect(loadThreadHistory(snapshot, 'fixture')).toEqual(transcript)
      return { done: Promise.resolve({ ok: true, sessionId: 'new-session' }), kill: vi.fn() }
    })
    await start(request(transcript, 'portable-import'))
    expect(existsSync(snapshot)).toBe(false)
  })

  it('applies the cutoff before selecting history and leaves the server out when everything fits', async () => {
    runAgent.mockImplementation((spec: RunSpec) => {
      expect(spec.resume).toBe('previous-session')
      expect(spec.prompt).toContain('## 你上次回复之后的对话')
      expect(spec.prompt).toContain('第 3 条')
      expect(spec.prompt).not.toContain('ALREADY SEEN')
      expect(spec.prompt).not.toContain('read_thread')
      expect(spec.threadHistory).toBeUndefined()
      return { done: Promise.resolve({ ok: true, sessionId: 'previous-session' }), kill: vi.fn() }
    })
    await start(request([entry(1, 'ALREADY SEEN', null), entry(2, 'Last reply', 'a'), entry(3, 'New history', 'b')]))
  })

  it.each(['stopped', 'error'] as const)('records a new %s session on disk without offering it for resume', async (status) => {
    const req = request([], 'portable-import')
    runAgent.mockReturnValueOnce({
      done: Promise.resolve({ ok: false, stopped: status === 'stopped', error: status === 'error' ? 'Fixture failure' : null, sessionId: 'unconfirmed-session' }),
      kill: vi.fn()
    })
    await start(req)
    const state: NativeSessions = JSON.parse(readFileSync(join(data, 'threads', 'fixture.json'), 'utf8'))
    expect(nativeSessionEntries(state)).toContainEqual(['a', 'unconfirmed-session'])
    expect(state.sessions).toEqual({ a: 'previous-session' })
    expect(state.models).toEqual({ a: 'small' })

    runAgent.mockReturnValueOnce({ done: Promise.resolve({ ok: true, sessionId: 'next-session' }), kill: vi.fn() })
    await start({ ...req, turnId: 'retry-turn' })
    expect(runAgent.mock.calls[1][0].resume).toBeNull()
  })

})

describe('orchestrator checkpoints', () => {
  it('captures before running the model and publishes after it has finished', async () => {
    const repo = join(data, 'project')
    mkdirSync(repo)
    const file = join(repo, 'notes.txt')
    writeFileSync(file, 'before')
    const checkpoints = new Checkpoints(data)
    runAgent.mockImplementation(() => {
      writeFileSync(file, 'after')
      return { done: Promise.resolve({ ok: true }), kill: vi.fn() }
    })

    await new Promise<void>((resolve) => {
      const orchestrator = new Orchestrator((event) => { if (event.kind === 'turn-end') resolve() }, vi.fn(), vi.fn(), checkpoints)
      orchestrator.start({ ...request([]), projectDir: repo })
    })
    const req = request([])
    const plan = await checkpoints.action(req.threadId, req.turnId, () => false)
    expect(plan).toMatchObject({ kind: 'plan', files: ['notes.txt'], conflicts: [] })
    if (plan.kind !== 'plan') throw new Error('Checkpoint missing')
    await expect(checkpoints.action(req.threadId, req.turnId, () => false, plan.token, 'skip')).resolves.toMatchObject({ kind: 'undone' })
    expect(readFileSync(file, 'utf8')).toBe('before')
  })

  it('continues the turn when checkpoint creation fails', async () => {
    const checkpoints = new Checkpoints(data)
    vi.spyOn(checkpoints, 'begin').mockRejectedValueOnce(new Error('Snapshot unavailable'))
    runAgent.mockReturnValueOnce({ done: Promise.resolve({ ok: true }), kill: vi.fn() })
    await new Promise<void>((resolve) => {
      const orchestrator = new Orchestrator((event) => { if (event.kind === 'turn-end' && event.status === 'done') resolve() }, vi.fn(), vi.fn(), checkpoints)
      orchestrator.start(request([]))
    })
    expect(runAgent).toHaveBeenCalledOnce()
  })
})
