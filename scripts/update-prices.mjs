// Regenerates src/main/prices.builtin.json from LiteLLM's public price table (the source t3code uses).
//   node scripts/update-prices.mjs            # fetch the current table
//   node scripts/update-prices.mjs prices.json # or use a downloaded copy
// Keeps the model makers' own first-party entries (bare names, plus deepseek/…) in chat mode,
// with the rates AgentSwitch prices: input, output, cache read, cache write (5 min / 1 h) and the
// lowest long-context tier. All rates are USD per million tokens.
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SRC = 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json'
const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'main', 'prices.builtin.json')
const PROVIDERS = new Set(['anthropic', 'openai', 'gemini', 'vertex_ai-language-models', 'deepseek', 'xai'])
const FAMILY = /^(claude-|gpt-|o\d|codex|gemini-|deepseek|grok-)/

const arg = process.argv[2]
const table = arg ? JSON.parse(readFileSync(arg, 'utf8')) : await (await fetch(SRC)).json()

const m = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 1e6 * 1e6) / 1e6 : null)
const models = {}
for (const [name, e] of Object.entries(table)) {
  if (!e || typeof e !== 'object' || !PROVIDERS.has(e.litellm_provider)) continue
  if (e.mode && e.mode !== 'chat' && e.mode !== 'responses') continue
  const key = name.toLowerCase().replace(/^deepseek\//, '')
  if (key.includes('/') || !FAMILY.test(key)) continue
  const input = m(e.input_cost_per_token)
  const output = m(e.output_cost_per_token)
  if (input === null || output === null) continue
  const rate = { input, output }
  const cr = m(e.cache_read_input_token_cost)
  const cw = m(e.cache_creation_input_token_cost)
  const cw1h = m(e.cache_creation_input_token_cost_above_1hr)
  if (cr !== null) rate.cacheRead = cr
  if (cw !== null && cw > 0) rate.cacheWrite = cw
  if (cw1h !== null && cw1h > 0) rate.cacheWrite1h = cw1h
  // long-context tier: the lowest `input_cost_per_token_above_<N>k_tokens`
  const tiers = Object.keys(e)
    .map((k) => /^input_cost_per_token_above_(\d+)k_tokens$/.exec(k)?.[1])
    .filter(Boolean)
    .map(Number)
    .sort((a, b) => a - b)
  if (tiers.length) {
    const s = `_above_${tiers[0]}k_tokens`
    const long = { threshold: tiers[0] * 1000, input: m(e[`input_cost_per_token${s}`]) }
    const o = m(e[`output_cost_per_token${s}`])
    const r = m(e[`cache_read_input_token_cost${s}`])
    const w = m(e[`cache_creation_input_token_cost${s}`])
    if (o !== null) long.output = o
    if (r !== null) long.cacheRead = r
    if (w !== null && w > 0) long.cacheWrite = w
    if (long.input !== null) rate.long = long
  }
  // a first-party entry wins over an alias that maps to the same bare name
  if (!models[key] || name === key) models[key] = rate
}
const sorted = Object.fromEntries(Object.entries(models).sort(([a], [b]) => a.localeCompare(b)))
writeFileSync(OUT, JSON.stringify({ source: 'LiteLLM model_prices_and_context_window.json', fetchedAt: new Date().toISOString().slice(0, 10), unit: 'USD per 1M tokens', models: sorted }, null, 1) + '\n')
console.log(`wrote ${Object.keys(sorted).length} models to ${OUT}`)
