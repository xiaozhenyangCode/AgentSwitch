// Regenerates src/main/prices.builtin.json, the offline fallback of the price table.
//   node scripts/update-prices.mjs [litellm.json] [cc-switch.db]
// - litellm: LiteLLM's public table (what t3code prices with; the app also refreshes it daily).
//   Only the first-party chat entries are kept, raw, with the fields src/main/pricing.ts reads.
// - ccswitch: CC Switch's built-in model_pricing table (~/.cc-switch/cc-switch.db), for models
//   LiteLLM does not list yet (e.g. gemini-4-neon). Rates per million tokens.
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SRC = 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json'
const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'main', 'prices.builtin.json')
const PROVIDERS = new Set(['anthropic', 'openai', 'gemini', 'vertex_ai-language-models', 'deepseek', 'xai'])
const FAMILY = /^(claude-|gpt-|o\d|codex|gemini-|deepseek|grok-)/
const FIELD = /^(input|output)_cost_per_token(_above_\d+k_tokens)?$|^cache_(read|creation)_input_token_cost(_above_1hr|_above_\d+k_tokens)?$/

const [litellmArg, dbArg = join(homedir(), '.cc-switch', 'cc-switch.db')] = process.argv.slice(2)
const table = litellmArg ? JSON.parse(readFileSync(litellmArg, 'utf8')) : await (await fetch(SRC)).json()

const litellm = {}
for (const [name, e] of Object.entries(table)) {
  if (!e || typeof e !== 'object' || !PROVIDERS.has(e.litellm_provider)) continue
  if (e.mode && e.mode !== 'chat' && e.mode !== 'responses') continue
  const bare = name.toLowerCase().replace(/^(deepseek|gemini|xai|openai|anthropic)\//, '')
  if (bare.includes('/') || !FAMILY.test(bare)) continue
  if (typeof e.input_cost_per_token !== 'number' || typeof e.output_cost_per_token !== 'number') continue
  if (litellm[bare] && name.toLowerCase() !== bare) continue // the bare entry wins over a prefixed alias
  litellm[bare] = Object.fromEntries(Object.entries(e).filter(([k, v]) => FIELD.test(k) && typeof v === 'number'))
}

const ccswitch = {}
if (existsSync(dbArg)) {
  const rows = execFileSync('sqlite3', ['-readonly', '-json', dbArg, 'select * from model_pricing'], { encoding: 'utf8' })
  for (const r of JSON.parse(rows || '[]')) {
    const v = (x) => (x === undefined || x === null || x === '' ? undefined : Number(x))
    const rate = { input: v(r.input_cost_per_million), output: v(r.output_cost_per_million), cacheRead: v(r.cache_read_cost_per_million), cacheWrite: v(r.cache_creation_cost_per_million) }
    if (!(rate.input >= 0 && rate.output >= 0)) continue
    if (!(rate.cacheWrite > 0)) delete rate.cacheWrite // 0 there means "not listed"
    if (rate.cacheRead === undefined) delete rate.cacheRead
    ccswitch[String(r.model_id).toLowerCase()] = rate
  }
}

const sort = (o) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)))
writeFileSync(
  OUT,
  JSON.stringify({ fetchedAt: new Date().toISOString().slice(0, 10), litellm: sort(litellm), ccswitch: sort(ccswitch) }, null, 1) + '\n'
)
console.log(`wrote ${Object.keys(litellm).length} LiteLLM + ${Object.keys(ccswitch).length} CC Switch models to ${OUT}`)
