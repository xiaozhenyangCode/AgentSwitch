import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ProfileConfig } from '@shared/types'
import builtin from './prices.builtin.json'
import { cleanRate, costOf, findRate, parseLiteLLM, type PriceTable } from './pricing'
import { codexTurnUsage } from './usageDelta'

const { state, mockProfiles, dirs } = vi.hoisted(() => ({
  state: { userDataDir: '/tmp/agentswitch-codex-usage-init' },
  mockProfiles: [] as ProfileConfig[],
  dirs: [] as string[]
}))

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

state.userDataDir = tempDir('agentswitch-codex-usage-userdata-')

vi.mock('electron', () => ({
  app: { getPath: () => state.userDataDir },
  net: { fetch: vi.fn() },
  safeStorage: {}
}))

vi.mock('./profiles', async (importOriginal) => {
  const orig = await importOriginal<typeof import('./profiles')>()
  return {
    ...orig,
    listConfigs: () => mockProfiles,
    hasProfile: (id: unknown): id is string => typeof id === 'string' && mockProfiles.some((p) => p.id === id),
    getConfig: (id: string) => {
      const found = mockProfiles.find((p) => p.id === id)
      if (!found) throw new Error(`unknown account: ${id}`)
      return found
    }
  }
})

import { codexAdapter, codexDefaultModel, readCodexConfig, resolveCodexFallbackModel, type RunSpec } from './agentRunner'

const tables = {
  litellm: parseLiteLLM(builtin.litellm),
  ccswitch: Object.fromEntries(Object.entries(builtin.ccswitch).map(([k, v]) => [k, cleanRate(v)!])) as PriceTable
}

function makeCodexProfile(overrides: Partial<ProfileConfig> = {}): ProfileConfig {
  return {
    id: 'codex-test',
    name: 'Codex Test',
    kind: 'codex',
    configDir: tempDir('agentswitch-codex-home-'),
    imported: false,
    loginCommand: 'codex login',
    runCommand: 'codex',
    extraEnv: {},
    defaultModel: '',
    autoApprove: 'edits',
    createdAt: 0,
    ...overrides
  }
}

function makeRunSpec(cfg: ProfileConfig, model: string | null = null): RunSpec {
  return {
    cfg,
    model,
    prompt: 'hello',
    system: null,
    cwd: tmpdir(),
    images: [],
    resume: null,
    outDir: tmpdir()
  }
}

