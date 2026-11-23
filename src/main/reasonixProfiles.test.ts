import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentEvent, ProfileConfig } from '@shared/types'
import { addReasonixProfile, buildSpawnSpec, getConfig, initProfiles, isLoggedIn, listConfigs,
  loginSignature, reasonixCanImport, removeProfile, setReasonixKey, updateKindConfig, updateProfile } from './profiles'
import { runAgent } from './agentRunner'
import { listModels } from './models'
import { renderConfigToml } from './reasonix'

const state = vi.hoisted(() => ({ data: '', home: '', profiles: [] as ProfileConfig[], save: vi.fn(), setSecret: vi.fn(), removeSecret: vi.fn() }))
vi.mock('electron', () => ({ app: { getPath: () => state.data }, safeStorage: {} }))
vi.mock('./shellEnv', () => ({
  get realHome() { return state.home },
  getBaseEnv: () => ({ PATH: '/bin', DEEPSEEK_API_KEY: 'fixture-inherited' }),
  findOnPath: vi.fn(),
  strippedVarNames: () => []
}))
vi.mock('./store', () => ({
  loadStore: () => ({ version: 2, profiles: [...state.profiles], kinds: {}, migrations: ['agy-import', 'claude-auth-login'] }),
  saveStore: state.save
}))
vi.mock('./secrets', () => ({ secrets: () => ({ set: state.setSecret, remove: state.removeSecret }) }))

const managed = { reasonix: 'managed', defaultModel: 'deepseek-v4-pro', key: 'fixture-key-one' } as const
let root: string
let importedDir: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'agentswitch-rnx-profiles-'))
  state.data = join(root, 'data')
  state.home = join(root, 'login-home')
  state.profiles = []
  state.save.mockReset()
  state.setSecret.mockClear()
  state.removeSecret.mockClear()
  mkdirSync(state.data)
  mkdirSync(state.home)
  importedDir = join(state.home, '.reasonix')
  initProfiles()
})

afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('Reasonix account lifecycle', () => {
  it('imports once, preserves the existing files and never offers app-side key changes', () => {
    expect(reasonixCanImport()).toBe(false)
    expect(() => addReasonixProfile(undefined, { reasonix: 'import' })).toThrow()
    mkdirSync(importedDir)
    const text = renderConfigToml({ defaultModel: 'deepseek-flash', language: 'en' })
    writeFileSync(join(importedDir, 'config.toml'), text)
    writeFileSync(join(importedDir, '.env'), 'DEEPSEEK_API_KEY=fixture-imported')
    expect(reasonixCanImport()).toBe(true)
    const profile = addReasonixProfile('Existing', { reasonix: 'import' })
    expect(profile).toMatchObject({ configDir: '~/.reasonix', imported: true })
    expect(buildSpawnSpec(profile.id, 'run', undefined, false).env.REASONIX_HOME).toBe(importedDir)
    expect(() => addReasonixProfile(undefined, { reasonix: 'import' })).toThrow()
    expect(() => setReasonixKey(profile, 'fixture-no-write')).toThrow()
    removeProfile(profile.id)
    expect(readFileSync(join(importedDir, 'config.toml'), 'utf8')).toBe(text)
    expect(readFileSync(join(importedDir, '.env'), 'utf8')).toBe('DEEPSEEK_API_KEY=fixture-imported')
    expect(state.removeSecret).not.toHaveBeenCalled()
  })

  it('creates, rotates and deletes the managed credential without storing a second copy', () => {
    const profile = addReasonixProfile('Managed', managed)
    const envFile = join(profile.configDir, '.env')
    expect(statSync(profile.configDir).mode & 0o777).toBe(0o700)
    expect(statSync(envFile).mode & 0o777).toBe(0o600)
    expect(isLoggedIn(profile.id)).toBe(true)
    expect(readFileSync(envFile, 'utf8')).toContain('fixture-key-one')
    const first = loginSignature(profile.id)
    setReasonixKey(profile, 'fixture-rotated-key')
    expect(loginSignature(profile.id)).not.toBe(first)
    expect(readFileSync(envFile, 'utf8')).toBe('DEEPSEEK_API_KEY=fixture-rotated-key\n')
    const saved = updateProfile(profile.id, { configDir: '/elsewhere', extraEnv: { DEEPSEEK_API_KEY: managed.key, REASONIX_HOME: '/elsewhere', HTTP_PROXY: 'local' } })
    expect(saved.configDir).toBe(profile.configDir)
    expect(saved.extraEnv).toEqual({ HTTP_PROXY: 'local' })
    expect(JSON.stringify(state.save.mock.calls)).not.toContain(managed.key)
    expect(state.setSecret).not.toHaveBeenCalled()
    removeProfile(profile.id)
    expect(() => statSync(envFile)).toThrow()
    expect(statSync(join(profile.configDir, 'config.toml')).isFile()).toBe(true)
    expect(state.removeSecret).not.toHaveBeenCalled()
  })

  it('rolls back the account and directory when config persistence fails', () => {
    state.save.mockImplementationOnce(() => { throw new Error('fixture failure') })
    expect(() => addReasonixProfile('Managed', managed)).toThrow()
    expect(listConfigs()).toEqual([])
    expect(readdirSync(join(state.data, 'profiles'))).toEqual([])
  })

  it('preserves .env when a stored path or symlink escapes that account directory', () => {
    mkdirSync(importedDir)
    const external = join(root, 'external')
    mkdirSync(external)
    const file = join(external, '.env')
    writeFileSync(file, 'DEEPSEEK_API_KEY=fixture-do-not-remove')
    const profile = addReasonixProfile('Managed', managed)
    const other = addReasonixProfile('Other', managed)
    rmSync(profile.configDir, { recursive: true })
    symlinkSync(other.configDir, profile.configDir)
    removeProfile(profile.id)
    expect(isLoggedIn(other.id)).toBe(true)
    state.profiles = [{ ...profile, id: '../../external', configDir: external }]
    initProfiles()
    removeProfile('../../external')
    expect(statSync(file).isFile()).toBe(true)
  })

  it('redacts a quoted credential from a CLI event, stderr fallback and debug output', async () => {
    const key = 'fixture-key " quoted'
    const profile = addReasonixProfile('Managed', { ...managed, key })
    const binary = join(root, 'reasonix-fixture')
    const payload = JSON.stringify({ kind: 'text', text: key })
    writeFileSync(binary, `#!/bin/sh
/bin/cat >/dev/null
printf '%s\\n' '${payload}'
printf '%s\\n' 'provider error: ${key}' >&2
exit 1
`, { mode: 0o700 })
    updateKindConfig('reasonix', { binary })
    const events: AgentEvent[] = []
    const logs: string[] = []
    const result = await runAgent(
      { cfg: profile, cwd: root, outDir: root, prompt: 'Fixture.', system: null, images: [], model: null, resume: null },
      (event) => events.push(event),
      (line) => logs.push(line)
    ).done
    expect(events).toContainEqual({ t: 'text', delta: '[redacted]' })
    expect(result.error).toBe('provider error: [redacted]')
    expect(JSON.stringify(logs)).not.toContain(key)
  })

  it('lists local models, resolves the provider default and falls back after invalid TOML', async () => {
    const profile = addReasonixProfile('Managed', managed)
    const file = join(profile.configDir, 'config.toml')
    writeFileSync(file, renderConfigToml({ defaultModel: 'deepseek-flash', language: 'en' }).replace('default_model = "deepseek-flash"', 'default_model = "deepseek"'))
    await expect(listModels(profile.id)).resolves.toMatchObject({
      source: 'catalog', defaultModel: 'deepseek-flash',
      models: [{ id: 'deepseek-flash', efforts: ['disabled', 'low', 'high', 'max'], defaultEffort: 'low' }, { id: 'deepseek-v4-pro' }]
    })
    writeFileSync(file, 'invalid TOML')
    await expect(listModels(profile.id)).resolves.toMatchObject({
      source: 'static', models: [{ id: 'deepseek-flash' }, { id: 'deepseek-v4-pro' }]
    })
    expect(isLoggedIn(getConfig(profile.id).id)).toBe(false)
  })
})
