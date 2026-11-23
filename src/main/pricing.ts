import type { PriceRate } from '@shared/types'

/**
 * Token -> USD at API list prices. Built-in table: scripts/update-prices.mjs (LiteLLM snapshot);
 * the user's overrides win. Rates are USD per million tokens.
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
  m = m.replace(/\[[^\]]*\]$/, '') // claude-opus-5-5[1m]
  m = m.replace(/@.*$/, '') // vertex: claude-…@20250514
  m = m.slice(m.lastIndexOf('/') + 1) // anthropic/…, models/…, deepseek/…
  m = m.replace(/^(?:us|eu|apac|global)\.(?:anthropic\.)?|^anthropic\./, '') // bedrock ids
  m = m.replace(/-v\d+(?::\d+)?$/, '')
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

export interface Match {
  key: string
  rate: PriceRate
  source: 'builtin' | 'custom'
}

/** The rate a model is billed at (overrides first at every level of specificity). */
export function findRate(model: string, builtin: PriceTable, overrides: PriceTable): Match | null {
  if (FREE.has(model)) return { key: model, rate: { input: 0, output: 0 }, source: 'builtin' }
  if (!model) return overrides[''] ? { key: '', rate: overrides[''], source: 'custom' } : null
  for (const c of candidates(model)) {
    if (overrides[c]) return { key: c, rate: overrides[c], source: 'custom' }
    if (builtin[c]) return { key: c, rate: builtin[c], source: 'builtin' }
  }
  return null
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

/** A rate as typed by the user: finite, non-negative numbers only. */
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