afterEach(() => {
  mockProfiles.length = 0
  while (dirs.length > 1) {
    const dir = dirs.pop()!
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('codex model resolution and fallback chain', () => {
  it('prefers real model reported in the codex exec --json event stream', () => {
    const home = tempDir('codex-stream-')
    writeFileSync(join(home, 'config.toml'), 'model = "gpt-5-codex"\nmodel_reasoning_effort = "medium"\n')
    const cfg = makeCodexProfile({ configDir: home, defaultModel: 'gpt-5.1-codex:high' })
    const adapter = codexAdapter(makeRunSpec(cfg, null), home, 0)
    const emit = vi.fn()

    adapter.onLine({ type: 'thread.started', thread_id: 'th-1', model: 'gpt-5.3-codex' }, emit)
    expect(adapter.model()).toBe('gpt-5.3-codex:high')
    expect(emit).toHaveBeenCalledWith({ t: 'session', id: 'th-1', model: 'gpt-5.3-codex:high' })

    adapter.onLine({ type: 'turn.completed', model: 'gpt-5.4-codex', reasoning_effort: 'xhigh', usage: { input_tokens: 1000, cached_input_tokens: 400, output_tokens: 200 } }, emit)
    expect(adapter.model()).toBe('gpt-5.4-codex:xhigh')
  })

  it('falls back in order: explicit --model > account defaultModel > config.toml (profile) > engine default', () => {
    const home = tempDir('codex-fallback-')
    writeFileSync(
      join(home, 'config.toml'),
      [
        'model = "gpt-5.1-codex"',
        'model_reasoning_effort = "medium"',
        'profile = "work"',
        '',
        '[profiles.work]',
        'model = "gpt-5.3-codex"',
        'model_reasoning_effort = "high"'
      ].join('\n')
    )

    // 1. Explicit run --model wins over account defaultModel & config.toml
    expect(resolveCodexFallbackModel({ model: 'gpt-5.2-codex:low', defaultModel: 'gpt-5-codex:high', codexHome: home })).toBe('gpt-5.2-codex:low')

    // 2. Account defaultModel wins over config.toml
    expect(resolveCodexFallbackModel({ model: null, defaultModel: 'gpt-5.4:xhigh', codexHome: home })).toBe('gpt-5.4:xhigh')

    // 3. Local config.toml active profile wins over top-level and engine default
    expect(resolveCodexFallbackModel({ model: null, defaultModel: '', codexHome: home })).toBe('gpt-5.3-codex:high')

    // Top-level config.toml without profile
    const plainHome = tempDir('codex-plain-')
    writeFileSync(join(plainHome, 'config.toml'), 'model = "gpt-5.2-codex"\nmodel_reasoning_effort = "low"\n')
    expect(resolveCodexFallbackModel({ model: null, defaultModel: '', codexHome: plainHome })).toBe('gpt-5.2-codex:low')

    // 4. Missing or invalid config.toml gracefully falls back to Codex engine default
    const missingHome = join(tempDir('codex-missing-'), 'does-not-exist')
    expect(resolveCodexFallbackModel({ model: null, defaultModel: '', codexHome: missingHome })).toBe(codexDefaultModel())
    expect(resolveCodexFallbackModel({ model: 'unknown', defaultModel: '  ', codexHome: missingHome })).toBe(codexDefaultModel())

    const brokenHome = tempDir('codex-broken-')
    writeFileSync(join(brokenHome, 'config.toml'), 'model = [broken toml')
    expect(readCodexConfig(brokenHome)).toEqual({ model: null, effort: null })
    expect(resolveCodexFallbackModel({ model: null, defaultModel: '', codexHome: brokenHome })).toBe(codexDefaultModel())
  })

  it('never emits empty or unknown model when stream omits model fields', () => {
    const home = tempDir('codex-no-stream-model-')
    const cfg = makeCodexProfile({ configDir: home, defaultModel: '' })
    const adapter = codexAdapter(makeRunSpec(cfg, null), home, 0)
    const emit = vi.fn()

    adapter.onLine({ type: 'thread.started', thread_id: 'th-2' }, emit)
    adapter.onLine({ type: 'turn.completed', usage: { input_tokens: 500, cached_input_tokens: 100, output_tokens: 50 } }, emit)

    expect(adapter.model()).toBe(codexDefaultModel())
    expect(adapter.model()).not.toBe('')
    expect(adapter.model()).not.toBe('unknown')
  })
})

describe('codex billing without double-counting cached input tokens', () => {
  it('deducts cached_input_tokens from input_tokens and prices each bucket accurately', () => {
    // 1,000,000 total input tokens of which 800,000 are cached -> 200,000 uncached input + 800,000 cacheRead
    const u = codexTurnUsage(
      { input_tokens: 1_000_000, cached_input_tokens: 800_000, output_tokens: 500_000 },
      null
    )
    expect(u).toEqual({
      input: 200_000,
      output: 500_000,
      cacheRead: 800_000,
      cacheWrite: undefined,
      reasoning: undefined
    })

    const match = findRate('openai/gpt-5.3-codex:high', tables)
    expect(match?.key).toBe('gpt-5.3-codex')
    // gpt-5.3-codex: input $1.75/M, output $14/M, cacheRead $0.175/M
    const cost = costOf(
      { input: u.input ?? 0, output: u.output ?? 0, cacheRead: u.cacheRead ?? 0, cacheWrite: u.cacheWrite ?? 0 },
      match!.rate
    )
    const expected = (200_000 * 1.75 + 800_000 * 0.175 + 500_000 * 14) / 1e6
    expect(cost).toBeCloseTo(expected, 9)
  })
})

describe('historical codex unknown-model usage fallback in snapshot', () => {
  it('estimates historical empty/unknown codex records using the account configured model', async () => {
    const codexHome = tempDir('codex-hist-home-')
    const cfg = makeCodexProfile({ id: 'codex-legacy', configDir: codexHome, defaultModel: 'gpt-5.3-codex:high' })
    mockProfiles.push(cfg)

    // Seed historical stats file with empty and "unknown" model buckets before importing usage.ts
    mkdirSync(state.userDataDir, { recursive: true })
    const today = new Date()
    const day = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
    writeFileSync(
      join(state.userDataDir, 'usage-stats.json'),
      JSON.stringify({
        version: 3,
        runs: {
          'codex-legacy': {
            [day]: {
              '': { input: 200_000, output: 100_000, cacheRead: 800_000, cacheWrite: 0, reasoning: 0, costUsd: 0, runs: 1 },
              unknown: { input: 100_000, output: 50_000, cacheRead: 200_000, cacheWrite: 0, reasoning: 0, costUsd: 0, runs: 1 }
            }
          }
        },
        files: {},
        legacy: {},
        legacyUntil: 0,
        legacyDone: true,
        limitedAt: {}
      })
    )

    vi.resetModules()
    const usage = await import('./usage')
    const snap = usage.snapshot()

    const acct = snap.accounts['codex-legacy']
    // Total uncached input: 300k, cacheRead: 1M, output: 150k at gpt-5.3-codex ($1.75 / $0.175 / $14)
    const expectedCost = (300_000 * 1.75 + 1_000_000 * 0.175 + 150_000 * 14) / 1e6
    expect(acct.total.costUsd).toBeCloseTo(expectedCost, 9)
    expect(acct.total.unpriced ?? 0).toBe(0)
    expect(snap.models['?codex']).toMatchObject({ key: 'gpt-5.3-codex', source: 'estimate' })
    expect(snap.models['']).toBeUndefined()
    expect(snap.models['unknown']).toBeUndefined()

    // New recordRun with null model resolves via fallback instead of writing ""
    usage.recordRun('codex-legacy', null, { input: 100_000, output: 50_000, cacheRead: 0 })
    const snap2 = usage.snapshot()
    expect(snap2.models['gpt-5.3-codex:high']).toMatchObject({ key: 'gpt-5.3-codex', source: 'litellm' })
  })
})
