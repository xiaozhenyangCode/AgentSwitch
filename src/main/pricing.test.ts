import { describe, expect, it, vi } from 'vitest'
import builtin from './prices.builtin.json'
import { candidates, cleanRate, costOf, findRate, isLong, mergePriceTables, parseLiteLLM, parseModelsDev, parseOpenRouter, refreshPriceCache, PRICE_SOURCES, type PriceCache, type PriceTable } from './pricing'

const tables = {
  litellm: parseLiteLLM(builtin.litellm),
  ccswitch: Object.fromEntries(Object.entries(builtin.ccswitch).map(([k, v]) => [k, cleanRate(v)!])) as PriceTable
}

describe('model names', () => {
  it('normalizes the names CLIs report', () => {
    expect(candidates('claude-opus-5-5[1m]')[0]).toBe('claude-opus-5-5')
    expect(candidates('anthropic/Claude-Sonnet-5-5')[0]).toBe('claude-sonnet-5-5')
    expect(candidates('models/gemini-3.8-flash')[0]).toBe('gemini-3.8-flash')
    expect(candidates('claude-opus-4-6@20251101')[0]).toBe('claude-opus-4-6')
    expect(candidates('claude-haiku-4-5-20251001')).toContain('claude-haiku-4-5')
    expect(candidates('gemini-4-neon:high')[0]).toBe('gemini-4-neon')
    expect(candidates('claude-opus-5-5[1m]:max')[0]).toBe('claude-opus-5-5')
    expect(candidates('models/gemini-4-neon-preview:low')).toEqual(['gemini-4-neon-preview', 'gemini-4-neon'])
    expect(candidates('us.anthropic.claude-3-5-sonnet-20241022-v2:0')[0]).toBe('claude-3-5-sonnet-20241022')
    expect(candidates(':high')).toEqual([])
  })
  it('never falls back to a bare family', () => {
    expect(candidates('claude-unknown-9')).not.toContain('claude')
    expect(candidates('gemini-3-ultra-x')).not.toContain('gemini-3')
  })
})

describe('LiteLLM table', () => {
  it('reads per-token rates as per-million, with 1-hour writes and the long-context tier', () => {
    expect(tables.litellm['claude-opus-5-5']).toEqual({ input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5, cacheWrite1h: 8 })
    expect(tables.litellm['gpt-6.2-sol']).toEqual({ input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5, long: { threshold: 272000, input: 4, output: 15, cacheRead: 0.2, cacheWrite: 5 } })
  })
  it('accepts new chat providers and prefers bare LiteLLM names at equal cache completeness', () => {
    const t = parseLiteLLM({
      'bedrock/claude-x': { litellm_provider: 'bedrock', input_cost_per_token: 9e-6, output_cost_per_token: 9e-6 },
      'new-provider/future-chat': { litellm_provider: 'new-provider', mode: 'responses', input_cost_per_token: 2e-6, output_cost_per_token: 4e-6 },
      'claude-x': { litellm_provider: 'anthropic', input_cost_per_token: 1e-6, output_cost_per_token: 4e-6 },
      'deepseek/deepseek-y': { litellm_provider: 'deepseek', input_cost_per_token: 1e-6, output_cost_per_token: 2e-6 },
      'gpt-z': { litellm_provider: 'openai', mode: 'embedding', input_cost_per_token: 1e-6, output_cost_per_token: 0 },
      'gpt-w': { litellm_provider: 'openai', input_cost_per_token: 1e-6 }
    })
    expect(t).toEqual({ 'claude-x': { input: 1, output: 4 }, 'deepseek-y': { input: 1, output: 2 }, 'future-chat': { input: 2, output: 4 } })
  })
})

