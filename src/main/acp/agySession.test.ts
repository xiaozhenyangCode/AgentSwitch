import { PassThrough } from 'node:stream'
import { existsSync, mkdirSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentEvent, AutoApprove, ProfileConfig } from '@shared/types'
import { runAgent, type RunSpec } from '../agentRunner'
import { cleanupAllPersistentThreadHistory, upsertPersistentThreadHistory } from '../threadHistoryConfig'
import { createThreadHistoryReader, threadTools } from '../threadHistoryTools'
import { startAcpProcess } from './acpProcess'
import { agyPrefixHash, autoDecision, normalizeAcpUsage } from './agySession'
import { JsonRpc } from './jsonrpc'
import { agyAcpPool, IDLE_MS } from './pool'
import { permissions, PERMISSION_TIMEOUT } from './permissions'

const stubs = vi.hoisted(() => ({ buildSpawnSpec: vi.fn(), getConfig: vi.fn(), spawn: vi.fn() }))

vi.mock('electron', () => ({ app: { getVersion: () => '0.1.1', getPreferredSystemLanguages: () => ['en'] } }))
vi.mock('../legacy', () => ({ LEGACY_USER_DATA: '/unused' }))
vi.mock('../profiles', () => ({
  buildSpawnSpec: stubs.buildSpawnSpec,
  getConfig: stubs.getConfig,
  kindBinaryPath: () => '/fake/agy',
  hasProfile: () => false,
  getKindConfig: () => ({ models: ['gemini-test-default'] }),
  resolveProfileDir: (cfg: ProfileConfig) => cfg.extraEnv.HOME || cfg.configDir,
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
const cacheDebugEnv = 'AGENTSWITCH_DEBUG_ACP_CACHE'

describe('agy ACP cache diagnostics', () => {
  it.each([
    ['a single call', usage, { input: 50, output: 6, cacheRead: 8, reasoning: 2 }],
    ['a turn with multiple tool calls', { inputTokens: 12_000, outputTokens: 600, cachedReadTokens: 300_000, thoughtTokens: 200 },
      { input: 12_000, output: 600, cacheRead: 300_000, reasoning: 200 }],
    ['no cache reads', { ...usage, cachedReadTokens: 0 }, { input: 50, output: 6, cacheRead: undefined, reasoning: 2 }],
    ['a high cache hit', { ...usage, inputTokens: 1, cachedReadTokens: 99_999 },
      { input: 1, output: 6, cacheRead: 99_999, reasoning: 2 }]
  ])('preserves uncached input for %s', (_label, raw, expected) => {
    expect(normalizeAcpUsage(raw)).toStrictEqual(expected)
  })

  it('hashes the fixed system and the mounted tool schemas', () => {
    const hash = agyPrefixHash(spec.system, true)
    expect(hash).toMatch(/^[0-9a-f]{16}$/)
    expect(agyPrefixHash(spec.system, true)).toBe(hash)
    expect(agyPrefixHash('Changed system', true)).not.toBe(hash)
    expect(agyPrefixHash(spec.system, false)).not.toBe(hash)
  })

  it('ignores object key order throughout the tool schema', () => {
    const hash = agyPrefixHash(spec.system, true)
    const [tool] = threadTools
    const original = tool.inputSchema
    const reordered = {
      ...Object.fromEntries(Object.entries(original).reverse()),
      properties: Object.fromEntries(Object.entries(original.properties).reverse())
    }
    Object.defineProperty(tool, 'inputSchema', { value: reordered })
    try {
      expect(agyPrefixHash(spec.system, true)).toBe(hash)
    } finally {
      Object.defineProperty(tool, 'inputSchema', { value: original })
    }
  })
})

type Message = { id?: number; method?: string; params?: any; result?: unknown; error?: { code: number; message: string } }

function fakeAgy(opts: Parameters<typeof startAcpProcess>[0], stdio?: boolean, image = false) {
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
    initializeResult: { protocolVersion: 1, agentCapabilities: {
      _meta: { antigravity: { systemPrompt: { append: true } } },
      promptCapabilities: { image },
      ...(stdio === undefined ? {} : { mcpCapabilities: { stdio } })
    } }
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
    cleanupAllPersistentThreadHistory()
    vi.useRealTimers()
    vi.unstubAllEnvs()
  })

  async function begin(specPatch: Partial<RunSpec> = {}) {
    const starts = vi.mocked(startAcpProcess).mock.calls.length
    const run = runAgent({ ...spec, ...specPatch }, emit, log)
    await vi.waitFor(() => expect(startAcpProcess).toHaveBeenCalledTimes(starts + 1))
    return { run, cli: server }
  }

  async function sendPrompt(cli: typeof server) {
    const create = await cli.request('session/new')
    expect(create.params.mcpServers).toEqual([])
    cli.send({ id: create.id, result: { sessionId } })
    return cli.request('session/prompt')
  }

  it('uses response model IDs ahead of the explicit selection and configured default', async () => {
    const { run, cli } = await begin({ model: 'requested-model' })
    const prompt = await sendPrompt(cli)
    cli.send({ id: prompt.id, result: { ...result, usage: { ...usage, model: 'gemini-3.8-flash-tiered' } } })
    await expect(run.done).resolves.toMatchObject({ ok: true, model: 'gemini-3.8-flash-tiered' })
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ t: 'request_usage', model: 'gemini-3.8-flash-tiered' }))
  })

  it('uses only model metadata written after the prompt checkpoint', async () => {
    const home = mkdtempSync(join(tmpdir(), 'agentswitch-acp-model-'))
    const dir = join(home, '.gemini/antigravity-cli/conversations')
    mkdirSync(dir, { recursive: true })
    const db = new DatabaseSync(join(dir, sessionId + '.db'))
    try {
      db.exec('create table steps(idx integer primary key); create table gen_metadata(idx integer primary key, data blob)')
      const insertModel = (idx: number, id: string) => {
        const bytes = Buffer.from(id)
        db.prepare('insert into gen_metadata values (?, ?)').run(idx, Buffer.concat([Buffer.from([10, 3 + bytes.length, 154, 1, bytes.length]), bytes]))
      }
      stubs.buildSpawnSpec.mockReturnValue({ env: { HOME: home } })
      insertModel(1, 'gemini-previous-turn')
      const { run, cli } = await begin()
      const prompt = await sendPrompt(cli)
      insertModel(2, 'gemini-3.8-flash-tiered')
      cli.send({ id: prompt.id, result })
      await expect(run.done).resolves.toMatchObject({ ok: true, model: 'gemini-3.8-flash-tiered' })
      expect(emit).toHaveBeenCalledWith(expect.objectContaining({ t: 'request_usage', model: 'gemini-3.8-flash-tiered' }))
    } finally {
      db.close()
      rmSync(home, { recursive: true, force: true })
    }
  })

  it.each([true, false])('pairs accepted images with their prompt paths (image capability %s)', async (image) => {
    const cwd = mkdtempSync(join(tmpdir(), 'agentswitch-acp-images-'))
    try {
      const one = join(cwd, 'first image.png')
      const two = join(cwd, 'other.png')
      const oversized = join(cwd, 'big.png')
      writeFileSync(one, Buffer.from([1, 2, 3]))
      writeFileSync(two, Buffer.from([4, 5, 6]))
      writeFileSync(oversized, '')
      truncateSync(oversized, 5 * 1024 * 1024 + 1)
      vi.mocked(startAcpProcess).mockImplementation(async (opts) => {
        server = fakeAgy(opts, undefined, image)
        return server.process
      })
      const images = [one, two, oversized]
      const paths = ['first image.png', two, 'big.png']
      const text = 'Compare `first image.png` to `' + two + '`.\n\n附带文件：\n- `big.png`'
      const { run, cli } = await begin({ cwd, prompt: text, images, attachments: images.map((absPath, i) => ({
        absPath, name: paths[i], promptPath: paths[i], refLabel: paths[i], scope: i === 1 ? 'external' : 'workspace', isImage: true
      })) })
      const prompt = await sendPrompt(cli)
      const blocks = prompt.params.prompt
      expect(blocks[0]).toEqual({ type: 'text', text })
      if (image) {
        expect(blocks.slice(1)).toEqual([
          { type: 'text', text: '[Image attachment: `first image.png`]' },
          { type: 'image', mimeType: 'image/png', data: 'AQID' },
          { type: 'text', text: '[Image attachment: `' + two + '`]' },
          { type: 'image', mimeType: 'image/png', data: 'BAUG' }
        ])
      } else expect(blocks).toHaveLength(1)
      cli.send({ id: prompt.id, result })
      await run.done
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  const options = [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }, {
    optionId: 'always', name: 'Always allow', kind: 'allow_always',
    _meta: { 'agy.security.warning': { title: 'Read carefully', message: 'Future commands may run without confirmation.' } }
  }, { optionId: 'deny', name: 'Deny', kind: 'reject_once' }]
  const command = { toolCallId: 'shell_1', kind: 'execute', name: 'run_command', rawInput: { CommandLine: 'echo p2-check' } }
  const ask = (toolCall: object = command, choices: object[] = options): Message =>
    ({ id: 51, method: 'session/request_permission', params: { sessionId, toolCall, options: choices } })
  const permission = () => emit.mock.calls.map(([e]) => e).find((e) => e.t === 'permission')!
  const cancelled = { outcome: { outcome: 'cancelled' } }
  const cacheLogs = () => log.mock.calls.map(([line]) => line).filter((line) => line.startsWith('[ACP cache]'))

  it('logs the same session and prefix across three turns with refreshed history', async () => {
    vi.stubEnv(cacheDebugEnv, '1')
    vi.setSystemTime(1_000)
    const history = [{ id: 'm1', turnId: 'turn', profileId: null, speaker: 'User', time: 1, text: 'First' }]
    const { run, cli } = await begin({ threadHistory: upsertPersistentThreadHistory(id, ref.threadId, history) })
    const create = await cli.request('session/new')
    cli.send({ id: create.id, result: { sessionId } })
    const first = await cli.request('session/prompt')
    vi.setSystemTime(5_000)
    cli.send({ id: first.id, result })
    await expect(run.done).resolves.toMatchObject({ ok: true })

    const warmUsage = { inputTokens: 12_000, outputTokens: 6, cachedReadTokens: 300_000, thoughtTokens: 2 }
    for (const [index, [start, end]] of [[7_000, 11_000], [14_600, 17_000]].entries()) {
      vi.setSystemTime(start)
      const number = index + 2
      const prompt = `Turn ${number}`
      history.push({ ...history[0], id: `m${number}`, text: prompt })
      const threadHistory = upsertPersistentThreadHistory(id, ref.threadId, history)
      const warm = runAgent({ ...spec, threadHistory, resume: sessionId, prompt }, emit, log)
      const request = await cli.request('session/prompt', number)
      expect(request.params).toEqual({ sessionId, prompt: [{ type: 'text', text: prompt }] })
      vi.setSystemTime(end)
      cli.send({ id: request.id, result: { ...result, usage: warmUsage } })
      await expect(warm.done).resolves.toMatchObject({ ok: true })
    }

    const prefix = agyPrefixHash(spec.system, true)
    const warmLog = `raw=${JSON.stringify(warmUsage)} normalized={"input":12000,"output":6,"cacheRead":300000,"reasoning":2} hit=96.2%\n`
    expect(cacheLogs()).toEqual([
      `[ACP cache] session=${sessionId} path=new turn=1 prefix=${prefix} system=append gap=- raw=${JSON.stringify(usage)} normalized={"input":50,"output":6,"cacheRead":8,"reasoning":2} hit=13.8%\n`,
      `[ACP cache] session=${sessionId} path=warm turn=2 prefix=${prefix} system=append gap=2.0 ${warmLog}`,
      `[ACP cache] session=${sessionId} path=warm turn=3 prefix=${prefix} system=append gap=3.6 ${warmLog}`
    ])
    expect(cli.sent.filter(({ method }) => method === 'session/new' || method === 'session/resume')).toEqual([create])
    expect(startAcpProcess).toHaveBeenCalledTimes(1)
  })

  it('emits no cache diagnostics when the debug variable is unset', async () => {
    vi.stubEnv(cacheDebugEnv, undefined)
    const { run, cli } = await begin()
    const prompt = await sendPrompt(cli)
    cli.send({ id: prompt.id, result })
    await expect(run.done).resolves.toMatchObject({ ok: true })
    expect(cacheLogs()).toEqual([])
  })

  it('logs usage returned by a cancelled prompt with no input', async () => {
    vi.stubEnv(cacheDebugEnv, '1')
    const { run, cli } = await begin()
    const prompt = await sendPrompt(cli)
    const emptyUsage = { inputTokens: 0, outputTokens: 0, cachedReadTokens: 0, thoughtTokens: 0 }
    cli.send({ id: prompt.id, result: { stopReason: 'cancelled', usage: emptyUsage } })
    await expect(run.done).resolves.toMatchObject({ stopped: true })
    expect(emit).toHaveBeenCalledWith({ t: 'usage', usage: expect.objectContaining({ input: 0, output: 0, cacheRead: undefined, reasoning: 0 }) })
    expect(cacheLogs()).toEqual([
      `[ACP cache] session=${sessionId} path=new turn=1 prefix=${agyPrefixHash(spec.system, false)} system=append gap=- raw=${JSON.stringify(emptyUsage)} normalized={"input":0,"output":0,"reasoning":0} hit=-\n`
    ])
  })

  it('keeps the history MCP mounted across a warm refresh and sends identical args after retirement', async () => {
    const firstEntry = { id: 'm1', turnId: 'turn', profileId: null, speaker: 'User', time: 1, text: 'First' }
    const threadHistory = upsertPersistentThreadHistory(id, ref.threadId, [firstEntry])
    const read = createThreadHistoryReader(threadHistory.args[1], ref.threadId)
    const { run, cli } = await begin({ threadHistory })
    const create = await cli.request('session/new')
    expect(create.params.mcpServers).toEqual([{
      name: 'agentswitch', command: threadHistory.command, args: threadHistory.args,
      env: [{ name: 'ELECTRON_RUN_AS_NODE', value: '1' }]
    }])
    cli.send({ id: create.id, result: { sessionId } })
    const first = await cli.request('session/prompt')
    expect(read()).toEqual([firstEntry])
    cli.send({ id: first.id, result })
    await run.done

    const more = [firstEntry, { ...firstEntry, id: 'm2', text: 'Second' }]
    const refreshed = upsertPersistentThreadHistory(id, ref.threadId, more)
    const warm = runAgent({ ...spec, threadHistory: refreshed, resume: sessionId }, emit, log)
    const second = await cli.request('session/prompt', 2)
    expect(read()).toEqual(more)
    cli.send(ask({ toolCallId: 'read', kind: 'other', title: 'Run mcp_agentswitch_read_thread?' }))
    expect(cli.sent.at(-1)).toMatchObject({ id: 51, result: { outcome: { outcome: 'selected', optionId: 'allow' } } })
    expect(permission()).toBeUndefined()
    expect(cli.sent.filter((message) => message.method === 'session/new')).toHaveLength(1)
    expect(cli.sent.some((message) => message.method === 'session/resume')).toBe(false)
    cli.send({ id: second.id, result })
    await warm.done

    agyAcpPool.retire(id)
    expect(existsSync(threadHistory.args[1])).toBe(true)
    const resumed = runAgent({ ...spec, threadHistory: refreshed, resume: sessionId }, emit, log)
    await vi.waitFor(() => expect(startAcpProcess).toHaveBeenCalledTimes(2))
    const resume = await server.request('session/resume')
    expect(JSON.stringify(resume.params.mcpServers)).toBe(JSON.stringify(create.params.mcpServers))
    server.send({ id: resume.id, result: { sessionId } })
    const third = await server.request('session/prompt')
    server.send({ id: third.id, result })
    await expect(resumed.done).resolves.toMatchObject({ ok: true })
  })

  it.each(['new', 'resume'] as const)('retries a rejected %s MCP setup once, then sends the tool-free prompt', async (mode) => {
    const threadHistory = upsertPersistentThreadHistory(id, ref.threadId, [])
    const promptWithoutThreadHistory = vi.fn(() => 'Tool-free handoff')
    const resume = mode === 'resume' ? sessionId : null
    const { run, cli } = await begin({ threadHistory, promptWithoutThreadHistory, resume })
    const method = `session/${mode}`
    const setup = await cli.request(method)
    expect(setup.params.mcpServers).toHaveLength(1)
    cli.send({ id: setup.id, error: { code: -32602, message: 'Unsupported mcpServers' } })
    const retry = await cli.request(method, 2)
    expect(retry.params).toEqual({ ...setup.params, mcpServers: [] })
    cli.send({ id: retry.id, result: { sessionId } })
    const prompt = await cli.request('session/prompt')
    expect(prompt.params.prompt[0].text).toBe('Tool-free handoff')
    cli.send({ id: prompt.id, result })
    await expect(run.done).resolves.toMatchObject({ ok: true })

    const next = runAgent({ ...spec, threadHistory, promptWithoutThreadHistory, resume: sessionId }, emit, log)
    const warm = await cli.request('session/prompt', 2)
    expect(warm.params.prompt[0].text).toBe('Tool-free handoff')
    expect(cli.sent.filter((msg) => msg.method === method)).toHaveLength(2)
    cli.send({ id: warm.id, result })
    await expect(next.done).resolves.toMatchObject({ ok: true })
  })

  it('uses no MCP when initialization explicitly declines stdio', async () => {
    vi.mocked(startAcpProcess).mockImplementationOnce(async (opts) => {
      server = fakeAgy(opts, false)
      return server.process
    })
    const threadHistory = upsertPersistentThreadHistory(id, ref.threadId, [])
    const { run, cli } = await begin({ threadHistory, promptWithoutThreadHistory: () => 'Tool-free handoff' })
    const prompt = await sendPrompt(cli)
    expect(prompt.params.prompt[0].text).toBe('Tool-free handoff')
    cli.send({ id: prompt.id, result })
    await expect(run.done).resolves.toMatchObject({ ok: true })
  })

  it.each(['different thread', 'missing refresh'] as const)('does not prompt a mounted old session after %s', async (reason) => {
    const threadHistory = upsertPersistentThreadHistory(id, ref.threadId, [])
    const { run, cli } = await begin({ threadHistory })
    const create = await cli.request('session/new')
    cli.send({ id: create.id, result: { sessionId } })
    const first = await cli.request('session/prompt')
    cli.send({ id: first.id, result })
    await run.done

    const nextHistory = reason === 'different thread' ? upsertPersistentThreadHistory(id, 'other-thread', []) : undefined
    const freshPrompt = vi.fn(() => 'Fresh handoff')
    const next = runAgent({ ...spec, threadHistory: nextHistory, freshPrompt, resume: sessionId }, emit, log)
    const nextSetup = await cli.request('session/new', 2)
    expect(nextSetup.params.mcpServers.map((server: { args: string[] }) => server.args[1])).toEqual(nextHistory ? [nextHistory.args[1]] : [])
    cli.send({ id: nextSetup.id, result: { sessionId: 'fresh-session' } })
    const nextPrompt = await cli.request('session/prompt', 2)
    expect(nextPrompt.params).toEqual({ sessionId: 'fresh-session', prompt: [{ type: 'text', text: 'Fresh handoff' }] })
    expect(freshPrompt).toHaveBeenCalledExactlyOnceWith(!!nextHistory)
    cli.send({ id: nextPrompt.id, result })
    await expect(next.done).resolves.toMatchObject({ ok: true })
  })

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
      cli.update({ sessionUpdate: 'session_info_update', title: '  "Probe session"  ' }),
      cli.update({ sessionUpdate: 'session_info_update', title: '   ' }),
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
      { t: 'session', id: sessionId, model: 'gemini-test-default' },
      { t: 'title', title: 'Probe session' },
      { t: 'text', delta: 'Before.' },
      ...['running', 'running', 'running'].map((status) => expect.objectContaining({ t: 'activity', id: 'agy:call_1', target: 'echo acp-probe', type: 'run', status })),
      expect.objectContaining({ t: 'activity', id: 'agy:call_1', target: 'echo acp-probe', type: 'run', status: 'done', detail: expect.objectContaining({ exitCode: 0, output: 'acp-probe' }) }),
      { t: 'thinking', delta: 'Thought' },
      { t: 'text', delta: '\n\n' },
      { t: 'text', delta: 'Done.' },
      { t: 'usage', usage: { input: 50, output: 6, cacheRead: 8, reasoning: 2, context: 64, contextWindow: 1048576 } },
      expect.objectContaining({
        t: 'request_usage',
        model: 'gemini-test-default',
        streaming: true,
        turnIndex: 1,
        usage: { input: 50, output: 6, cacheRead: 8, reasoning: 2 }
      })
    ])
    expect(log).toHaveBeenCalledWith(expect.stringContaining('Late.'))
  })

  it('falls back to conversation_summaries.db for the native title when ACP omits session_info_update', async () => {
    const home = mkdtempSync(join(tmpdir(), 'agentswitch-agy-title-'))
    try {
      const dbDir = join(home, '.gemini', 'antigravity-cli')
      mkdirSync(dbDir, { recursive: true })
      const db = new DatabaseSync(join(dbDir, 'conversation_summaries.db'))
      db.exec('create table conversation_summaries (conversation_id text primary key, title text)')
      db.prepare('insert into conversation_summaries (conversation_id, title) values (?, ?)').run(sessionId, 'DB Native Title')
      db.close()

      stubs.buildSpawnSpec.mockReturnValue({ env: { HOME: home }, injected: [] })
      const { run, cli } = await begin()
      const prompt = await sendPrompt(cli)
      cli.send(cli.update(text('Hello')), { id: prompt.id, result })
      await expect(run.done).resolves.toMatchObject({ ok: true, sessionId })
      expect(emit.mock.calls.map(([event]) => event)).toContainEqual({ t: 'title', title: 'DB Native Title' })
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
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
    const freshPrompt = vi.fn(() => 'Fresh history')
    const first = runAgent({ ...spec, resume: sessionId, freshPrompt }, emit, log)
    const second = runAgent({ ...spec, resume: sessionId, freshPrompt, system: 'Updated handoff path', prompt: 'Second' }, emit, log)
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
    expect(freshPrompt).not.toHaveBeenCalled()
    expect(log).toHaveBeenCalledWith('[ACP turn] path=resume system=append config=skipped\n')
    expect(log).toHaveBeenCalledWith('[ACP turn] path=warm system=inline config=skipped\n')
  })

  it('rebuilds the handoff only after resume fails and sends one prompt to the new session', async () => {
    const freshPrompt = vi.fn(() => 'Full handoff and current message')
    const { run, cli } = await begin({ resume: 'previous-session', freshPrompt })
    const resume = await cli.request('session/resume')
    expect(freshPrompt).not.toHaveBeenCalled()
    cli.send({ id: resume.id, error: { code: -32602, message: 'Session not found' } })

    const create = await cli.request('session/new')
    expect(freshPrompt).not.toHaveBeenCalled()
    expect(create.params._meta).toEqual(resume.params._meta)
    cli.send({ id: create.id, result: { sessionId } })
    const prompt = await cli.request('session/prompt')
    expect(prompt.params).toEqual({ sessionId, prompt: [{ type: 'text', text: 'Full handoff and current message' }] })
    expect(freshPrompt).toHaveBeenCalledExactlyOnceWith(false)
    cli.send({ id: prompt.id, result })
    await expect(run.done).resolves.toMatchObject({ ok: true, sessionId })
    expect(cli.sent.filter((msg) => msg.method === 'session/prompt')).toHaveLength(1)
    expect(log).toHaveBeenCalledWith('[ACP turn] path=resume-fallback-new system=append config=skipped\n')
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

    const warm = runAgent({ ...spec, model: 'second:low', resume: sessionId }, emit, log)
    const warmPrompt = await cli.request('session/prompt', 2)
    cli.send({ id: warmPrompt.id, result })
    await expect(warm.done).resolves.toMatchObject({ ok: true, model: 'second:low' })
    expect(cli.sent.filter((msg) => msg.method === 'session/set_config_option')).toHaveLength(2)
    expect(log).toHaveBeenCalledWith('[ACP turn] path=resume system=append config=model,thought_level\n')
    expect(log).toHaveBeenCalledWith('[ACP turn] path=warm system=append config=skipped\n')
  })

  it.each([
    { model: 'first', currentValue: undefined },
    { model: 'first', currentValue: 0 },
    { model: 'first-low', currentValue: 'first-low' }
  ])('writes model $model with agent value $currentValue when unknown or a legacy alias', async ({ model, currentValue }) => {
    const { run, cli } = await begin()
    const firstPrompt = await sendPrompt(cli)
    cli.send({ id: firstPrompt.id, result })
    await run.done
    cli.send(cli.update({ sessionUpdate: 'config_option_update', configOptions: [{ id: 'model', currentValue, options: [{ value: 'first' }] }] }))

    const warm = runAgent({ ...spec, model, resume: sessionId }, emit, log)
    const setModel = await cli.request('session/set_config_option')
    expect(setModel.params).toEqual({ sessionId, configId: 'model', value: model })
    cli.send({ id: setModel.id, result: {} })
    const prompt = await cli.request('session/prompt', 2)
    cli.send({ id: prompt.id, result })
    await expect(warm.done).resolves.toMatchObject({ ok: true })
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
    expect(agyAcpPool.retireOnCliUpdate()).toEqual({ retired: 0, deferred: 1 })
    const next = await begin()
    const nextPrompt = await sendPrompt(next.cli)
    vi.useFakeTimers()
    run.kill()
    await vi.advanceTimersByTimeAsync(14_999)
    expect(cli.process.terminate).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    await expect(run.done).resolves.toMatchObject({ stopped: true, error: null })
    expect(cli.process.terminate).toHaveBeenCalledTimes(1)
    expect(next.cli.process.terminate).not.toHaveBeenCalled()
    next.cli.send({ id: nextPrompt.id, result })
    await expect(next.run.done).resolves.toMatchObject({ ok: true })
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
      const run = runAgent({
        ...spec, cfg: { ...cfg, id }, prompt: 'Use read_thread', promptWithoutThreadHistory: () => 'Tool-free handoff'
      }, emit, log)
      await expect(run.done).resolves.toMatchObject({ error: 'print adapter reached' })
    }
    expect(startAcpProcess).toHaveBeenCalledTimes(3)
    expect(stubs.spawn).toHaveBeenCalledTimes(4)
    for (const [, args] of stubs.spawn.mock.calls) {
      expect(args.at(-2)).toBe('-p')
      expect(args.at(-1)).toContain('Tool-free handoff')
      expect(args.at(-1)).not.toContain('read_thread')
    }
    expect(emit.mock.calls.filter(([e]) => e.t === 'notice')).toHaveLength(3)
    expect(agyAcpPool.disabled(id)).toBe(true)
    expect(agyAcpPool.retireOnCliUpdate()).toEqual({ retired: 0, deferred: 0 })
    expect(agyAcpPool.disabled(id)).toBe(false)
    vi.mocked(startAcpProcess).mockImplementationOnce(async (opts) => {
      server = fakeAgy(opts)
      return server.process
    })
    const { run, cli } = await begin({ cfg: { ...cfg, id } })
    const prompt = await sendPrompt(cli)
    cli.send({ id: prompt.id, result })
    await expect(run.done).resolves.toMatchObject({ ok: true })
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

  it('retires an idle CLI immediately, clears its timer, and starts a new process for the next turn', async () => {
    const { run, cli } = await begin()
    const prompt = await sendPrompt(cli)
    vi.useFakeTimers()
    cli.send({ id: prompt.id, result })
    await expect(run.done).resolves.toMatchObject({ ok: true })
    expect(vi.getTimerCount()).toBe(1)
    expect(agyAcpPool.retireOnCliUpdate()).toEqual({ retired: 1, deferred: 0 })
    expect(cli.process.terminate).toHaveBeenCalledExactlyOnceWith(false)
    expect(vi.getTimerCount()).toBe(0)
    vi.useRealTimers()
    const next = await begin()
    expect(next.cli).not.toBe(cli)
    const nextPrompt = await sendPrompt(next.cli)
    next.cli.send({ id: nextPrompt.id, result })
    await expect(next.run.done).resolves.toMatchObject({ ok: true })
  })

  it.each(['success', 'error', 'abort'] as const)('retires busy ACP only after %s and starts new requests on a fresh connection', async (outcome) => {
    const { run, cli } = await begin()
    const prompt = await sendPrompt(cli)
    expect(agyAcpPool.retireOnCliUpdate()).toEqual({ retired: 0, deferred: 1 })
    expect(agyAcpPool.retireOnCliUpdate()).toEqual({ retired: 0, deferred: 1 })
    expect(agyAcpPool.hasActive(id)).toBe(true)
    const next = await begin()
    const nextPrompt = await sendPrompt(next.cli)
    expect(next.cli).not.toBe(cli)
    expect(cli.process.terminate).not.toHaveBeenCalled()
    next.cli.send({ id: nextPrompt.id, result })
    await expect(next.run.done).resolves.toMatchObject({ ok: true })
    expect(agyAcpPool.hasActive()).toBe(true)
    expect(cli.process.terminate).not.toHaveBeenCalled()

    if (outcome === 'abort') {
      run.kill()
      await cli.request('session/cancel')
      expect(cli.process.terminate).not.toHaveBeenCalled()
      cli.send({ id: prompt.id, result: { stopReason: 'cancelled' } })
      await expect(run.done).resolves.toMatchObject({ ok: false, stopped: true })
    } else if (outcome === 'error') {
      cli.send({ id: prompt.id, error: { code: -32603, message: 'prompt failed' } })
      await expect(run.done).resolves.toMatchObject({ ok: false, error: expect.stringContaining('prompt failed') })
    } else {
      cli.send(cli.update(text('still running')), { id: prompt.id, result })
      await expect(run.done).resolves.toMatchObject({ ok: true })
    }
    expect(agyAcpPool.hasActive(id)).toBe(false)
    expect(cli.process.terminate).toHaveBeenCalledExactlyOnceWith(false)
    expect(next.cli.process.terminate).not.toHaveBeenCalled()
  })

  it('removes a retired startup that fails without counting it against the replacement', async () => {
    let rejectStart!: (error: Error) => void
    vi.mocked(startAcpProcess).mockImplementationOnce(() => new Promise((_, reject) => { rejectStart = reject }))
    const starting = agyAcpPool.acquire(id, log)
    await vi.waitFor(() => expect(startAcpProcess).toHaveBeenCalled())
    expect(agyAcpPool.retireOnCliUpdate()).toEqual({ retired: 0, deferred: 1 })
    const replacement = await agyAcpPool.acquire(id, log)
    // Two fresh failures and the old failure must never disable the account.
    agyAcpPool.retire(id, replacement.connection)
    vi.mocked(startAcpProcess).mockRejectedValueOnce(new Error('new startup failed')).mockRejectedValueOnce(new Error('new startup failed'))
    for (let i = 0; i < 2; i++) await expect(agyAcpPool.acquire(id, log)).rejects.toThrow('new startup failed')
    rejectStart(new Error('old startup failed'))
    await expect(starting).rejects.toThrow('old startup failed')
    expect(agyAcpPool.disabled(id)).toBe(false)
    expect(agyAcpPool.hasActive()).toBe(false)
  })

  it('retires both generations on account removal', async () => {
    const old = await agyAcpPool.acquire(id, log)
    agyAcpPool.retireOnCliUpdate()
    const current = await agyAcpPool.acquire(id, log)
    agyAcpPool.retire(id, undefined, true)
    expect(old.connection.process.terminate).toHaveBeenCalledExactlyOnceWith(true)
    expect(current.connection.process.terminate).toHaveBeenCalledExactlyOnceWith(true)
    expect(agyAcpPool.hasActive()).toBe(false)
    old.release()
    current.release()
  })

  it('defers idle cleanup while a background command is still running', async () => {
    const { run, cli } = await begin()
    const prompt = await sendPrompt(cli)
    vi.useFakeTimers()
    cli.send(cli.update({ ...call('in_progress'), kind: 'execute' }), { id: prompt.id, result })
    await run.done
    await vi.advanceTimersByTimeAsync(IDLE_MS)
    expect(cli.process.terminate).not.toHaveBeenCalled()
    cli.send(cli.update(call('completed')))
    await vi.advanceTimersByTimeAsync(IDLE_MS)
    expect(cli.process.terminate).toHaveBeenCalledTimes(1)
  })

  it('shuts down both generations and refuses new acquisitions', async () => {
    vi.resetModules()
    const { agyAcpPool: pool } = await import('./pool')
    const old = await pool.acquire(id, log)
    pool.retireOnCliUpdate()
    const current = await pool.acquire(id, log)
    pool.shutdownAll()
    expect(old.connection.process.terminate).toHaveBeenCalledExactlyOnceWith(false)
    expect(current.connection.process.terminate).toHaveBeenCalledExactlyOnceWith(false)
    expect(pool.hasActive()).toBe(false)
    await expect(pool.acquire(id, log)).rejects.toThrow('shutting down')
    old.release()
    current.release()
  })
})

