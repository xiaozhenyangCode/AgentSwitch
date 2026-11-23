import { PassThrough } from 'node:stream'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentEvent, AutoApprove, ProfileConfig } from '@shared/types'
import { runAgent, type RunSpec } from '../agentRunner'
import { startAcpProcess } from './acpProcess'
import { autoDecision } from './agySession'
import { JsonRpc } from './jsonrpc'
import { agyAcpPool } from './pool'
import { permissions, PERMISSION_TIMEOUT } from './permissions'

const stubs = vi.hoisted(() => ({ buildSpawnSpec: vi.fn(), getConfig: vi.fn(), spawn: vi.fn() }))

vi.mock('electron', () => ({ app: { getVersion: () => '0.1.1', getPreferredSystemLanguages: () => ['en'] } }))
vi.mock('../legacy', () => ({ LEGACY_USER_DATA: '/unused' }))
vi.mock('../profiles', () => ({
  buildSpawnSpec: stubs.buildSpawnSpec,
  getConfig: stubs.getConfig,
  kindBinaryPath: () => '/fake/agy',
  expandHome: (p: string) => p
}))
vi.mock('node:child_process', async (original) => ({ ...await original<typeof import('node:child_process')>(), spawn: stubs.spawn }))
vi.mock('./acpProcess', async (original) => ({ ...await original<typeof import('./acpProcess')>(), startAcpProcess: vi.fn() }))

const cfg: ProfileConfig = {
  id: 'gemini-acp-tests', kind: 'gemini', name: 'Test', configDir: '/does-not-exist',
  imported: false, loginCommand: 'agy', runCommand: 'agy', extraEnv: {}, defaultModel: '',
  autoApprove: 'cli', agyTransport: 'acp', createdAt: 0
}
const ref = { threadId: 'thread', turnId: 'turn', stepId: 'step' }
const spec: RunSpec = { cfg, ref, model: null, prompt: 'First', system: 'System', cwd: '/tmp/project', outDir: '/tmp/output', images: [], resume: null }
const sessionId = 'conversation'
const text = (s: string, type = 'agent_message_chunk') => ({ sessionUpdate: type, content: { type: 'text', text: s } })
const call = (status: string, extra = {}) => ({ sessionUpdate: 'tool_call_update', toolCallId: 'call_1', status, ...extra })
const usage = { inputTokens: 50, outputTokens: 6, cachedReadTokens: 8, thoughtTokens: 2 }
const result = { stopReason: 'end_turn', usage }

type Message = { id?: number; method?: string; params?: any; result?: unknown }

