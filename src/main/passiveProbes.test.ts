import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProfileConfig } from '@shared/types'

const userData = mkdtempSync(join(tmpdir(), 'agentswitch-passive-probes-'))

const execFileMock = vi.fn()
const buildSpawnSpecMock = vi.fn(() => ({ shell: '/bin/zsh', args: [], env: { PATH: '/usr/bin' }, cwd: tmpdir(), injected: {} }))
const isLoggedInMock = vi.fn(() => true)
const getConfigMock = vi.fn<() => ProfileConfig>()

vi.mock('electron', () => ({
  app: { getPath: () => userData },
  net: { fetch: vi.fn() }
}))

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, execFile: execFileMock }
})

vi.mock('./profiles', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./profiles')>()
  return {
    ...actual,
    buildSpawnSpec: buildSpawnSpecMock,
    getConfig: getConfigMock,
    isLoggedIn: isLoggedInMock,
    kindBinaryPath: () => '/fake/cli'
  }
})

const { codexModelArgs, forgetModels, listModels } = await import('./models')
const { claudeAdapter } = await import('./agentRunner')
const { AGY_AUTH_PROMPT_RE, CODEX_APP_SERVER_PROBE_ARGS } = await import('./usage')

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

  it('does not spawn agy on manual refresh when account is not logged in', async () => {
    getConfigMock.mockReturnValue(makeProfile('gemini', 'gemini-test'))
    isLoggedInMock.mockReturnValue(false)
    const result = await listModels('gemini-test', true)
    expect(result.source).toBe('static')
    expect(execFileMock).not.toHaveBeenCalled()
  })

  it('uses prepare=false and non-interactive env on manual agy refresh', async () => {
    getConfigMock.mockReturnValue(makeProfile('gemini', 'gemini-test'))
    execFileMock.mockImplementation((_bin, _args, _opts, cb) => {
      cb(null, 'gemini-4-neon-medium\tGemini 4 Neon (Medium)\n', '')
      return { stdin: { end: vi.fn() } }
    })

    const result = await listModels('gemini-test', true)
    expect(result.source).toBe('command')
    expect(buildSpawnSpecMock).toHaveBeenCalledWith('gemini-test', 'run', undefined, false)
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
