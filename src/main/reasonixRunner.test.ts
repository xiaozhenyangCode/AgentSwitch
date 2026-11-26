import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import type { AgentEvent, AutoApprove, ProfileConfig } from '@shared/types'
import { joinSpec } from '@shared/modelSpec'
import { reasonixAdapter, type RunSpec } from './agentRunner'
import { buildSpawnSpec, initProfiles } from './profiles'

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/fixture-user-data' },
  safeStorage: {}
}))

const cfg: ProfileConfig = {
  id: 'reasonix-fixture',
  kind: 'reasonix',
  name: 'Reasonix',
  configDir: '/tmp/reasonix-fixture',
  imported: false,
  runCommand: 'reasonix',
  loginCommand: '',
  extraEnv: {},
  defaultModel: '',
  autoApprove: 'cli',
  createdAt: 1
}

vi.mock('./shellEnv', () => ({
  getBaseEnv: () => ({ PATH: '/bin', DEEPSEEK_API_KEY: 'fixture-reasonix-secret' }),
  realHome: '/tmp/fixture-home',
  findOnPath: vi.fn(),
  strippedVarNames: () => []
}))

vi.mock('./store', () => ({
  loadStore: () => ({
    version: 2,
    profiles: [{ ...cfg, extraEnv: { DEEPSEEK_API_KEY: 'fixture-reasonix-secret', REASONIX_HOME: '/elsewhere' } }],
    kinds: {},
    migrations: ['agy-import', 'claude-auth-login']
  }),
  saveStore: vi.fn()
}))

const spec: RunSpec = {
  cfg,
  cwd: '/tmp/x',
  outDir: '/tmp/x',
  prompt: 'Fixture prompt.',
  model: null,
  system: null,
  images: [],
  resume: null
}

function replay(file: string, options = spec) {
  const lines = readFileSync(new URL(`./__fixtures__/reasonix/${file}.jsonl`, import.meta.url), 'utf8').trim().split('\n')
  const adapter = reasonixAdapter(options)
  const events: AgentEvent[] = []
  for (const line of lines) adapter.onLine(JSON.parse(line), (e) => events.push(e))
  return { adapter, events }
}

