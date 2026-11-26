import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProfileConfig } from '@shared/types'

const root = mkdtempSync(join(tmpdir(), 'agentswitch-profile-isolation-'))
const home = join(root, 'home')
const userData = join(root, 'data')
const retire = vi.fn()
const execFileMock = vi.fn()

vi.mock('electron', () => ({ app: { getPath: () => userData } }))
vi.mock('./shellEnv', async (original) => ({
  ...await original<typeof import('./shellEnv')>(),
  realHome: home,
  getBaseEnv: () => ({ HOME: home, PATH: `${join(root, 'bin')}:/usr/bin` })
}))
vi.mock('./secrets', () => ({ secrets: () => ({ remove: vi.fn() }) }))
vi.mock('./acp/pool', () => ({ agyAcpPool: { retire: (...args: unknown[]) => retire(...args) } }))
vi.mock('node:child_process', async (original) => ({
  ...await original<typeof import('node:child_process')>(),
  execFile: execFileMock,
  spawnSync: vi.fn(() => ({ status: 44 }))
}))

const profiles = await import('./profiles')

function fixture(kind: ProfileConfig['kind'], configDir: string, overrides: Partial<ProfileConfig> = {}): ProfileConfig {
  return {
    id: kind + '-test', name: kind, kind, configDir, imported: false, extraEnv: {},
    loginCommand: kind, runCommand: kind, defaultModel: '', autoApprove: 'edits', createdAt: 0, ...overrides
  }
}

function put(path: string, data = 'fixture'): string {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, data)
  return path
}

function init(...accounts: ProfileConfig[]) {
  put(join(userData, 'config.json'), JSON.stringify({
    version: 2, profiles: accounts, kinds: {}, migrations: ['agy-import', 'claude-auth-login'], firstRunDone: true
  }))
  profiles.initProfiles()
}

beforeEach(() => {
  rmSync(root, { recursive: true, force: true })
  mkdirSync(home, { recursive: true })
  retire.mockClear()
  execFileMock.mockReset()
  profiles.invalidateCliVersionCache()
})

afterAll(() => rmSync(root, { recursive: true, force: true }))

describe('CLI version cache', () => {
  function configureClaude(name: string) {
    const binary = put(join(root, 'bin', name))
    chmodSync(binary, 0o700)
    profiles.updateKindConfig('claude', { binary })
    return binary
  }

  it('deduplicates probes, honors TTL, and supports force refresh', async () => {
    init()
    const binary = configureClaude('claude')
    let version = '1.0.0'
    execFileMock.mockImplementation((_bin, _args, _opts, cb) => {
      cb(null, `Claude Code ${version}\n`)
      return {}
    })
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      const first = profiles.cliVersion('claude')
      expect(profiles.cliVersion('claude')).toBe(first)
      await expect(first).resolves.toBe('1.0.0')
      expect(execFileMock).toHaveBeenCalledExactlyOnceWith(binary, ['--version'], expect.anything(), expect.any(Function))

      version = '2.0.0'
      vi.setSystemTime(Date.now() + 5 * 60_000 - 1)
      await expect(profiles.cliVersion('claude')).resolves.toBe('1.0.0')
      vi.setSystemTime(Date.now() + 1)
      await expect(profiles.cliVersion('claude')).resolves.toBe('2.0.0')

      version = '3.0.0'
      await expect(profiles.cliVersion('claude', true)).resolves.toBe('3.0.0')
      await expect(profiles.cliVersion('claude')).resolves.toBe('3.0.0')
      expect(execFileMock).toHaveBeenCalledTimes(3)
    } finally {
      vi.useRealTimers()
    }
  })

  it('prevents invalidated probes from restoring a stale version at the same path', async () => {
    init()
    configureClaude('claude')
    const replies: ((err: null, stdout: string) => void)[] = []
    execFileMock.mockImplementation((_bin, _args, _opts, cb) => {
      replies.push(cb)
      return {}
    })
    const old = profiles.cliVersion('claude')
    profiles.invalidateCliVersionCache('claude')
    const current = profiles.cliVersion('claude')
    replies[1](null, '2.0.0')
    await expect(current).resolves.toBe('2.0.0')
    replies[0](null, '1.0.0')
    await expect(old).resolves.toBe('1.0.0')
    await expect(profiles.cliVersion('claude')).resolves.toBe('2.0.0')

    // A forced refresh also bypasses an in-flight non-force probe at the same path.
    profiles.invalidateCliVersionCache('claude')
    const stale = profiles.cliVersion('claude')
    const forced = profiles.cliVersion('claude', true)
    expect(forced).not.toBe(stale)
    replies[3](null, '3.0.0')
    await expect(forced).resolves.toBe('3.0.0')
    replies[2](null, '2.5.0')
    await expect(stale).resolves.toBe('2.5.0')
    await expect(profiles.cliVersion('claude')).resolves.toBe('3.0.0')
    expect(execFileMock).toHaveBeenCalledTimes(4)
  })

  it('invalidates cached probes when switching or resetting the configured binary', async () => {
    init()
    const binary = configureClaude('claude')
    let version = '1.0.0'
    execFileMock.mockImplementation((_bin, _args, _opts, cb) => {
      cb(null, version)
      return {}
    })
    await expect(profiles.cliVersion('claude')).resolves.toBe('1.0.0')
    profiles.updateKindConfig('claude', { binary: 'claude' })
    version = '2.0.0'
    await expect(profiles.cliVersion('claude')).resolves.toBe('2.0.0')
    profiles.updateKindConfig('claude', { binary })
    await expect(profiles.cliVersion('claude')).resolves.toBe('2.0.0')
    profiles.resetKindConfig('claude')
    version = '3.0.0'
    await expect(profiles.cliVersion('claude')).resolves.toBe('3.0.0')
    expect(execFileMock.mock.calls.map(([path]) => path)).toEqual(Array(4).fill(binary))
  })
})