function fakeAgy(opts: Parameters<typeof startAcpProcess>[0]) {
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  const sent: Message[] = []
  const log = opts.onLog
  const rpc = new JsonRpc(stdin, stdout, log, opts.onRequest, opts.onNotification)
  stdin.on('data', (chunk: Buffer) => sent.push(JSON.parse(chunk.toString())))
  let alive = true
  let close!: (reason: string) => void
  const exited = new Promise<string>((resolve) => { close = resolve })
  const terminate = vi.fn(() => {
    alive = false
    const reason = 'test process exited'
    rpc.close(new Error(reason))
    close(reason)
  })

  const send = (...messages: Message[]) => stdout.write(messages.map((m) => JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n').join(''))
  const request = async (method: string, count = 1): Promise<Message> => {
    const matches = () => sent.filter((msg) => msg.method === method)
    await vi.waitFor(() => expect(matches().length).toBeGreaterThanOrEqual(count))
    return matches()[count - 1]
  }
  const update = (update: object, id = sessionId): Message => ({ method: 'session/update', params: { sessionId: id, update } })
  const process = {
    rpc, exited, terminate, get alive() { return alive },
    initializeResult: { protocolVersion: 1, agentCapabilities: { _meta: { antigravity: { systemPrompt: { append: true } } } } }
  }
  return { sent, request, send, update, process }
}

describe('agy ACP runs', () => {
  let server: ReturnType<typeof fakeAgy>
  let id = cfg.id
  const emit = vi.fn<(event: AgentEvent) => void>()
  const log = vi.fn()

  beforeEach(() => {
    id = cfg.id
    emit.mockClear()
    log.mockClear()
    vi.mocked(startAcpProcess).mockReset()
    vi.mocked(startAcpProcess).mockImplementation(async (opts) => {
      server = fakeAgy(opts)
      return server.process
    })
    stubs.getConfig.mockImplementation((id: string) => ({ ...cfg, id }))
    stubs.buildSpawnSpec.mockReturnValue({ env: { HOME: cfg.configDir } })
    stubs.spawn.mockReset()
  })

  afterEach(() => {
    agyAcpPool.retire(id)
    vi.useRealTimers()
  })

  async function begin(specPatch: Partial<RunSpec> = {}) {
    const run = runAgent({ ...spec, ...specPatch }, emit, log)
    await vi.waitFor(() => expect(startAcpProcess).toHaveBeenCalled())
    return { run, cli: server }
  }

  async function sendPrompt(cli: typeof server) {
    const create = await cli.request('session/new')
    cli.send({ id: create.id, result: { sessionId } })
    return cli.request('session/prompt')
  }

  const options = [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }, {
    optionId: 'always', name: 'Always allow', kind: 'allow_always',
    _meta: { 'agy.security.warning': { title: 'Read carefully', message: 'Future commands may run without confirmation.' } }
  }, { optionId: 'deny', name: 'Deny', kind: 'reject_once' }]
  const command = { toolCallId: 'shell_1', kind: 'execute', name: 'run_command', rawInput: { CommandLine: 'echo p2-check' } }
  const ask = (toolCall: object = command, choices: object[] = options): Message =>
    ({ id: 51, method: 'session/request_permission', params: { sessionId, toolCall, options: choices } })
  const permission = () => emit.mock.calls.map(([e]) => e).find((e) => e.t === 'permission')!
  const cancelled = { outcome: { outcome: 'cancelled' } }

  it('creates an activity before the approval card, exposes it on reload and returns the selected option', async () => {
    const { run, cli } = await begin()
    const prompt = await sendPrompt(cli)
    cli.send(ask())
    const event = permission()
    expect(event).toMatchObject({
      activityId: 'agy:shell_1', kind: 'approval', title: 'run_command', detail: 'echo p2-check',
      options: [
        { id: 'allow', label: 'Allow', role: 'allow_once' },
        { id: 'always', role: 'allow_always', warning: 'Future commands may run without confirmation.' },
        { id: 'deny', role: 'reject_once' }
      ]
    })
    expect(emit.mock.calls.map(([e]) => e.t)).toEqual(['session', 'activity', 'permission'])
    expect(emit.mock.calls[1][0]).toMatchObject({ t: 'activity', id: event.activityId, status: 'running' })
    expect(permissions.pending()).toEqual([{ ...ref, event }])
    expect(permissions.reply(event.requestId, 'allow', 'user')).toBe(true)
    await vi.waitFor(() => expect(cli.sent.at(-1)).toMatchObject({ id: 51, result: { outcome: { outcome: 'selected', optionId: 'allow' } } }))
    expect(emit).toHaveBeenCalledWith({ t: 'permission_resolved', requestId: event.requestId, outcome: 'selected', optionId: 'allow', label: 'Allow', by: 'user' })
    cli.send({ id: prompt.id, result })
    await run.done
  })

  it('asks questions in full mode, preserving answer IDs and bounding labels', async () => {
    stubs.getConfig.mockReturnValue({ ...cfg, autoApprove: 'full' })
    const { run, cli } = await begin()
    const prompt = await sendPrompt(cli)
    cli.send(ask({ ...command, toolCallId: 'interaction_1', title: 'Choose **one**.' }, [
      { name: 'A'.repeat(240), optionId: 'alpha', kind: 'allow_once' },
      { name: '  ', optionId: 'beta', kind: 'reject_once' }
    ]))
    const event = permission()
    expect(event).toMatchObject({ kind: 'question', title: 'Choose **one**.', options: [
      { id: 'alpha', label: 'A'.repeat(200), role: 'answer' }, { id: 'beta', label: 'beta', role: 'answer' }
    ] })
    expect(event.activityId).toBeUndefined()
    expect(emit.mock.calls.map(([e]) => e.t)).toEqual(['session', 'permission'])
    expect(permissions.reply(event.requestId, 'beta', 'user')).toBe(true)
    await vi.waitFor(() => expect(cli.sent.at(-1)).toMatchObject({ id: 51, result: { outcome: { outcome: 'selected', optionId: 'beta' } } }))
    cli.send({ id: prompt.id, result })
    await run.done
  })

  it('writes every outstanding permission cancellation before session/cancel', async () => {
    const { run, cli } = await begin()
    const prompt = await sendPrompt(cli)
    cli.send(ask(), { ...ask(), id: 52 })
    expect(permissions.pending()).toHaveLength(2)
    run.kill()
    await cli.request('session/cancel')
    expect(cli.sent.slice(-3)).toEqual([
      { jsonrpc: '2.0', id: 51, result: cancelled },
      { jsonrpc: '2.0', id: 52, result: cancelled },
      { jsonrpc: '2.0', method: 'session/cancel', params: { sessionId } }
    ])
    expect(emit.mock.calls.filter(([e]) => e.t === 'permission_resolved').map(([e]) => e)).toEqual(
      expect.arrayContaining([expect.objectContaining({ requestId: permission().requestId, outcome: 'cancelled', by: 'auto' })]))
    expect(permissions.pending()).toHaveLength(0)
    cli.send({ id: prompt.id, result: { stopReason: 'cancelled' } })
    await expect(run.done).resolves.toMatchObject({ stopped: true })
  })

  it('rejects an expired approval and emits its notice', async () => {
    const { run, cli } = await begin()
    const prompt = await sendPrompt(cli)
    vi.useFakeTimers()
    cli.send(ask())
    await vi.advanceTimersByTimeAsync(PERMISSION_TIMEOUT)
    expect(cli.sent.at(-1)).toMatchObject({ id: 51, result: { outcome: { outcome: 'selected', optionId: 'deny' } } })
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ t: 'permission_resolved', outcome: 'timeout', by: 'auto' }))
    expect(emit).toHaveBeenCalledWith({ t: 'notice', message: expect.stringContaining('5 minutes') })
    cli.send({ id: prompt.id, result })
    await run.done
  })

  it('cancels pending requests on child exit and cancels late requests without showing a card', async () => {
    const { run, cli } = await begin()
    const prompt = await sendPrompt(cli)
    cli.send(ask(), { id: prompt.id, result }, { ...ask(), id: 52 })
    await run.done
    expect(cli.sent).toContainEqual({ jsonrpc: '2.0', id: 52, result: cancelled })
    expect(emit.mock.calls.filter(([e]) => e.t === 'permission')).toHaveLength(1)
    expect(permissions.pending()).toEqual([])

    const next = runAgent({ ...spec, resume: sessionId }, emit, log)
    await cli.request('session/prompt', 2)
    cli.send({ ...ask(), id: 53 })
    expect(permissions.pending()).toHaveLength(1)
    cli.process.terminate()
    await next.done
    expect(permissions.pending()).toEqual([])
    expect(emit.mock.calls.filter(([e]) => e.t === 'permission_resolved')).toHaveLength(2)
  })

  it('automatically allows full access without showing a card and cancels if allow_once is missing', async () => {
    stubs.getConfig.mockReturnValue({ ...cfg, autoApprove: 'full' })
    const { run, cli } = await begin()
    const prompt = await sendPrompt(cli)
    cli.send(ask(), { ...ask(command, [options[1]]), id: 52 })
    expect(cli.sent.slice(-2)).toEqual([
      { jsonrpc: '2.0', id: 51, result: { outcome: { outcome: 'selected', optionId: 'allow' } } },
      { jsonrpc: '2.0', id: 52, result: cancelled }
    ])
    expect(permission()).toBeUndefined()
    cli.send({ id: prompt.id, result })
    await run.done
  })

  it('maps the measured execute sequence and suppresses late events in the same frame', async () => {
    const { run, cli } = await begin()
    const prompt = await sendPrompt(cli)
    expect(prompt.params.prompt).toEqual([{ type: 'text', text: 'First' }])
    cli.send(
      cli.update({ sessionUpdate: 'session_info_update', title: 'Ignored' }),
      cli.update(text('Before.')),
      cli.update({ ...call('in_progress'), sessionUpdate: 'tool_call', kind: 'execute', title: 'Probe', rawInput: { CommandLine: 'echo acp-probe' } }),
      cli.update(call('pending')),
      cli.update(call('in_progress')),
      cli.update(call('completed', { content: [{ type: 'content', content: { type: 'text', text: 'Command exited with code 0.\n\nCommand output:\nacp-probe' } }] })),
      cli.update(text('Thought', 'agent_thought_chunk')),
      cli.update(text('Done.')),
      cli.update({ sessionUpdate: 'usage_update', used: 64, size: 1048576 }),
      { id: prompt.id, result },
      cli.update(text('Late.'))
    )
    await expect(run.done).resolves.toMatchObject({ ok: true, sessionId })
    expect(emit.mock.calls.map(([event]) => event)).toEqual([
      { t: 'session', id: sessionId, model: null },
      { t: 'text', delta: 'Before.' },
      ...['running', 'running', 'running'].map((status) => expect.objectContaining({ t: 'activity', id: 'agy:call_1', target: 'echo acp-probe', type: 'run', status })),
      expect.objectContaining({ t: 'activity', id: 'agy:call_1', target: 'echo acp-probe', type: 'run', status: 'done', detail: expect.objectContaining({ exitCode: 0, output: 'acp-probe' }) }),
      { t: 'thinking', delta: 'Thought' },
      { t: 'text', delta: '\n\n' },
      { t: 'text', delta: 'Done.' },
      { t: 'usage', usage: { input: 50, output: 6, cacheRead: 8, reasoning: 2, context: 64 } }
    ])
    expect(log).toHaveBeenCalledWith(expect.stringContaining('Late.'))
  })

  it('uses the shared 200-event limit and finalizes a background command', async () => {
    const { run, cli } = await begin()
    const prompt = await sendPrompt(cli)
    cli.send(...Array.from({ length: 205 }, () => cli.update({ sessionUpdate: 'plan', entries: [] })))
    cli.send(cli.update({ ...call('in_progress'), kind: 'execute', title: 'Background task' }), { id: prompt.id, result })
    await run.done
    const others = emit.mock.calls.map(([e]) => e).filter((e) => e.t === 'other_event')
    expect(others).toHaveLength(201)
    expect(others.at(-1)).toMatchObject({ kind: 'agentswitch' })
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({
      t: 'activity', id: 'agy:call_1', status: 'done', detail: expect.objectContaining({ output: 'Still running in the background' })
    }))
  })

  it('shares startup and serializes prompts to the same resumed session', async () => {
    const first = runAgent({ ...spec, resume: sessionId }, emit, log)
    const second = runAgent({ ...spec, resume: sessionId, system: 'Updated handoff path', prompt: 'Second' }, emit, log)
    await vi.waitFor(() => expect(startAcpProcess).toHaveBeenCalledTimes(1))
    const resume = await server.request('session/resume')
    expect(resume.params).toMatchObject({
      sessionId, cwd: spec.cwd, additionalDirectories: [], mcpServers: [],
      _meta: { antigravity: { systemPrompt: { append: spec.system } } }
    })
    server.send({ id: resume.id, result: { sessionId } })
    const prompt = await server.request('session/prompt')
    expect(prompt.params.prompt[0].text).toBe('First')
    expect(server.sent.filter((msg) => msg.method === 'session/prompt')).toHaveLength(1)
    expect(server.sent.filter((msg) => msg.method === 'session/resume')).toHaveLength(1)
    server.send({ id: prompt.id, result })
    await expect(first.done).resolves.toMatchObject({ ok: true })
    const followUp = await server.request('session/prompt', 2)
    expect(followUp.params.prompt[0].text).toBe('Updated handoff path\n\n---\n\nSecond')
    server.send({ id: followUp.id, result })
    await expect(second.done).resolves.toMatchObject({ ok: true })
  })

  it('uses fresh config notifications but ignores the previous setting echoed during the next setter', async () => {
    const modelOption = { id: 'model', currentValue: 'first', options: [{ value: 'first' }, { value: 'second' }] }
    const effortOption = { id: 'thought_level', category: 'thought_level', currentValue: 'high', options: [{ value: 'low' }, { value: 'high' }] }
    const { run, cli } = await begin({ model: 'second:low', resume: sessionId })
    const resume = await cli.request('session/resume')
    cli.send({ id: resume.id, result: { configOptions: [modelOption, { ...effortOption, options: [{ value: 'high' }] }] } })
    const setModel = await cli.request('session/set_config_option')
    expect(setModel.params).toEqual({ sessionId, configId: 'model', value: 'second' })
    const currentModel = { ...modelOption, currentValue: 'second' }
    const modelUpdate = { sessionUpdate: 'config_option_update', configOptions: [currentModel, effortOption] }
    cli.send(cli.update(modelUpdate), { id: setModel.id, result: { configOptions: [currentModel] } })
    const setEffort = await cli.request('session/set_config_option', 2)
    expect(setEffort.params).toEqual({ sessionId, configId: 'thought_level', value: 'low' })
    cli.send(cli.update(modelUpdate), { id: setEffort.id, result: { configOptions: [currentModel, { ...effortOption, currentValue: 'low' }] } })
    const prompt = await cli.request('session/prompt')
    cli.send({ id: prompt.id, result })
    await expect(run.done).resolves.toMatchObject({ ok: true, model: 'second:low' })
  })

  it('stops before a pending session is ready without writing prompt or cancel', async () => {
    const { run, cli } = await begin()
    const create = await cli.request('session/new')
    run.kill()
    run.kill()
    await expect(run.done).resolves.toMatchObject({ stopped: true, ok: false, error: null })
    cli.send({ id: create.id, result: { sessionId } })
    await new Promise(setImmediate)
    expect(cli.sent.map((message) => message.method)).toEqual(['session/new'])
    expect(emit).not.toHaveBeenCalled()
  })

  it('sends cancel after prompt, cancels later permissions, and waits for the prompt response', async () => {
    const { run, cli } = await begin()
    const prompt = await sendPrompt(cli)
    const finish = vi.fn()
    void run.done.then(finish)
    run.kill()
    run.kill()
    const cancel = await cli.request('session/cancel')
    expect(cancel).toEqual({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId } })
    cli.send({ method: 'session/request_permission', id: 52, params: { sessionId, toolCall: { kind: 'execute' }, options: [] } })
    expect(cli.sent.at(-1)).toMatchObject({ id: 52, result: { outcome: { outcome: 'cancelled' } } })
    expect(finish).not.toHaveBeenCalled()
    cli.send({ id: prompt.id, result: { stopReason: 'cancelled' } })
    await expect(run.done).resolves.toMatchObject({ stopped: true, ok: false, error: null })
    expect(cli.sent.filter((message) => message.method === 'session/cancel')).toHaveLength(1)
    expect(cli.process.terminate).not.toHaveBeenCalled()
  })

  it('retires the exact process after cancellation times out', async () => {
    const { run, cli } = await begin()
    await sendPrompt(cli)
    vi.useFakeTimers()
    run.kill()
    await vi.advanceTimersByTimeAsync(14_999)
    expect(cli.process.terminate).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    await expect(run.done).resolves.toMatchObject({ stopped: true, error: null })
    expect(cli.process.terminate).toHaveBeenCalledTimes(1)
  })

  it('falls back only on startup errors and disables ACP after three failed starts', async () => {
    id = 'gemini-acp-start-failures'
    vi.mocked(startAcpProcess).mockRejectedValue(new Error('broken handshake'))
    const stopped = runAgent({ ...spec, cfg: { ...cfg, id } }, emit, log)
    stopped.kill()
    await expect(stopped.done).resolves.toMatchObject({ stopped: true })
    expect(startAcpProcess).not.toHaveBeenCalled()
    stubs.spawn.mockImplementation(() => { throw new Error('print adapter reached') })
    for (let i = 0; i < 4; i++) {
      const run = runAgent({ ...spec, cfg: { ...cfg, id } }, emit, log)
      await expect(run.done).resolves.toMatchObject({ error: 'print adapter reached' })
    }
    expect(startAcpProcess).toHaveBeenCalledTimes(3)
    expect(stubs.spawn).toHaveBeenCalledTimes(4)
    expect(stubs.spawn.mock.calls.every(([, args]) => args.includes('-p'))).toBe(true)
    expect(emit.mock.calls.filter(([e]) => e.t === 'notice')).toHaveLength(3)
  })

  it('reports session failures without falling back to print', async () => {
    const { run, cli } = await begin()
    const create = await cli.request('session/new')
    cli.send({ id: create.id, result: {} })
    await expect(run.done).resolves.toMatchObject({ ok: false, error: expect.stringContaining('no session ID') })
    expect(stubs.spawn).not.toHaveBeenCalled()
  })

  it('settings changes wait for the running turn before restarting the process', async () => {
    const { run, cli } = await begin()
    const prompt = await sendPrompt(cli)
    agyAcpPool.retireWhenIdle(id)
    expect(cli.process.terminate).not.toHaveBeenCalled()
    cli.send(cli.update(text('still here')), { id: prompt.id, result })
    await expect(run.done).resolves.toMatchObject({ ok: true })
    expect(cli.process.terminate).toHaveBeenCalledTimes(1)
  })

  it('defers idle cleanup while a background command is still running', async () => {
    const { run, cli } = await begin()
    const prompt = await sendPrompt(cli)
    vi.useFakeTimers()
    cli.send(cli.update({ ...call('in_progress'), kind: 'execute' }), { id: prompt.id, result })
    await run.done
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(cli.process.terminate).not.toHaveBeenCalled()
    cli.send(cli.update(call('completed')))
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(cli.process.terminate).toHaveBeenCalledTimes(1)
  })
})

