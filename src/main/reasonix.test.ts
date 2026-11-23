import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { hasSubscriptionQuota, ptyModeAllowed, stripCredentials } from './apiKey'
import { envHasValue, keyEnvName, parseReasonixConfig, removeReasonixKey, renderConfigToml, writeEnvFile } from './reasonix'

const config = `
config_version = 12
default_model = "deepseek"
[[providers]]
name = "deepseek"
kind = "anthropic"
base_url = "https://api.deepseek.com/anthropic"
models = ["deepseek-flash", "deepseek-v4-pro"]
default = "deepseek-flash"
api_key_env = "DEEPSEEK_API_KEY"
prices = { "deepseek-flash" = { cache_hit = 0.003, input = 0.15, output = 0.6, currency = "$" } }
model_overrides = { "deepseek-flash" = { supported_efforts = ["disabled", "low", "high", "max"], default_effort = "low", vision = true } }
[[providers]]
name = "custom"
models = ["custom-model"]
default = "custom-model"
api_key_env = "CUSTOM_KEY"
`

describe('Reasonix config', () => {
  it('projects the provider, model aliases and per-model effort settings', () => {
    const cfg = parseReasonixConfig(config)
    expect(cfg?.defaultModel).toBe('deepseek')
    expect(cfg?.providers[0]).toEqual({
      name: 'deepseek',
      models: ['deepseek-flash', 'deepseek-v4-pro'],
      default: 'deepseek-flash',
      apiKeyEnv: 'DEEPSEEK_API_KEY',
      efforts: { 'deepseek-flash': { supported: ['disabled', 'low', 'high', 'max'], default: 'low' } }
    })
    expect(keyEnvName(cfg)).toBe('DEEPSEEK_API_KEY')
    expect(keyEnvName(parseReasonixConfig(config.replace('"deepseek"', '"custom-model"')))).toBe('CUSTOM_KEY')
    expect(keyEnvName(parseReasonixConfig(config.replace('"deepseek"', '"unknown"')))).toBeNull()
  })

  it('returns null for invalid TOML and malformed target fields', () => {
    expect(parseReasonixConfig('default_model = [')).toBeNull()
    expect(parseReasonixConfig(config.replace('models = ["custom-model"]', 'models = 2'))).toBeNull()
  })

  it('round-trips the managed preset and retains the requested account default', () => {
    const text = renderConfigToml({ defaultModel: 'deepseek-v4-pro', language: 'zh-CN' })
    expect(text).toContain('language = "zh-CN"')
    const cfg = parseReasonixConfig(text)
    expect(cfg?.defaultModel).toBe('deepseek-v4-pro')
    expect(keyEnvName(cfg)).toBe('DEEPSEEK_API_KEY')
    expect(cfg?.providers[0]?.efforts['deepseek-v4-pro']).toEqual({ supported: ['disabled', 'high', 'max'], default: 'high' })
  })

  it.each([
    ['KEY=value', true],
    ['export KEY="value # quoted"', true],
    ["KEY='value'", true],
    ['KEY= # only comment', false],
    ['KEY="" # empty', false],
    ['# KEY=value', false],
    ['OTHER_KEY=value', false]
  ])('checks dotenv presence for %j', (text, expected) => {
    expect(envHasValue(text, 'KEY')).toBe(expected)
  })
})

describe('Reasonix key files', () => {
  let root: string
  let profiles: string
  let dir: string
  let importedDir: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'agentswitch-rnx-test-'))
    profiles = join(root, 'profiles')
    dir = join(profiles, 'reasonix-one')
    importedDir = join(root, '.reasonix')
    mkdirSync(dir, { recursive: true })
    mkdirSync(importedDir)
  })

  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it('replaces the old key with a private file', () => {
    writeEnvFile(dir, 'KEY', 'fixture-old-key', profiles)
    writeEnvFile(dir, 'KEY', 'fixture-new-key', profiles)
    expect(statSync(join(dir, '.env')).mode & 0o777).toBe(0o600)
    expect(readFileSync(join(dir, '.env'), 'utf8')).toBe('KEY=fixture-new-key\n')
  })

  it('rejects newline injection and paths outside the managed root', () => {
    expect(() => writeEnvFile(dir, 'KEY', 'first\nOTHER=second', profiles)).toThrow()
    expect(() => writeEnvFile(importedDir, 'KEY', 'fixture-key', profiles)).toThrow()
    const link = join(profiles, 'escaped')
    symlinkSync(importedDir, link)
    expect(() => writeEnvFile(link, 'KEY', 'fixture-key', profiles)).toThrow()
  })

  it('removes only a managed account key at its own path', () => {
    const keyPath = join(dir, '.env')
    const importedKey = join(importedDir, '.env')
    writeEnvFile(dir, 'KEY', 'fixture-key', profiles)
    writeFileSync(importedKey, 'KEY=fixture-imported\n')
    writeFileSync(join(dir, 'config.toml'), config)
    removeReasonixKey({ dir, profilesRoot: profiles, accountId: 'reasonix-one', importedDir, imported: true })
    removeReasonixKey({ dir: importedDir, profilesRoot: profiles, accountId: 'reasonix-one', importedDir, imported: false })
    expect(statSync(keyPath).isFile()).toBe(true)
    expect(statSync(importedKey).isFile()).toBe(true)
    removeReasonixKey({ dir, profilesRoot: profiles, accountId: 'reasonix-one', importedDir, imported: false })
    expect(() => statSync(keyPath)).toThrow()
    expect(statSync(join(dir, 'config.toml')).isFile()).toBe(true)
  })
})

it('Reasonix credentials are removed from inherited env and do not use OAuth or subscription quota', () => {
  const cfg = { kind: 'reasonix' as const }
  expect(stripCredentials(cfg.kind, { DEEPSEEK_API_KEY: 'fixture-key', PATH: '/bin' })).toEqual({ PATH: '/bin' })
  expect(hasSubscriptionQuota(cfg)).toBe(false)
  expect(ptyModeAllowed(cfg, 'login')).toBe(false)
  expect(ptyModeAllowed(cfg, 'shell')).toBe(true)
})