describe('price lookup', () => {
  it('prefers LiteLLM, then CC Switch, stripping variants', () => {
    expect(findRate('claude-opus-5-5[1m]', tables)).toMatchObject({ key: 'claude-opus-5-5', source: 'litellm', rate: { input: 4, output: 20 } })
    expect(findRate('gemini-4-neon', tables)).toMatchObject({ key: 'gemini-4-neon', source: 'litellm', rate: { input: 3, output: 15, cacheRead: 0.15 } })
    expect(findRate('gemini-4-neon:high', tables)).toMatchObject({ key: 'gemini-4-neon', source: 'litellm', rate: { input: 3, output: 15, cacheRead: 0.15 } })
    expect(findRate('deepseek-v4.1-flash', tables)).toMatchObject({ key: 'deepseek-v4.1-flash', source: 'ccswitch' })
    expect(findRate('deepseek-v4.1-flash:disabled', tables)).toMatchObject({ key: 'deepseek-v4.1-flash', source: 'ccswitch' })
    expect(findRate('gemini-3.8-flash-tiered', tables)?.key).toBe('gemini-3.8-flash')
    expect(findRate('claude-opus-4-6-thinking', tables)?.key).toBe('claude-opus-4-6')
    expect(findRate('gpt-5.3-codex:high', tables)).toMatchObject({ key: 'gpt-5.3-codex', source: 'litellm', rate: { input: 1.75, output: 14, cacheRead: 0.175 } })
    expect(findRate('openai/gpt-5.3-codex:xhigh', tables)).toMatchObject({ key: 'gpt-5.3-codex', source: 'litellm', rate: { input: 1.75, output: 14, cacheRead: 0.175 } })
    expect(findRate('gpt-5.2-codex:low', tables)).toMatchObject({ key: 'gpt-5.2-codex', source: 'litellm', rate: { input: 1.75, output: 14, cacheRead: 0.175 } })
    expect(findRate('gpt-5.4-codex:medium', tables)).toMatchObject({ key: 'gpt-5.4', source: 'litellm', rate: { input: 2.5, output: 15, cacheRead: 0.25 } })
    expect(findRate('gpt-6.2-sol:high', tables)).toMatchObject({ key: 'gpt-6.2-sol', source: 'litellm', rate: { input: 2, output: 10, cacheRead: 0.1 } })
    expect(findRate('codex-1', tables)).toMatchObject({ key: 'o3', source: 'litellm' })
    expect(findRate('codex-mini-latest:low', tables)).toMatchObject({ key: 'codex-mini', source: 'ccswitch' })
    expect(findRate('no-such-model', tables)).toBeNull()
    expect(findRate('<synthetic>', tables)?.rate).toEqual({ input: 0, output: 0 })
  })
})

describe('cost', () => {
  const opus = { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5, cacheWrite1h: 8 }
  it('bills every bucket at its rate', () => {
    expect(costOf({ input: 1e6, output: 1e6, cacheRead: 1e6, cacheWrite: 1e6, cacheWrite1h: 5e5 }, opus)).toBeCloseTo(4 + 20 + 0.2 + 2.5 + 4, 9)
  })
  it('falls back to input for missing cache rates', () => {
    expect(costOf({ input: 0, output: 0, cacheRead: 1e6, cacheWrite: 1e6 }, { input: 2, output: 8 })).toBeCloseTo(4, 9)
    expect(costOf({ input: 0, output: 0, cacheRead: 0, cacheWrite: 1e6, cacheWrite1h: 1e6 }, { input: 2, output: 8, cacheWrite: 2.5 })).toBeCloseTo(4, 9)
  })
  it('uses the long-context tier past its threshold', () => {
    const r = { input: 2, output: 10, cacheRead: 0.1, long: { threshold: 272000, input: 4, output: 15, cacheRead: 0.2 } }
    expect(isLong(r, 300000)).toBe(true)
    expect(isLong(r, 272000)).toBe(false)
    expect(costOf({ input: 1e6, output: 1e6, cacheRead: 1e6, cacheWrite: 0 }, r, true)).toBeCloseTo(4 + 15 + 0.2, 9)
  })
  it('accepts only sane rates', () => {
    expect(cleanRate({ input: 1, output: 2, cacheRead: -1, cacheWrite: 'x' })).toEqual({ input: 1, output: 2 })
    expect(cleanRate({ input: NaN, output: 2 })).toBeNull()
  })
})

describe('custom pricing overrides', () => {
  it('prefers custom rates over official tables and falls back when removed', () => {
    const withCustom = {
      ...tables,
      custom: {
        'claude-opus-5-5': { input: 9, output: 30, cacheRead: 1, cacheWrite: 12 },
        'my-local-model': { input: 0.5, output: 1.5 }
      }
    }

    // Matches variant via candidate normalization
    expect(findRate('claude-opus-5-5[1m]:max', withCustom)).toEqual({
      key: 'claude-opus-5-5',
      source: 'custom',
      rate: { input: 9, output: 30, cacheRead: 1, cacheWrite: 12 }
    })
    // Matches unknown custom model
    expect(findRate('my-local-model', withCustom)).toEqual({
      key: 'my-local-model',
      source: 'custom',
      rate: { input: 0.5, output: 1.5 }
    })
    // Cost calculation uses custom override and falls back omitted cache rates to input
    expect(costOf({ input: 1e6, output: 1e6, cacheRead: 1e6, cacheWrite: 0 }, findRate('my-local-model', withCustom)!.rate)).toBeCloseTo(2.5, 9)

    // Removing custom override falls back to LiteLLM official rate
    const withoutOpus = { ...tables, custom: { 'my-local-model': { input: 0.5, output: 1.5 } } }
    expect(findRate('claude-opus-5-5[1m]', withoutOpus)).toMatchObject({
      key: 'claude-opus-5-5',
      source: 'litellm',
      rate: { input: 4, output: 20 }
    })
  })
})

