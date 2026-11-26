import type { OnlinePriceSource, PriceRate } from '@shared/types'

/**
 * Token pricing in USD per million. Public tables are cached locally, with the packaged
 * LiteLLM and CC Switch snapshot available on first launch and offline.
 */

export type PriceTable = Record<string, PriceRate>

/** Token counts of one model (per day); cacheWrite1h is the 1-hour part of cacheWrite. */
export interface Tokens {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  cacheWrite1h?: number
}

/** Names that never cost anything (claude's locally generated messages). */
const FREE = new Set(['<synthetic>'])

/** Canonical aliases for CLI model names whose keys differ from LiteLLM / CC Switch. */
const MODEL_ALIASES: Record<string, string> = {
  'codex-1': 'o3',
  'codex-mini-latest': 'codex-mini'
}

const bareName = (name: string): string => name.trim().toLowerCase().split('/').at(-1) ?? ''
const own = (table: PriceTable | undefined, key: string): PriceRate | undefined =>
  table && Object.hasOwn(table, key) ? table[key] : undefined

/** Names to try after the exact ID, with only known CLI decorations removed. */
export function candidates(model: string): string[] {
  let name = bareName(model)
    .replace(/^(?:us|eu|apac|global)\.(?:anthropic\.)?|^anthropic\./, '')
    .replace(/:(?:minimal|low|medium|high|xhigh|max|ultra|none|disabled|\d+)$/, '')
    .replace(/\[[^\]]*\]$/, '')
    .replace(/@\d{8}$/, '')
    .replace(/-v\d+$/, '')
  const out: string[] = []
  while (name) {
    if (!out.includes(name)) out.push(name)
    const alias = MODEL_ALIASES[name]
    if (alias && !out.includes(alias)) out.push(alias)
    const shorter = name.replace(/-(?:\d{8}|20\d{2}-\d{2}-\d{2}|(?:preview-)?\d{2}-\d{2}|v\d+|minimal|low|medium|high|xhigh|max|ultra|none|disabled|tiered|latest|preview|thinking|codex)$/, '')
    if (shorter === name || /^(claude|gemini)-[\d.]+$/.test(shorter) || !/[-.]/.test(shorter)) break
    name = shorter
  }
  return out
}

export const PRICE_SOURCES = {
  litellm: { url: 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json', parse: parseLiteLLM },
  modelsdev: { url: 'https://models.dev/api.json', parse: parseModelsDev },
  openrouter: { url: 'https://openrouter.ai/api/v1/models', parse: parseOpenRouter }
}
export type PriceSource = 'custom' | OnlinePriceSource | 'ccswitch'

export interface Match {
  key: string
  rate: PriceRate
  source: PriceSource
}

export interface PriceTables {
  custom?: PriceTable
  online?: Record<string, Match>
  litellm: PriceTable
  ccswitch: PriceTable
}

const cacheCompleteness = (rate: PriceRate): number => Number(rate.cacheRead !== undefined && rate.cacheWrite !== undefined)

export function mergePriceTables(tables: Partial<Record<OnlinePriceSource, PriceTable>>): Record<string, Match> {
  const merged: Record<string, Match> = Object.create(null)
  for (const source of Object.keys(PRICE_SOURCES) as OnlinePriceSource[]) {
    for (const [key, rate] of Object.entries(tables[source] ?? {})) {
      const previous = merged[key]
      if (!previous || cacheCompleteness(rate) > cacheCompleteness(previous.rate)) merged[key] = { key, rate, source }
    }
  }
  return merged
}

export function findRate(model: string, tables: PriceTables): Match | null {
  const exact = model.trim().toLowerCase()
  const names = [...new Set([exact, bareName(model), ...candidates(model)])].filter(Boolean)
  for (const key of names) {
    const rate = own(tables.custom, key)
    if (rate) return { key, rate, source: 'custom' }
  }
  if (FREE.has(exact)) return { key: exact, rate: { input: 0, output: 0 }, source: 'litellm' }
  for (const key of names) {
    const online = tables.online && Object.hasOwn(tables.online, key) ? tables.online[key] : undefined
    if (online) return online
    const litellm = own(tables.litellm, key)
    if (litellm) return { key, rate: litellm, source: 'litellm' }
    const ccswitch = own(tables.ccswitch, key)
    if (ccswitch) return { key, rate: ccswitch, source: 'ccswitch' }
  }
  return null
}

const FIRST_PARTY = new Set(['anthropic', 'openai', 'google', 'gemini', 'vertex_ai-language-models', 'deepseek', 'xai', 'x-ai'])

function insertRate(out: PriceTable, ranks: Map<string, number>, name: string, rate: PriceRate, rank: number): void {
  const key = bareName(name)
  const score = cacheCompleteness(rate) * 4 + rank
  if (!key || score <= (ranks.get(key) ?? -1)) return
  ranks.set(key, score)
  out[key] = rate
}

function perMillion(value: unknown, factor: number): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return undefined
  const rate = Number((value * factor).toPrecision(15))
  return Number.isFinite(rate) ? rate : undefined
}

