import type { PriceRate } from '@shared/types'

/**
 * Token -> USD at the vendors' API list prices (USD per million tokens), from LiteLLM's public
 * table (refreshed daily, as t3code does; offline: the snapshot in prices.builtin.json) and, for
 * models it does not list yet, CC Switch's built-in table (snapshot).
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

/** Names to try for a model as CLIs report it, most specific first. */
export function candidates(model: string): string[] {
  let m = model.trim().toLowerCase()
  m = m.slice(m.lastIndexOf('/') + 1) // anthropic/…, models/…, deepseek/…
  m = m.replace(/^(?:us|eu|apac|global)\.(?:anthropic\.)?|^anthropic\./, '') // bedrock ids
  m = m.replace(/@.*$/, '') // vertex: claude-…@20250514
  m = m.replace(/:.*$/, '') // effort / tag suffix: gemini-4-neon:high, bedrock …-v2:0
  m = m.replace(/\[[^\]]*\]$/, '') // claude-opus-5-5[1m]
  m = m.replace(/-v\d+$/, '')
  if (!m) return []
  const out = [m]
  // drop trailing segments: dates (-20251001), variants (-codex, -preview-05-06, -latest), …
  for (let s = m; s.lastIndexOf('-') > 0; ) {
    s = s.slice(0, s.lastIndexOf('-'))
    // never fall back to a bare family name ("claude", "gpt", "gemini-3")
    if (!/[-.]/.test(s) || /^(claude|gemini)-[\d.]+$/.test(s)) break
    out.push(s)
  }
  return out
}

export type PriceSource = 'custom' | 'litellm' | 'ccswitch'

export interface Match {
  key: string
  rate: PriceRate
  source: PriceSource
}

export interface PriceTables {
  custom?: PriceTable
  litellm: PriceTable
  ccswitch: PriceTable
}

/** The rate a model is billed at: user custom overrides first, then LiteLLM, then CC Switch. */
export function findRate(model: string, t: PriceTables): Match | null {
  if (t.custom) {
    const exact = model.trim().toLowerCase()
    if (exact && t.custom[exact]) return { key: exact, rate: t.custom[exact], source: 'custom' }
    for (const c of candidates(model)) if (t.custom[c]) return { key: c, rate: t.custom[c], source: 'custom' }
  }
  if (FREE.has(model)) return { key: model, rate: { input: 0, output: 0 }, source: 'litellm' }
  const names = candidates(model)
  for (const c of names) if (t.litellm[c]) return { key: c, rate: t.litellm[c], source: 'litellm' }
  for (const c of names) if (t.ccswitch[c]) return { key: c, rate: t.ccswitch[c], source: 'ccswitch' }
  return null
}

const FIRST_PARTY = new Set(['anthropic', 'openai', 'gemini', 'vertex_ai-language-models', 'deepseek', 'xai'])
const PREFIX = /^(deepseek|gemini|xai|openai|anthropic)\//

/**
 * LiteLLM's model_prices_and_context_window.json (whole, or filtered by scripts/update-prices.mjs)
 * -> rates per million tokens. Keeps the model makers' own chat entries (bare names win over
 * prefixed aliases) and the lowest long-context tier; entries without input/output rates are dropped.
 */
export function parseLiteLLM(doc: unknown): PriceTable {
  const out: PriceTable = {}
  if (!doc || typeof doc !== 'object') return out
  const per = (v: unknown): number | undefined => (typeof v === 'number' && isFinite(v) && v >= 0 ? Math.round(v * 1e12) / 1e6 : undefined)
  for (const [name, raw] of Object.entries(doc as Record<string, any>)) {
    if (!raw || typeof raw !== 'object') continue
    if (raw.litellm_provider !== undefined && !FIRST_PARTY.has(raw.litellm_provider)) continue
    if (raw.mode && raw.mode !== 'chat' && raw.mode !== 'responses') continue
    const bare = name.toLowerCase().replace(PREFIX, '')
    if (bare.includes('/')) continue
    const input = per(raw.input_cost_per_token)
    const output = per(raw.output_cost_per_token)
    if (input === undefined || output === undefined) continue
    if (out[bare] && name.toLowerCase() !== bare) continue
    const rate: PriceRate = { input, output }
    const cr = per(raw.cache_read_input_token_cost)
    const cw = per(raw.cache_creation_input_token_cost)
    const cw1h = per(raw.cache_creation_input_token_cost_above_1hr)
    if (cr !== undefined) rate.cacheRead = cr
    if (cw) rate.cacheWrite = cw
    if (cw1h) rate.cacheWrite1h = cw1h
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
        if (lw) rate.long.cacheWrite = lw
      }
    }
    out[bare] = rate
  }
  return out
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