describe('OAuth profile directory boundaries', () => {
  it('uses the same normalized directory for login, run, detection and session storage', () => {
    const dir = profiles.managedProfileRoot('codex-test')
    const cfg = fixture('codex', '/unused', { extraEnv: { CODEX_HOME: dir } })
    put(join(dir, 'auth.json'), '{}')
    init(cfg)
    expect(profiles.resolveProfileDir(cfg)).toBe(dir)
    expect(profiles.isManagedProfileDir(cfg)).toBe(true)
    expect(profiles.isLoggedIn(cfg.id)).toBe(true)
    expect(profiles.getState(cfg, '/cli', null, false, false)).toMatchObject({ isManagedDir: true, isGlobalDir: false })
    expect(profiles.sessionStoreKeyOf(cfg)).toContain(join(dir, 'sessions'))
    for (const mode of ['login', 'run'] as const) expect(profiles.buildSpawnSpec(cfg.id, mode).env.CODEX_HOME).toBe(dir)
    expect(profiles.resolveProfileDir(fixture('claude', '~'))).toBe(join(home, '.claude'))
  })

  it('rejects imported, sibling, traversal and symlink escapes, including missing children', () => {
    const own = profiles.managedProfileRoot('gemini-test')
    const global = join(home, '.gemini')
    mkdirSync(global, { recursive: true })
    mkdirSync(own, { recursive: true })
    const link = join(own, 'link')
    symlinkSync(global, link)
    expect(profiles.isGlobalDefaultDir(fixture('gemini', link))).toBe(true)
    for (const dir of [global, join(link, 'absent'), own + '-other']) {
      expect(profiles.isManagedProfileDir(fixture('gemini', dir))).toBe(false)
    }
    expect(profiles.isManagedProfileDir(fixture('gemini', own, { imported: true }))).toBe(false)
    expect(profiles.isManagedProfileDir(fixture('gemini', own, { id: '../' }))).toBe(false)
    rmSync(own, { recursive: true })
    symlinkSync(global, own)
    expect(profiles.deleteManagedProfileDir(fixture('gemini', own))).toBe(false)
    expect(existsSync(global)).toBe(true)
  })

  it('deletes the full Gemini root after retiring ACP and keeps global login files', () => {
    const own = join(profiles.managedProfileRoot('gemini-test'), 'home')
    const cfg = fixture('gemini', own)
    const token = put(join(own, '.gemini', 'oauth_tokens.json'))
    put(join(own, 'Library', 'Keychains', 'agentswitch.keychain-db'))
    put(join(own, 'Library', 'Keychains', '.passphrase'))
    const external = put(join(home, '.gemini', 'oauth_tokens.json'))
    init(cfg)
    retire.mockImplementationOnce(() => expect(existsSync(token)).toBe(true))
    profiles.removeProfile(cfg.id)
    expect(retire).toHaveBeenCalledWith(cfg.id)
    expect(existsSync(profiles.managedProfileRoot(cfg.id))).toBe(false)
    expect(profiles.hasProfile(cfg.id)).toBe(false)
    expect(readFileSync(external, 'utf8')).toBe('fixture')
  })

  it('clears managed OAuth credentials for reauthorization and keeps unrelated settings', () => {
    const claude = fixture('claude', profiles.managedProfileRoot('claude-test'))
    const codex = fixture('codex', profiles.managedProfileRoot('codex-test'))
    const gemini = fixture('gemini', join(profiles.managedProfileRoot('gemini-test'), 'home'))
    const credentials = [
      put(join(claude.configDir, '.credentials.json')),
      put(join(codex.configDir, 'auth.json')),
      put(join(gemini.configDir, '.gemini', 'antigravity-cli', 'jetski_state.pbtxt')),
      put(join(gemini.configDir, '.gemini', 'oauth_tokens.json')),
      put(join(gemini.configDir, 'Library', 'Keychains', 'agentswitch.keychain-db'))
    ]
    const claudeJson = put(join(claude.configDir, '.claude.json'), JSON.stringify({ oauthAccount: { id: 'old' }, other: true }))
    const globalJson = put(join(home, '.claude', '.credentials.json'))
    for (const cfg of [claude, codex, gemini]) profiles.clearIsolatedCredentials(cfg)
    expect(credentials.map(existsSync)).toEqual(credentials.map(() => false))
    expect(JSON.parse(readFileSync(claudeJson, 'utf8'))).toEqual({ other: true })

    const globalClaude = fixture('claude', '~/.claude')
    init(globalClaude)
    profiles.clearIsolatedCredentials(globalClaude)
    profiles.removeProfile(globalClaude.id)
    expect(readFileSync(globalJson, 'utf8')).toBe('fixture')
    expect(profiles.hasProfile(globalClaude.id)).toBe(false)
  })

  it('ignores Gemini activity files in the login fingerprint', () => {
    const cfg = fixture('gemini', join(profiles.managedProfileRoot('gemini-test'), 'home'))
    init(cfg)
    const before = profiles.loginSignature(cfg.id)
    put(join(cfg.configDir, '.gemini', 'antigravity-cli', 'jetski_state.pbtxt'))
    expect(profiles.loginSignature(cfg.id)).toBe(before)
    put(join(cfg.configDir, '.gemini', 'oauth_tokens.json'))
    expect(profiles.loginSignature(cfg.id)).not.toBe(before)
  })
})