/**
 * LiteLLM's model_prices_and_context_window.json (whole, or filtered by scripts/update-prices.mjs)
 * -> USD per million for chat and responses models, including their lowest long-context tier.
 */
export function parseLiteLLM(doc: unknown): PriceTable {
  const out: PriceTable = Object.create(null)
  const ranks = new Map<string, number>()
  if (!doc || typeof doc !== 'object') return out
  const per = (v: unknown): number | undefined => perMillion(v, 1e6)
  for (const [name, raw] of Object.entries(doc as Record<string, any>)) {
    if (!raw || typeof raw !== 'object') continue
    if (raw.mode && raw.mode !== 'chat' && raw.mode !== 'responses') continue
    const input = per(raw.input_cost_per_token)
    const output = per(raw.output_cost_per_token)
    if (input === undefined || output === undefined) continue
    const rate: PriceRate = { input, output }
    const cr = per(raw.cache_read_input_token_cost)
    const cw = per(raw.cache_creation_input_token_cost)
    const cw1h = per(raw.cache_creation_input_token_cost_above_1hr)
    if (cr !== undefined) rate.cacheRead = cr
    if (cw !== undefined) rate.cacheWrite = cw
    if (cw1h !== undefined) rate.cacheWrite1h = cw1h
    const tier = Object.keys(raw)
      .map((k) => Number(/^input_cost_per_token_above_(\d+)k_tokens$/.exec(k)?.[1]))
      .filter((x) => x > 0)
      .sort((x, y) => x - y)[0]
    if (tier) {
      const sfx = `_above_${tier}k_tokens`
      const li = per(raw[`input_cost_per_token${sfx}`])
      if (li !== undefined) {
        rate.long = { threshold: tier * 1000, input: li }
        const lo = per(raw[`output_cost_per_token${sfx}`])
        const lr = per(raw[`cache_read_input_token_cost${sfx}`])
        const lw = per(raw[`cache_creation_input_token_cost${sfx}`])
        if (lo !== undefined) rate.long.output = lo
        if (lr !== undefined) rate.long.cacheRead = lr
        if (lw !== undefined) rate.long.cacheWrite = lw
      }
    }
    insertRate(out, ranks, name, rate, name.includes('/') ? Number(FIRST_PARTY.has(raw.litellm_provider)) : 2)
  }
  return out
}

export function parseModelsDev(doc: unknown): PriceTable {
  const out: PriceTable = Object.create(null)
  const ranks = new Map<string, number>()
  if (!doc || typeof doc !== 'object') return out
  for (const [provider, entry] of Object.entries(doc)) {
    if (!entry?.models || typeof entry.models !== 'object') continue
    for (const [key, raw] of Object.entries(entry.models) as [string, any][]) {
      if (!raw?.cost) continue
      const rate = cleanRate({ input: raw.cost.input, output: raw.cost.output, cacheRead: raw.cost.cache_read, cacheWrite: raw.cost.cache_write })
      if (!rate) continue
      const name = typeof raw.id === 'string' && raw.id ? raw.id : key
      insertRate(out, ranks, name.includes('/') ? name : `${provider}/${name}`, rate, Number(FIRST_PARTY.has(provider)))
    }
  }
  return out
}

export function parseOpenRouter(doc: unknown): PriceTable {
  const out: PriceTable = Object.create(null)
  const ranks = new Map<string, number>()
  const data = (doc as { data?: unknown } | null)?.data
  if (!Array.isArray(data)) return out
  const per = (value: unknown): number | undefined =>
    perMillion(typeof value === 'string' && value.trim() ? Number(value) : value, 1e6)
  for (const row of data) {
    if (typeof row?.id !== 'string' || !row.pricing) continue
    const p = row.pricing
    const rate = cleanRate({ input: per(p.prompt), output: per(p.completion), cacheRead: per(p.input_cache_read), cacheWrite: per(p.input_cache_write) })
    if (rate) insertRate(out, ranks, row.id, rate, 0)
  }
  return out
}

