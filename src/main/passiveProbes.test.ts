import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProfileConfig } from '@shared/types'

const userData = mkdtempSync(join(tmpdir(), 'agentswitch-passive-probes-'))

const execFileMock = vi.fn()
const spawnMock = vi.fn()
const buildSpawnSpecMock = vi.fn(() => ({ shell: '/bin/zsh', args: [], env: { PATH: '/usr/bin' }, cwd: tmpdir(), injected: {} }))
const isLoggedInMock = vi.fn(() => true)
const getConfigMock = vi.fn<(id: string) => ProfileConfig>()
const listConfigsMock = vi.fn<() => ProfileConfig[]>(() => [])

vi.mock('electron', () => ({
  app: { getPath: () => userData },
  net: { fetch: vi.fn() }
}))

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, execFile: execFileMock, spawn: spawnMock }
})

vi.mock('node:fs', async (original) => {
  const actual = await original<typeof import('node:fs')>()
  return { ...actual, mkdtempSync: vi.fn(actual.mkdtempSync) }
})

vi.mock('node:http', async (original) => {
  const actual = await original<typeof import('node:http')>()
  return { ...actual, createServer: vi.fn(actual.createServer) }
})

vi.mock('./profiles', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./profiles')>()
  return {
    ...actual,
    buildSpawnSpec: buildSpawnSpecMock,
    getConfig: getConfigMock,
    hasProfile: () => true,
    isLoggedIn: isLoggedInMock,
    listConfigs: listConfigsMock,
    kindBinaryPath: () => '/fake/cli'
  }
})

const { codexModelArgs, forgetModels, forgetModelsByKind, getEffectiveDefaultModel, listModels, refreshModelsByKind } = await import('./models')
const { claudeAdapter } = await import('./agentRunner')
const { AGY_AUTH_PROMPT_RE, CODEX_APP_SERVER_PROBE_ARGS, refreshAgyQuota, startUsage } = await import('./usage')

const makeProfile = (kind: ProfileConfig['kind'], id = `${kind}-test`): ProfileConfig => ({
  id,
  name: `${kind} Test`,
  kind,
  configDir: join(userData, id),
  imported: false,
  loginCommand: kind,
  runCommand: kind,
  extraEnv: {},
  defaultModel: '',
  autoApprove: 'cli',
  createdAt: 0
})