describe('Reasonix stream adapter', () => {
  it('keeps workspace image references in place and appends only missing legacy paths', () => {
    const draw = { name: 'image.png', promptPath: 'src/image.png', absPath: '/tmp/x/src/image.png',
      refLabel: 'src/image.png', scope: 'workspace' as const, isImage: true }
    const prompt = 'See `src/image.png` here.'
    const result = reasonixAdapter({ ...spec, prompt, attachments: [draw], images: [draw.absPath, '/tmp/b.png'] })
    expect(result.stdin).toBe(prompt + '\n\n- /tmp/b.png')
    expect(reasonixAdapter({ ...spec, prompt: 'Look at /tmp/b.png now', images: ['/tmp/b.png'] }).stdin)
      .toBe('Look at /tmp/b.png now')
  })

  it('streams thinking and final text exactly once and records the model and session', () => {
    const { adapter, events } = replay('thinking')
    expect(adapter.result()).toEqual({ ok: true, error: null })
    expect(adapter.model()).toBe('deepseek-flash')
    expect(events.filter((e) => e.t === 'session')).toEqual([{ t: 'session', id: adapter.sessionId(), model: 'deepseek-flash' }])
    expect(events.some((e) => e.t === 'thinking' && e.delta === 'The')).toBe(true)
    const text = events.filter((e) => e.t === 'text').map((e) => e.delta).join('')
    expect(text.match(/Merge sort is stable/g)).toHaveLength(1)
  })

  it.each([
    ['stdin', 'STDIN_OK_71'],
    ['parallel-a', 'PARALLEL_A_71'],
    ['parallel-b', 'PARALLEL_B_71']
  ])('preserves the text and session from %s', (file, expected) => {
    const { adapter, events } = replay(file)
    expect(events.filter((e) => e.t === 'text').map((e) => e.delta).join('')).toBe(expected)
    expect(adapter.sessionId()).toBeTruthy()
  })

  it('coalesces duplicate dispatches and sums request usage and final cost', () => {
    const { events } = replay('permissions')
    const activities = events.filter((e) => e.t === 'activity')
    expect(activities.map((e) => [e.id, e.type, e.status])).toEqual([
      ['rnx:fixture-8', 'run', 'running'],
      ['rnx:fixture-8', 'run', 'done']
    ])
    expect(activities[1]?.detail?.output).toContain('exit status: 0')
    expect(events.filter((e) => e.t === 'usage').at(-1)).toMatchObject({
      usage: { input: 530, output: 90, cacheRead: 12928, context: 6795, costUsd: 0.000344568, costCny: 0.00229712 }
    })
  })

  it('preserves a structured error with no session ID', () => {
    const { adapter } = replay('failure')
    expect(adapter.result()).toEqual({ ok: false, error: expect.stringContaining('unknown model "nope-x"') })
    expect(adapter.sessionId()).toBeNull()
  })

  it('reports rate limits from a structured error', () => {
    const adapter = reasonixAdapter(spec)
    const emit = vi.fn()
    adapter.onLine({ type: 'result', is_error: true, result: 'Too many requests' }, emit)
    expect(adapter.result()).toEqual({ ok: false, error: 'Too many requests' })
    expect(emit).toHaveBeenCalledWith({ t: 'rate_limited' })
  })

  it('accepts future events, independent message steps and denied tools', () => {
    const adapter = reasonixAdapter(spec)
    const emit = vi.fn()
    adapter.onLine({ kind: 'future_event' }, emit)
    adapter.onLine({ kind: 'text', text: 'one' }, emit)
    adapter.onLine({ kind: 'message', text: 'one' }, emit)
    adapter.onLine({ kind: 'message', text: 'two' }, emit)
    adapter.onLine({ type: 'result', is_error: false, session_id: 'result-only', permission_denials: [{ tool_name: 'bash' }] }, emit)
    expect(emit.mock.calls.filter(([e]) => e.t === 'text')).toEqual([[{ t: 'text', delta: 'one' }], [{ t: 'text', delta: 'two' }]])
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ t: 'other_event', kind: 'future_event' }))
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ t: 'notice' }))
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ t: 'session', id: 'result-only' }))
  })
})

describe('Reasonix arguments', () => {
  it.each([
    ['cli', null],
    ['edits', 'acceptEdits'],
    ['full', 'bypassPermissions'],
    [undefined, null]
  ] as [AutoApprove | undefined, string | null][])('maps %s to the expected permission flag', (autoApprove, mode) => {
    const adapter = reasonixAdapter({ ...spec, cfg: { ...cfg, autoApprove: autoApprove as AutoApprove } })
    expect(adapter.args).toEqual(['-p', '--output-format', 'stream-json', ...(mode ? ['--permission-mode', mode] : [])])
  })

  it('applies explicit model, effort and resume and keeps the prompt on stdin', () => {
    const adapter = reasonixAdapter({ ...spec, model: joinSpec('deepseek-flash', 'low'), resume: 'session-1', system: 'Instructions', images: ['/tmp/x.png'] })
    expect(adapter.args).toEqual(['-p', '--output-format', 'stream-json', '--model', 'deepseek-flash', '--effort', 'low', '--resume', 'session-1'])
    expect(adapter.stdin).toContain('Instructions\n\n---\n\nFixture prompt.')
    expect(adapter.stdin).toContain('/tmp/x.png')
  })

  it('passes an explicitly disabled account effort without changing the default mode', () => {
    const adapter = reasonixAdapter({ ...spec, cfg: { ...cfg, defaultModel: 'deepseek-v4-pro:disabled' } })
    expect(adapter.args).toEqual(['-p', '--output-format', 'stream-json', '--model', 'deepseek-v4-pro', '--effort', 'disabled'])
  })

  it('keeps the fixture credential out of the actual spawn environment, preview and argv', () => {
    const secret = 'fixture-reasonix-secret'
    initProfiles()
    const spawn = buildSpawnSpec(cfg.id, 'run', undefined, false)
    const adapter = reasonixAdapter(spec)
    expect(spawn.env.REASONIX_HOME).toBe(cfg.configDir)
    expect(spawn.env).not.toHaveProperty('DEEPSEEK_API_KEY')
    expect(JSON.stringify([spawn.injected, spawn.args, adapter.args])).not.toContain(secret)
  })
})
