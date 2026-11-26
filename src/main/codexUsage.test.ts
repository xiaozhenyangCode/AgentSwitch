import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { net } from 'electron'
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

import { getEffectiveDefaultModel, listModels, resolveEffectiveDefaultModel, resolveRunModel } from './models'
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
  vi.unstubAllEnvs()
  vi.mocked(net.fetch).mockReset()
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

describe('Codex rollout model IDs', () => {
  const timestamp = new Date().toISOString()
  const context = (model: string, time = timestamp) => ({ type: 'turn_context', timestamp: time, payload: { model } })
  const count = (input: number) => ({
    type: 'event_msg', timestamp, payload: { type: 'token_count', info: {
      total_token_usage: { input_tokens: input, output_tokens: input / 10 }
    } }
  })

  it('reads the latest current-turn model when a resumed stream omits it', () => {
    const cfg = makeCodexProfile({ defaultModel: 'saved-selection' })
    const session = 'fixture-resume'
    const dir = join(cfg.configDir, 'sessions/2026/11/26')
    mkdirSync(dir, { recursive: true })
    const file = join(dir, `rollout-${session}.jsonl`)
    const old = context('old-model', new Date(Date.parse(timestamp) - 60_000).toISOString())
    writeFileSync(file, JSON.stringify(old) + '\n')
    const adapter = codexAdapter({ ...makeRunSpec(cfg), resume: session }, cfg.configDir, Date.parse(timestamp))
    writeFileSync(file, [old, context('openai/new-codex-id'), { type: 'message', text: 'x'.repeat(180_000) }].map((d) => JSON.stringify(d)).join('\n'))
    const emit = vi.fn()
    adapter.onLine({ type: 'turn.completed', usage: { input_tokens: 150, output_tokens: 15 } }, emit)
    expect(adapter.model()).toBe('openai/new-codex-id')
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ t: 'request_usage', model: 'openai/new-codex-id' }))
  })

  it('attributes leading token counts to the first turn model and uses session metadata if needed', async () => {
    const { codexFileDays } = await import('./usage')
    const file = join(tempDir('codex-file-days-'), 'rollout.jsonl')
    const write = (...events: object[]) => writeFileSync(file, events.map((d) => JSON.stringify(d)).join('\n'))
    const meta = { type: 'session_meta', timestamp, payload: { model: 'session-default' } }
    write(meta, count(100), context('first-turn'), count(250), context('second-turn'), count(300))
    expect(Object.values(await codexFileDays(file, 0, 0))[0]).toMatchObject({
      'first-turn': { input: 250, output: 25 }, 'second-turn': { input: 50, output: 5 }
    })
    write(meta, count(100))
    expect(Object.values(await codexFileDays(file, 0, 0))[0]).toMatchObject({ 'session-default': { input: 100 } })
  })
})

describe('effective CLI default models', () => {
  it('reads Claude env, user settings, catalog default and custom API-key defaults', () => {
    const cfg = makeCodexProfile({ kind: 'claude', id: 'claude-default-test' })
    const catalog = join(cfg.configDir, 'cache/model-catalog')
    mkdirSync(catalog, { recursive: true })
    writeFileSync(join(catalog, 'fixture-cc.json'), JSON.stringify({
      fetchedAt: 1,
      catalog: { config: { defaultModel: 'claude-future', models: [{ section: 'main', id: 'claude-future' }] } }
    }))
    expect(resolveEffectiveDefaultModel(cfg)).toBe('claude-future')
    writeFileSync(join(cfg.configDir, 'settings.json'), JSON.stringify({ model: 'claude-settings' }))
    expect(resolveEffectiveDefaultModel(cfg)).toBe('claude-settings')
    const env = { ...cfg, extraEnv: { ANTHROPIC_MODEL: 'env-model' } }
    expect(resolveEffectiveDefaultModel(env)).toBe('env-model')
    expect(resolveEffectiveDefaultModel({ ...env, apiKey: { provider: 'custom', models: ['custom-model'] } })).toBe('custom-model')
    expect(resolveRunModel(env, 'custom-provider/Runtime-New:variant', 'explicit-model')).toBe('custom-provider/Runtime-New:variant')
  })

  it('uses the Codex catalog priority and refreshes cached TOML model and effort', async () => {
    const cfg = makeCodexProfile({ id: 'codex-default-fixture' })
    mockProfiles.push(cfg)
    writeFileSync(join(cfg.configDir, 'models_cache.json'), JSON.stringify({ models: [
      { slug: 'later-model', visibility: 'list', priority: 4 },
      { slug: 'catalog-first', visibility: 'list', priority: 1 }
    ] }))
    expect((await listModels(cfg.id)).defaultModel).toBe('catalog-first')
    writeFileSync(join(cfg.configDir, 'config.toml'), 'model = "configured-next"\nmodel_reasoning_effort = "high"\n')
    expect(getEffectiveDefaultModel(cfg.id)).toBe('catalog-first')
    expect((await listModels(cfg.id, true)).defaultModel).toBe('configured-next:high')
    expect(getEffectiveDefaultModel(cfg.id)).toBe('configured-next:high')
  })

  it('reads the most specific agy settings and falls back to the model catalog', async () => {
    const cfg = makeCodexProfile({ kind: 'gemini', id: 'gemini-default-fixture' })
    mockProfiles.push(cfg)
    const gemini = join(cfg.configDir, '.gemini')
    mkdirSync(join(gemini, 'antigravity-cli'), { recursive: true })
    expect(resolveEffectiveDefaultModel(cfg, [{ id: 'gemini-future', label: 'Future', group: 'main', defaultEffort: 'medium' }])).toBe('gemini-future-medium')
    writeFileSync(join(gemini, 'settings.json'), JSON.stringify({ model: 'gemini-older' }))
    writeFileSync(join(gemini, 'antigravity-cli/settings.json'), JSON.stringify({ selectedModel: 'gemini-3.8-flash-tiered' }))
    expect((await listModels(cfg.id)).defaultModel).toBe('gemini-3.8-flash-tiered')
  })
})