export interface PriceCacheEntry {
  models: PriceTable
  fetchedAt: number
  etag?: string
  lastModified?: string
}
export type PriceCache = Partial<Record<OnlinePriceSource, PriceCacheEntry>>
export type PriceFetch = (url: string, headers: Record<string, string>) => Promise<{
  status: number
  text: string
  headers: Record<string, string>
}>

export async function refreshPriceCache(cache: PriceCache, fetch: PriceFetch, ttl: number, force: boolean): Promise<PriceCache> {
  const pending = (Object.entries(PRICE_SOURCES) as [OnlinePriceSource, typeof PRICE_SOURCES[OnlinePriceSource]][])
    .filter(([source]) => force || !cache[source] || Date.now() - cache[source].fetchedAt >= ttl)
  const updated = await Promise.allSettled(pending.map(async ([source, { url, parse }]) => {
    const previous = cache[source]
    const headers: Record<string, string> = { Accept: 'application/json' }
    if (previous?.etag) headers['If-None-Match'] = previous.etag
    if (previous?.lastModified) headers['If-Modified-Since'] = previous.lastModified
    const response = await fetch(url, headers)
    const models = response.status === 304 && previous
      ? previous.models
      : response.status === 200 ? parse(JSON.parse(response.text)) : null
    if (!models || !Object.keys(models).length) return null
    const entry: PriceCacheEntry = {
      models,
      fetchedAt: Date.now(),
      etag: response.headers.etag ?? (response.status === 304 ? previous?.etag : undefined),
      lastModified: response.headers['last-modified'] ?? (response.status === 304 ? previous?.lastModified : undefined)
    }
    return [source, entry] as const
  }))
  const results = updated.flatMap((r) => r.status === 'fulfilled' && r.value ? [r.value] : [])
  return results.length ? { ...cache, ...Object.fromEntries(results) } : cache
}

/** The long-context tier applies to a request whose prompt (input incl. cache) exceeds the threshold. */
export const isLong = (rate: PriceRate | null | undefined, prompt: number): boolean => !!rate?.long && prompt > rate.long.threshold

/**
 * USD for the tokens. Missing cache rates are billed as input; a 1-hour cache write without its
 * own rate costs 1.6x the 5-minute one (Anthropic: 2x vs 1.25x input).
 */
export function costOf(t: Tokens, rate: PriceRate, long = false): number {
  const l = long && rate.long ? rate.long : null
  const input = l?.input ?? rate.input
  const output = l?.output ?? rate.output
  const cacheRead = l?.cacheRead ?? rate.cacheRead ?? input
  const cacheWrite = l?.cacheWrite ?? rate.cacheWrite ?? input
  const cacheWrite1h = l ? cacheWrite * 1.6 : (rate.cacheWrite1h ?? (rate.cacheWrite !== undefined ? rate.cacheWrite * 1.6 : input))
  const w1h = Math.min(t.cacheWrite1h ?? 0, t.cacheWrite)
  return (t.input * input + t.output * output + t.cacheRead * cacheRead + (t.cacheWrite - w1h) * cacheWrite + w1h * cacheWrite1h) / 1e6
}

/** A rate read from a file: finite, non-negative numbers only. */
export function cleanRate(v: unknown): PriceRate | null {
  if (!v || typeof v !== 'object') return null
  const r = v as Record<string, unknown>
  const ok = (x: unknown): x is number => typeof x === 'number' && isFinite(x) && x >= 0
  if (!ok(r.input) || !ok(r.output)) return null
  const out: PriceRate = { input: r.input, output: r.output }
  if (ok(r.cacheRead)) out.cacheRead = r.cacheRead
  if (ok(r.cacheWrite)) out.cacheWrite = r.cacheWrite
  if (ok(r.cacheWrite1h)) out.cacheWrite1h = r.cacheWrite1h
  const l = r.long as Record<string, unknown> | undefined
  if (l && ok(l.threshold) && ok(l.input)) {
    out.long = { threshold: l.threshold, input: l.input }
    if (ok(l.output)) out.long.output = l.output
    if (ok(l.cacheRead)) out.long.cacheRead = l.cacheRead
    if (ok(l.cacheWrite)) out.long.cacheWrite = l.cacheWrite
  }
  return out
}
