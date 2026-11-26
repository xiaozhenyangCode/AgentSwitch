import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { estimateTokens } from '@shared/contextBudget'
import { formatComposerFileRef, formatInlineCodePath } from '@shared/fileReferences'
import type { TranscriptEntry } from '@shared/transcript'
import type { AgentEvent, ChatEvent, RunRequest } from '@shared/types'
import type { RunSpec } from './agentRunner'
import { nativeSessionEntries, type NativeSessions } from './historyResume'
import { cleanupAllPersistentThreadHistory, upsertPersistentThreadHistory } from './threadHistoryConfig'
import { loadThreadHistory } from './threadHistoryTools'
import { Orchestrator } from './orchestrator'
import { Checkpoints } from './checkpoints'

let data: string
const runAgent = vi.hoisted(() => vi.fn())
const getConfig = vi.hoisted(() => vi.fn())
const acpDisabled = vi.hoisted(() => vi.fn(() => false))
vi.mock('electron', () => ({ app: { getPath: () => data } }))
vi.mock('./legacy', () => ({ LEGACY_PROJECT_DIR: '.agentmux', LEGACY_USER_DATA: '/tmp/agentswitch-nonexistent' }))
vi.mock('./fileProtocol', () => ({ allowRoot: vi.fn() }))
vi.mock('./usage', () => ({ recordRun: vi.fn(), refreshPostRunQuota: vi.fn() }))
vi.mock('./agentRunner', () => ({ runAgent }))
vi.mock('./acp/pool', () => ({ agyAcpPool: { disabled: acpDisabled } }))
vi.mock('./threadHistoryConfig', async (original) => {
  const actual = await original<typeof import('./threadHistoryConfig')>()
  return { ...actual, upsertPersistentThreadHistory: vi.fn(actual.upsertPersistentThreadHistory) }
})
vi.mock('./profiles', () => ({
  KIND_LABEL: { codex: 'Codex', gemini: 'Gemini' },
  getConfig,
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

function start(req: RunRequest, onEvent?: (event: ChatEvent) => void) {
  return new Promise<void>((resolve) => {
    const orchestrator = new Orchestrator((event) => {
      onEvent?.(event)
      if (event.kind === 'turn-end') resolve()
    }, vi.fn(), vi.fn())
    orchestrator.start(req)
  })
}

beforeEach(() => {
  data = mkdtempSync(join(tmpdir(), 'agentswitch-orchestrator-test-'))
  mkdirSync(join(data, 'threads'))
  writeFileSync(join(data, 'threads', 'fixture.json'), JSON.stringify({ sessions: { a: 'previous-session' }, models: { a: 'small' } }))
  runAgent.mockReset()
  getConfig.mockReset().mockReturnValue({ id: 'a', kind: 'codex', name: 'Codex', defaultModel: 'small' })
  acpDisabled.mockReset().mockReturnValue(false)
  vi.mocked(upsertPersistentThreadHistory).mockClear()
})

afterEach(() => {
  cleanupAllPersistentThreadHistory()
  rmSync(data, { recursive: true, force: true })
})

it('serializes workspace and staged attachment paths and forwards the image payloads', async () => {
  const projectDir = join(data, 'project')
  const staging = join(data, 'staging')
  mkdirSync(join(projectDir, 'docs'), { recursive: true })
  mkdirSync(staging)
  const label = 'docs/my @review `spec`.md'
  const workspace = join(projectDir, label)
  const layout = join(projectDir, 'layout.png')
  const screenshot = join(staging, 'unique-clipboard.png')
  const external = join(data, 'outside notes.txt')
  for (const path of [workspace, screenshot, layout, external]) writeFileSync(path, path === screenshot ? 'clipboard fixture' : 'file')
  const raw = 'Compare ' + formatComposerFileRef(label) + ' against #capture.png'
  const req: RunRequest = { ...request([]), projectDir, text: raw, attachments: [
    { name: 'my @review `spec`.md', path: workspace, isImage: false, source: 'workspace-file', relativePath: label },
    { name: 'capture.png', path: screenshot, isImage: true, source: 'chat-attachment', refLabel: 'capture.png' },
    { name: 'layout.png', path: layout, isImage: true, source: 'workspace-file', relativePath: 'layout.png' },
    { name: 'outside notes.txt', path: external, isImage: false }
  ] }
  runAgent.mockReturnValue({ done: Promise.resolve({ ok: true, sessionId: 'fixture-session' }), kill: vi.fn() })
  const events: ChatEvent[] = []
  await start(req, (event) => events.push(event))
  const runDir = join(projectDir, '.agentswitch', 'runs', req.turnId)
  const archived = join(runDir, 'attachments', 'capture.png')
  const spec: RunSpec = runAgent.mock.calls[0][0]
  const text = 'Compare ' + formatInlineCodePath(label) + ' against ' + formatInlineCodePath(archived) +
    '\n\n附带文件：\n- `layout.png`\n- ' + formatInlineCodePath(realpathSync(external))
  expect(spec.prompt).toContain(text)
  expect(spec.prompt).not.toContain('#capture.png')
  expect(spec.prompt).not.toContain('## 用户附件')
  expect(spec.images).toEqual([archived, realpathSync(layout)])
  expect(spec.attachments?.map(({ scope, absPath }) => [scope, absPath])).toEqual([
    ['workspace', realpathSync(workspace)], ['external', archived], ['workspace', realpathSync(layout)], ['external', realpathSync(external)]
  ])
  expect(readFileSync(archived, 'utf8')).toBe('clipboard fixture')
  expect(events.find((event) => event.kind === 'turn-start')).toMatchObject({ archivedAttachments: [{ from: screenshot, to: archived }] })
  const task = JSON.parse(readFileSync(join(runDir, 'task.json'), 'utf8'))
  expect(task.userText).toBe(text)
  expect(task.attachments).toEqual(spec.attachments?.map((item) => item.absPath))

  rmSync(screenshot)
  await start({ ...req, turnId: 'resent', text: '#capture.png', attachments: [{ ...req.attachments[1], path: archived }] })
  const resend: RunSpec = runAgent.mock.calls[1][0]
  expect(resend.attachments?.[0]).toMatchObject({ scope: 'external', absPath: realpathSync(archived) })
  expect(resend.prompt).toContain(formatInlineCodePath(realpathSync(archived)))
})

it('filters CLI output events and disk-discovered files without excluding the current output directory', async () => {
  const projectDir = join(data, 'project')
  mkdirSync(join(projectDir, '.godot'), { recursive: true })
  writeFileSync(join(projectDir, '.gitignore'), '.agentswitch/\n*.ignored\n')
  const received: string[] = []
  runAgent.mockImplementation((spec: RunSpec, emit: (event: AgentEvent) => void) => {
    writeFileSync(join(projectDir, '.godot', 'shader.index'), 'cache')
    writeFileSync(join(projectDir, 'ignored.ignored'), 'ignored')
    writeFileSync(join(projectDir, 'source.ts'), 'export {}')
    writeFileSync(join(spec.outDir, 'asset.bin'), 'explicit deliverable')
    writeFileSync(join(spec.outDir, 'work.tmp'), 'temporary')
    for (const path of ['.godot/shader.index', 'ignored.ignored', join(spec.outDir, 'work.tmp'), join(spec.outDir, 'asset.bin')]) {
      emit({ t: 'output', path })
    }
    return { done: Promise.resolve({ ok: true, sessionId: 'new-session' }), kill: vi.fn() }
  })

  const req = { ...request([]), projectDir, text: 'Create outputs' }
  await start(req, (event) => {
    if (event.kind === 'agent' && event.event.t === 'output') received.push(event.event.path)
  })
  expect(received).toEqual([
    join(projectDir, '.agentswitch/outputs', req.turnId, 'asset.bin'),
    join(projectDir, 'source.ts')
  ])
})

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

  it('gives an ACP resume an incremental prompt and a fresh-session handoff within the history budget', async () => {
    getConfig.mockReturnValue({ id: 'a', kind: 'gemini', name: 'Gemini', defaultModel: 'small', agyTransport: 'acp' })
    const transcript = [
      entry(1, 'ORIGINAL REQUEST', null), entry(2, 'old'.repeat(60_000), 'a'),
      entry(3, 'RECENT REQUEST', null), entry(4, 'RECENT REPLY', 'a'), entry(5, 'NEW UPDATE', 'b')
    ]
    runAgent.mockReturnValueOnce({ done: Promise.resolve({ ok: true, sessionId: 'previous-session' }), kill: vi.fn() })
    await start(request(transcript))

    const spec: RunSpec = runAgent.mock.calls[0][0]
    expect(spec.resume).toBe('previous-session')
    expect(spec.prompt).toContain('你上次回复之后的对话')
    expect(spec.prompt).toContain('NEW UPDATE')
    expect(spec.prompt).not.toContain('ORIGINAL REQUEST')
    expect(spec.prompt).not.toContain('RECENT REPLY')
    const fresh = spec.freshPrompt!()
    expect(fresh).toContain('之前的对话')
    expect(fresh).toContain('ORIGINAL REQUEST')
    expect(fresh).toContain('RECENT REPLY')
    expect(fresh).toContain('NEW UPDATE')
    expect(fresh).toContain('read_thread')
    expect(spec.freshPrompt!(false)).not.toContain('read_thread')
    const handoff = fresh.split('\n\n## 用户消息\n')[0].split('\n').slice(1).join('\n')
    expect(estimateTokens(handoff)).toBeLessThanOrEqual(16_000)
    expect(fresh.indexOf(userText)).toBeGreaterThanOrEqual(0)
    expect(fresh.indexOf(userText)).toBe(fresh.lastIndexOf(userText))
  })

  it('mounts ACP history from the first turn and refreshes it at the same path when the recap grows', async () => {
    getConfig.mockReturnValue({ id: 'a', kind: 'gemini', name: 'Gemini', defaultModel: 'small', agyTransport: 'acp' })
    runAgent.mockImplementation(() => ({ done: Promise.resolve({ ok: true, sessionId: 'first-session' }), kill: vi.fn() }))
    const first = request([entry(1, 'FIRST QUESTION', null)], 'fresh-acp')
    await start(first)
    const opened: RunSpec = runAgent.mock.calls[0][0]
    expect(opened.resume).toBeNull()
    expect(opened.prompt).not.toContain('read_thread')
    const path = opened.threadHistory!.args[1]
    expect(loadThreadHistory(path, first.threadId)).toEqual(first.transcript)

    const transcript = [
      ...first.transcript, entry(2, 'FIRST REPLY', 'a'), entry(3, 'large'.repeat(50_000), 'b'), entry(4, 'FOLLOW UP', null)
    ]
    await start({ ...first, transcript, turnId: 'next-turn' })
    const resumed: RunSpec = runAgent.mock.calls[1][0]
    expect(resumed.resume).toBe('first-session')
    expect(resumed.threadHistory).toEqual(opened.threadHistory)
    expect(loadThreadHistory(path, first.threadId)).toEqual(transcript)
    expect(resumed.prompt).toContain('read_thread')
    expect(resumed.promptWithoutThreadHistory!()).not.toContain('read_thread')
    expect(resumed.system).toBe(opened.system)
  })

  it.each(['write failure', 'print', 'ACP disabled'] as const)('omits unavailable history tooling when %s', async (reason) => {
    getConfig.mockReturnValue({
      id: 'a', kind: 'gemini', name: 'Gemini', defaultModel: 'small', agyTransport: reason === 'print' ? 'print' : 'acp'
    })
    acpDisabled.mockReturnValue(reason === 'ACP disabled')
    if (reason === 'write failure') vi.mocked(upsertPersistentThreadHistory).mockImplementationOnce(() => { throw new Error('Disk full') })
    runAgent.mockReturnValueOnce({ done: Promise.resolve({ ok: true, sessionId: 'previous-session' }), kill: vi.fn() })
    const transcript = [entry(1, 'FIRST QUESTION', null), entry(2, 'FIRST REPLY', 'a'), entry(3, 'old'.repeat(65_000), 'b')]
    await start(request(transcript))
    const spec: RunSpec = runAgent.mock.calls[0][0]
    expect(spec.threadHistory).toBeUndefined()
    expect(spec.prompt).toContain('已省略')
    expect(spec.prompt).not.toContain('read_thread')
    if (reason === 'write failure') {
      expect(upsertPersistentThreadHistory).toHaveBeenCalledOnce()
      expect(spec.freshPrompt!()).toContain('FIRST QUESTION')
      expect(spec.freshPrompt!(true)).not.toContain('read_thread')
    } else {
      expect(upsertPersistentThreadHistory).not.toHaveBeenCalled()
      expect(spec.freshPrompt).toBeUndefined()
    }
  })

  it('keeps the system text byte-identical across turns and puts per-turn lines at the end of the prompt', async () => {
    const specs: RunSpec[] = []
    runAgent.mockImplementation((spec: RunSpec) => {
      specs.push(spec)
      return { done: Promise.resolve({ ok: true, sessionId: 'previous-session' }), kill: vi.fn() }
    })
    const req = { ...request([]), text: '你好', participants: ['a', 'b'] }
    await start({ ...req, turnId: 'turn-one' })
    await start({ ...req, turnId: 'turn-two', text: 'hello in English please' })
    const [one, two] = specs
    expect(one.system).toBeTruthy()
    expect(two.system).toBe(one.system)
    for (const s of specs) {
      expect(s.system).not.toMatch(/turn-one|turn-two|runs\/|outputs\//)
      expect(s.system).not.toContain('回复使用 Markdown')
      expect(s.system).not.toContain('agentswitch:task')
      expect(s.prompt).toContain('<!-- agentswitch:task:当前任务进度总结 -->')
    }
    const env = (p: string) => p.slice(p.lastIndexOf('## 本轮环境'))
    expect(env(one.prompt)).toContain('runs/turn-one/')
    expect(env(one.prompt)).toContain('outputs/turn-one/')
    expect(env(one.prompt)).toContain('用中文回复')
    expect(env(two.prompt)).toContain('runs/turn-two/')
    expect(two.prompt.trimEnd().endsWith('Language: the user writes in English. Reply in English.')).toBe(true)
  })

  it('streams only the display text and delivers hidden progress with the completed reply', async () => {
    const events: ChatEvent[] = []
    runAgent.mockImplementation((_spec: RunSpec, emit: (event: AgentEvent) => void) => {
      for (const delta of ['已完成。\n<', '!-- agentswitch:ta', 'sk:下一步验证 --', '>']) emit({ t: 'text', delta })
      return { done: Promise.resolve({ ok: true, sessionId: 'new-session' }), kill: vi.fn() }
    })

    await start({ ...request([]), text: '核对缓存' }, (event) => events.push(event))

    expect(runAgent).toHaveBeenCalledOnce()
    expect(events.flatMap((e) => e.kind === 'agent' && e.event.t === 'text' ? [e.event.delta] : [])).toEqual(['已完成。\n'])
    expect(events.find((e) => e.kind === 'step-end')).toMatchObject({ status: 'done', marks: { task: '下一步验证' } })
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

describe('orchestrator compact sessions', () => {
  it('unbinds only the named accounts, keeps the history ids, and the next turn hands off instead of resuming', async () => {
    writeFileSync(join(data, 'threads', 'fixture.json'), JSON.stringify({ sessions: { a: 'long-session', b: 'other-session' }, models: { a: 'small', b: null } }))
    const orchestrator = new Orchestrator(vi.fn(), vi.fn(), vi.fn())
    expect(orchestrator.compactThreadSessions('fixture', ['a'])).toBe(true)
    const state: NativeSessions = JSON.parse(readFileSync(join(data, 'threads', 'fixture.json'), 'utf8'))
    expect(state.sessions).toEqual({ b: 'other-session' })
    expect(nativeSessionEntries(state)).toContainEqual(['a', 'long-session'])
    // nothing bound any more: no-op
    expect(orchestrator.compactThreadSessions('fixture', ['a'])).toBe(false)

    runAgent.mockImplementationOnce((spec: RunSpec) => {
      expect(spec.resume).toBeNull()
      expect(spec.prompt).toContain('## 之前的对话')
      expect(spec.prompt).toContain('EARLIER WORK')
      return { done: Promise.resolve({ ok: true, sessionId: 'fresh-session' }), kill: vi.fn() }
    })
    await start(request([entry(1, 'EARLIER WORK', null), entry(2, 'Reply', 'a')]))
    expect(runAgent).toHaveBeenCalledOnce()
  })
})

describe('orchestrator native titles', () => {
  it('forwards native title events only when wantTitle is requested', async () => {
    const collect = (wantTitle: boolean) => new Promise<unknown[]>((resolve) => {
      const events: unknown[] = []
      runAgent.mockImplementationOnce((_spec: RunSpec, emit: (event: unknown) => void) => {
        emit({ t: 'title', title: 'Native Title' })
        return { done: Promise.resolve({ ok: true, sessionId: 's1' }), kill: vi.fn() }
      })
      const orchestrator = new Orchestrator((event) => {
        events.push(event)
        if (event.kind === 'turn-end') resolve(events)
      }, vi.fn(), vi.fn())
      orchestrator.start({ ...request([]), wantTitle })
    })

    const withTitle = await collect(true)
    expect(withTitle).toContainEqual(expect.objectContaining({ kind: 'agent', event: { t: 'title', title: 'Native Title' } }))

    const withoutTitle = await collect(false)
    expect(withoutTitle).not.toContainEqual(expect.objectContaining({ kind: 'agent', event: { t: 'title', title: 'Native Title' } }))
  })
})