describe('agy automatic permission decisions', () => {
  const project = mkdtempSync(join(tmpdir(), 'agy-perm-'))
  const cases: [AutoApprove, string, 'allow' | 'ask'][] = [
    ['full', 'command-or-external', 'allow'], ['full', 'project-edit', 'allow'], ['full', 'read', 'allow'], ['full', 'question', 'ask'],
    ['edits', 'command-or-external', 'ask'], ['edits', 'project-edit', 'allow'], ['edits', 'read', 'allow'], ['edits', 'question', 'ask'],
    ['cli', 'command-or-external', 'ask'], ['cli', 'project-edit', 'ask'], ['cli', 'read', 'ask'], ['cli', 'question', 'ask']
  ]
  it.each(cases)('%s handling %s', (level, tool, expected) => {
    const kind = { 'command-or-external': 'execute', 'project-edit': 'edit', read: 'read', question: 'other' }[tool]
    const toolCall = { toolCallId: tool === 'question' ? 'interaction_1' : 'tool_1', kind, locations: [{ path: join(project, 'a.ts') }] }
    expect(autoDecision({ toolCall }, level, project)).toBe(expected)
    if (kind === 'execute') {
      const external = { ...toolCall, kind: 'edit', locations: [{ path: '/etc/hosts' }] }
      expect(autoDecision({ toolCall: external }, level, project)).toBe(expected)
    }
  })

  it.each([
    ['outside the project', { locations: [{ path: '/etc/hosts' }] }, 'ask'],
    ['escaping with ..', { rawInput: { TargetFile: '../outside.ts' } }, 'ask'],
    ['with no path', {}, 'ask'],
    ['relative inside', { rawInput: { TargetFile: 'src/new.ts' } }, 'allow'],
    ['one of two outside', { locations: [{ path: join(project, 'a.ts') }], rawInput: { DestinationPath: '/tmp/x' } }, 'ask']
  ])('edits: an edit %s', (_label, fields, expected) => {
    const toolCall = { toolCallId: 'e1', kind: 'edit', title: 'Edit', ...fields }
    expect(autoDecision({ toolCall }, 'edits', project)).toBe(expected)
  })

  it('edits: reads outside the project stay allowed', () => {
    const toolCall = { toolCallId: 'r1', kind: 'read', locations: [{ path: '/etc/hosts' }] }
    expect(autoDecision({ toolCall }, 'edits', project)).toBe('allow')
  })
})