describe('price sync integration', () => {
  it('recalculates model and account costs, persists results, and preserves custom prices offline', async () => {
    state.userDataDir = tempDir('agentswitch-sync-prices-')
    const cfg = makeCodexProfile({ id: 'codex-price-sync' })
    mockProfiles.push(cfg)
    for (const key of ['https_proxy', 'HTTPS_PROXY', 'http_proxy', 'HTTP_PROXY', 'all_proxy', 'ALL_PROXY']) vi.stubEnv(key, undefined)
    vi.resetModules()
    const usage = await import('./usage')
    const listener = vi.fn()
    usage.onUsageChange(listener)
    const model = 'custom-provider/Not-Listed-Yet'
    const edit = 'model-with-custom-price'
    usage.recordRun(cfg.id, model, { input: 1_000_000 })
    usage.recordRun(cfg.id, edit, { input: 1_000_000 })
    usage.setCustomPrice(edit, { input: 8, output: 13 })
    expect(usage.snapshot().models[model]).toMatchObject({ source: null, key: null })
    vi.mocked(net.fetch).mockImplementation(async (url) => {
      if (String(url).includes('openrouter.ai')) throw new Error('offline')
      const data = String(url).includes('models.dev')
        ? { provider: { models: { 'not-listed-yet': { cost: { input: 2, output: 3 } } } } }
        : { [edit]: { input_cost_per_token: 0.000001, output_cost_per_token: 0.000001 } }
      return new Response(JSON.stringify(data), { headers: { ETag: '"fixture-v1"' } })
    })
    const synced = await usage.syncPrices(true)
    expect(synced.pricesSources).toEqual(['litellm', 'modelsdev'])
    expect(synced.pricesSyncedAt).toBeGreaterThan(0)
    expect(synced.models[model]).toMatchObject({ source: 'modelsdev', key: 'not-listed-yet' })
    expect(synced.models[edit]).toMatchObject({ source: 'custom', rate: { input: 8 } })
    expect(synced.accounts[cfg.id].total.costUsd).toBe(10)
    expect(listener).toHaveBeenCalledWith(synced)
    expect(JSON.parse(readFileSync(join(state.userDataDir, 'prices-cache.v2.json'), 'utf8')).modelsdev.etag).toBe('"fixture-v1"')
    vi.mocked(net.fetch).mockRejectedValue(new Error('offline'))
    const offline = await usage.syncPrices(true)
    expect(offline.pricesSyncedAt).toBe(synced.pricesSyncedAt)
    expect(offline.accounts[cfg.id].total.costUsd).toBe(10)

    vi.resetModules()
    const restarted = await import('./usage')
    const tokens = { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 }
    expect(restarted.priceForRequest(model, tokens).costUsd).toBe(2)
    expect(restarted.priceForRequest(edit, tokens).costUsd).toBe(8)
    expect(restarted.snapshot().pricesSyncedAt).toBe(synced.pricesSyncedAt)
  })
})