describe('agy automatic permission decisions', () => {
  const project = mkdtempSync(join(tmpdir(), 'agy-perm-'))
  it.each(['cli', 'edits'] as const)('allows only the mounted history MCP as an exception in %s mode', (level) => {
    for (const tool of [
      { name: 'read_thread' },
      { name: 'agentswitch__search_thread' },
      { name: 'mcp__agentswitch__read_thread' },
      { name: 'agentswitch/read_thread' },
      { title: 'Run mcp_agentswitch_search_thread?' },
      { title: 'Read history', rawInput: { ServerName: 'agentswitch', ToolName: 'search_thread' } }
    ]) {
      const req = { toolCall: { kind: 'other', toolCallId: 'call', ...tool } }
      expect(autoDecision(req, level, project, true)).toBe('allow')
      expect(autoDecision(req, level, project)).toBe('ask')
    }
    for (const tool of [
      { name: 'other__read_thread' },
      { name: 'evil:read_thread' },
      { name: 'read_thread_extra' },
      { title: 'Run mcp_other_read_thread?' },
      { name: 'read_thread', title: 'Run mcp_other_read_thread?' },
      { name: 'read_thread', rawInput: { ServerName: 'other', ToolName: 'read_thread' } },
      { name: 'read_thread', kind: 'delete' },
      { name: 'read_thread', rawInput: { CommandLine: 'echo unrelated' } },
      { name: 'read_thread', toolCallId: 'interaction_1' }
    ]) expect(autoDecision({ toolCall: { kind: 'other', ...tool } }, level, project, true)).toBe('ask')
    expect(autoDecision({ toolCall: { toolCallId: 'interaction_1', name: 'read_thread' } }, 'full', project, true)).toBe('ask')
  })
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