describe('P1-3 passive health & model probes', () => {
  beforeEach(() => {
    execFileMock.mockReset()
    spawnMock.mockReset()
    listConfigsMock.mockReset().mockReturnValue([])
    buildSpawnSpecMock.mockClear()
    isLoggedInMock.mockReset().mockReturnValue(true)
    forgetModels('gemini-test')
    forgetModels('codex-test')
  })

  afterAll(() => {
    rmSync(userData, { recursive: true, force: true })
  })

  it('never spawns agy during passive listModels(id, false)', async () => {
    getConfigMock.mockReturnValue(makeProfile('gemini', 'gemini-test'))
    const result = await listModels('gemini-test', false)
    expect(result.source).toBe('static')
    expect(result.models.length).toBeGreaterThan(0)
    expect(execFileMock).not.toHaveBeenCalled()
    expect(buildSpawnSpecMock).not.toHaveBeenCalled()
  })

  it('keeps history snapshots and HTTP listeners out of startup, passive model listing, and agy quota checks', async () => {
    const config = { ...makeProfile('gemini'), agyTransport: 'acp' as const }
    getConfigMock.mockReturnValue(config)
    listConfigsMock.mockReturnValue([config])
    vi.useFakeTimers()
    try {
      startUsage()
      await vi.advanceTimersByTimeAsync(4000)
      expect(spawnMock).not.toHaveBeenCalled()
    } finally {
      vi.clearAllTimers()
      vi.useRealTimers()
    }

    await listModels(config.id, false)
    expect(execFileMock).not.toHaveBeenCalled()
    spawnMock.mockImplementationOnce(() => {
      const child = Object.assign(new EventEmitter(), { kill: vi.fn() })
      queueMicrotask(() => child.emit('close', 2))
      return child
    })
    await expect(refreshAgyQuota(config.id)).resolves.toBe(false)
    expect(spawnMock).toHaveBeenCalledExactlyOnceWith('/fake/cli', expect.arrayContaining(['-p', '/usage']), expect.anything())
    expect(vi.mocked(mkdtempSync).mock.calls.some(([path]) => String(path).includes('agentswitch-acp-history-'))).toBe(false)
    expect(createServer).not.toHaveBeenCalled()
  })

  it('does not spawn agy on manual refresh when account is not logged in', async () => {
    getConfigMock.mockReturnValue(makeProfile('gemini', 'gemini-test'))
    isLoggedInMock.mockReturnValue(false)
    const result = await listModels('gemini-test', true)
    expect(result.source).toBe('static')
    expect(execFileMock).not.toHaveBeenCalled()
  })

  it('prepares isolation and uses non-interactive env on manual agy refresh', async () => {
    getConfigMock.mockReturnValue(makeProfile('gemini', 'gemini-test'))
    execFileMock.mockImplementation((_bin, _args, _opts, cb) => {
      cb(null, 'gemini-4-neon-medium\tGemini 4 Neon (Medium)\n', '')
      return { stdin: { end: vi.fn() } }
    })

    const result = await listModels('gemini-test', true)
    expect(result.source).toBe('command')
    expect(buildSpawnSpecMock).toHaveBeenCalledWith('gemini-test', 'run', undefined, true)
    expect(execFileMock).toHaveBeenCalledTimes(1)
    const [, args, opts] = execFileMock.mock.calls[0]
    expect(args).toEqual(['models'])
    expect(opts.env.AGY_CLI_DISABLE_AUTO_UPDATE).toBe('1')
    expect(opts.env.SSH_CONNECTION).toBe('1')
    expect(opts.env.SSH_TTY).toBe('1')

    // Subsequent passive load reuses the cached live list without spawning agy again.
    execFileMock.mockClear()
    const cached = await listModels('gemini-test', false)
    expect(cached.source).toBe('command')
    expect(execFileMock).not.toHaveBeenCalled()
  })

  it('forgets only the updated engine and shares its live Gemini refresh with passive callers', async () => {
    const signedIn = makeProfile('gemini')
    const signedOut = makeProfile('gemini', 'gemini-signed-out')
    const codex = makeProfile('codex')
    const configs = [signedIn, signedOut, codex]
    listConfigsMock.mockReturnValue(configs)
    getConfigMock.mockImplementation((id) => configs.find((cfg) => cfg.id === id)!)
    isLoggedInMock.mockImplementation((id?: string) => id === signedIn.id)
    mkdirSync(codex.configDir, { recursive: true })
    writeFileSync(join(codex.configDir, 'models_cache.json'), JSON.stringify({ models: [{ slug: 'codex-local', visibility: 'list' }] }))
    execFileMock.mockImplementationOnce((_bin, _args, _opts, cb) => {
      cb(null, 'gemini-old\tOld\n', '')
      return {}
    })
    expect((await listModels(signedIn.id, true)).defaultModel).toBe('gemini-old')
    expect((await listModels(codex.id)).defaultModel).toBe('codex-local')

    expect(forgetModelsByKind('gemini')).toEqual([signedIn.id, signedOut.id])
    const cached = JSON.parse(readFileSync(join(userData, 'models-cache.v2.json'), 'utf8'))
    expect(cached[signedIn.id]).toBeUndefined()
    expect(cached[codex.id]).toMatchObject({ defaultModel: 'codex-local' })
    expect(getEffectiveDefaultModel(signedIn.id)).not.toBe('gemini-old')
    expect(getEffectiveDefaultModel(codex.id)).toBe('codex-local')

    let complete!: () => void
    execFileMock.mockImplementationOnce((_bin, _args, _opts, cb) => {
      complete = () => cb(null, 'gemini-new-medium\tNew (Medium)\n', '')
      return {}
    })
    const refreshed = refreshModelsByKind('gemini')
    const passive = listModels(signedIn.id, false)
    await Promise.resolve()
    expect(execFileMock).toHaveBeenCalledTimes(2)
    complete()
    const [live, offline] = await refreshed
    expect(await passive).toBe(live)
    expect(live).toMatchObject({ profileId: signedIn.id, source: 'command', defaultModel: 'gemini-new-medium' })
    expect(offline).toMatchObject({ profileId: signedOut.id, source: 'static' })
    expect(getEffectiveDefaultModel(signedIn.id)).toBe('gemini-new-medium')
  })

  it('uses the refreshed Codex catalog for the default model even if its disk catalog is older', async () => {
    const codex = makeProfile('codex')
    listConfigsMock.mockReturnValue([codex])
    getConfigMock.mockReturnValue(codex)
    mkdirSync(codex.configDir, { recursive: true })
    writeFileSync(join(codex.configDir, 'models_cache.json'), JSON.stringify({ models: [{ slug: 'codex-old', visibility: 'list' }] }))
    expect((await listModels(codex.id)).defaultModel).toBe('codex-old')
    expect(forgetModelsByKind('codex')).toEqual([codex.id])

    execFileMock.mockImplementationOnce((_bin, _args, _opts, cb) => {
      cb(null, JSON.stringify({ models: [{ slug: 'codex-new', visibility: 'list' }] }), '')
      return {}
    })
    const refreshing = refreshModelsByKind('codex')
    const passive = listModels(codex.id, false)
    const [fresh] = await refreshing
    expect(await passive).toBe(fresh)
    expect(fresh).toMatchObject({ source: 'command', defaultModel: 'codex-new' })
    expect(getEffectiveDefaultModel(codex.id)).toBe('codex-new')
    expect(execFileMock).toHaveBeenCalledExactlyOnceWith('/fake/cli', codexModelArgs(true), expect.anything(), expect.any(Function))
  })

  it('returns successful catalog refreshes when another account fails', async () => {
    const good = makeProfile('claude')
    const bad = makeProfile('claude', 'claude-failed')
    listConfigsMock.mockReturnValue([good, bad])
    getConfigMock.mockImplementation((id) => {
      if (id === bad.id) throw new Error('account removed')
      return good
    })
    await expect(refreshModelsByKind('claude')).resolves.toEqual([
      expect.objectContaining({ profileId: good.id })
    ])
  })

  it('builds passive codex debug models flags (offline --bundled when passive, MCP/hooks/plugins/apps disabled)', () => {
    const passive = codexModelArgs(false)
    expect(passive).toContain('--bundled')
    expect(passive).toContain('plugins')
    expect(passive).toContain('hooks')
    expect(passive).toContain('apps')
    expect(passive).toContain('mcp_servers={}')

    const manual = codexModelArgs(true)
    expect(manual).not.toContain('--bundled')
    expect(manual).toContain('plugins')
    expect(manual).toContain('hooks')
    expect(manual).toContain('apps')
    expect(manual).toContain('mcp_servers={}')
  })

  it('disables plugins, hooks, apps, MCP servers, and background subsystems for codex app-server probe', () => {
    expect(CODEX_APP_SERVER_PROBE_ARGS[0]).toBe('app-server')
    expect(CODEX_APP_SERVER_PROBE_ARGS).toContain('plugins')
    expect(CODEX_APP_SERVER_PROBE_ARGS).toContain('remote_plugin')
    expect(CODEX_APP_SERVER_PROBE_ARGS).toContain('hooks')
    expect(CODEX_APP_SERVER_PROBE_ARGS).toContain('apps')
    expect(CODEX_APP_SERVER_PROBE_ARGS).toContain('mcp_servers={}')
    expect(CODEX_APP_SERVER_PROBE_ARGS).toContain('check_for_update_on_startup=false')
  })

  it('detects agy interactive auth prompts on stderr so quota probe aborts immediately', () => {
    expect(AGY_AUTH_PROMPT_RE.test('Authentication required. Please visit the URL to log in:')).toBe(true)
    expect(AGY_AUTH_PROMPT_RE.test('Waiting for authentication (timeout 60s)...')).toBe(true)
    expect(AGY_AUTH_PROMPT_RE.test('normal stderr warning')).toBe(false)
  })

  it('isolates opt-in Claude Haiku quota probe from session persistence, MCP servers, hooks, and tools', () => {
    const cfg = makeProfile('claude', 'claude-test')
    const probeAdapter = claudeAdapter({
      cfg,
      model: 'haiku',
      prompt: 'Reply with exactly: OK',
      system: null,
      cwd: tmpdir(),
      images: [],
      resume: null,
      outDir: tmpdir(),
      ephemeralProbe: true
    })
    expect(probeAdapter.args).toContain('--no-session-persistence')
    expect(probeAdapter.args).toContain('--strict-mcp-config')
    expect(probeAdapter.args).toContain('--disable-slash-commands')
    expect(probeAdapter.args).toContain('--tools')
    expect(probeAdapter.args).toContain('{"disableAllHooks":true}')

    const normalAdapter = claudeAdapter({
      cfg,
      model: 'sonnet',
      prompt: 'Hello',
      system: null,
      cwd: tmpdir(),
      images: [],
      resume: null,
      outDir: tmpdir()
    })
    expect(normalAdapter.args).not.toContain('--no-session-persistence')
    expect(normalAdapter.args).not.toContain('--strict-mcp-config')
  })
})