describe('public price sources', () => {
  const modelsDev = { google: { models: {
    'future-model': { id: 'google/future-model', cost: { input: 2, output: 12, cache_read: 0.2, cache_write: 0 } },
    'invalid-model': { cost: { input: -1, output: 1 } }
  } } }
  const openRouter = { data: [
    { id: 'google/future-model', pricing: { prompt: '0.000002', completion: '0.000012', input_cache_read: '0.0000002', input_cache_write: '-1' } },
    { id: 'openrouter/router', pricing: { prompt: '-1', completion: '-1' } }
  ] }

  it('keeps per-million models.dev rates and converts OpenRouter per-token strings exactly once', () => {
    expect(parseModelsDev(modelsDev)).toEqual({ 'future-model': { input: 2, output: 12, cacheRead: 0.2, cacheWrite: 0 } })
    expect(parseOpenRouter(openRouter)).toEqual({ 'future-model': { input: 2, output: 12, cacheRead: 0.2 } })
  })

  it('uses complete cache rates first, breaking ties in source order and preserving custom overrides', () => {
    const partial = { input: 3, output: 15, cacheRead: 0.3 }
    const full = { ...partial, cacheWrite: 0 }
    const online = mergePriceTables({
      litellm: { 'future-model': partial, 'tie': full },
      modelsdev: { ...parseModelsDev(modelsDev), 'tie': full },
      openrouter: { ...parseOpenRouter(openRouter), 'tie': full, 'only-router': partial }
    })
    expect(online['future-model'].source).toBe('modelsdev')
    expect(online.tie.source).toBe('litellm')
    expect(online['only-router'].source).toBe('openrouter')
    expect(findRate('new-provider/future-model-2026-11-24-high-tiered:xhigh', { ...tables, online }))
      .toMatchObject({ key: 'future-model', source: 'modelsdev' })
    expect(findRate('google/future-model:disabled', { ...tables, online, custom: { 'future-model': full } }))
      .toMatchObject({ key: 'future-model', source: 'custom' })
    expect(findRate('future-model-unreleased', { ...tables, online })).toBeNull()
    expect(findRate('google/future-model-v2', { ...tables, online: { ...online, 'future-model-v2': { key: 'future-model-v2', source: 'openrouter', rate: partial } } }))
      .toMatchObject({ key: 'future-model-v2', source: 'openrouter' })
  })

  it('uses source TTLs, revalidates with both headers and preserves the last table on failure', async () => {
    const now = Date.now()
    const stale = { models: { 'old-model': { input: 1, output: 2 } }, fetchedAt: now - 2000, etag: '"abc"', lastModified: new Date(0).toUTCString() }
    const cache: PriceCache = { litellm: stale, openrouter: { ...stale, fetchedAt: now } }
    const fetch = vi.fn(async (url: string, _headers: Record<string, string>) => {
      if (url === PRICE_SOURCES.litellm.url) return { status: 304, text: '', headers: {} }
      if (url === PRICE_SOURCES.modelsdev.url) return { status: 200, text: JSON.stringify(modelsDev), headers: {} }
      throw new Error('offline')
    })
    const updated = await refreshPriceCache(cache, fetch, 1000, false)
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(fetch).toHaveBeenCalledWith(PRICE_SOURCES.litellm.url, {
      Accept: 'application/json', 'If-None-Match': '"abc"', 'If-Modified-Since': stale.lastModified
    })
    expect(updated.litellm?.models).toBe(stale.models)
    expect(updated.litellm?.fetchedAt).toBeGreaterThan(stale.fetchedAt)
    expect(updated.modelsdev?.models).toEqual(parseModelsDev(modelsDev))
    expect(updated.openrouter).toBe(cache.openrouter)
    await expect(refreshPriceCache(updated, async () => { throw new Error('offline') }, 1000, true)).resolves.toBe(updated)
  })
})
