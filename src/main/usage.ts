import { app, net } from 'electron'
import { createHash } from 'node:crypto'
import { closeSync, createReadStream, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, readSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { execFile, spawn } from 'node:child_process'
import type { AccountQuota, AccountUsage, DailyUsage, ModelPrice, PriceRate, ProfileConfig, ProfileId, ProfileKind, QuotaGroup, QuotaReport, QuotaWindow, Usage, UsageSnapshot, UsageTotals } from '@shared/types'
import { codexDefaultModel, isUnknownModelName, readCodexConfig, resolveCodexFallbackModel, runAgent } from './agentRunner'
import { agyConversationDb, claudePath, codexRollout, importedCutoffs, listHistory, pbAll, rolloutPaths, toMs, withDb } from './history'
import builtinPrices from './prices.builtin.json'
import { cleanRate, costOf, findRate, isLong, parseLiteLLM, type Match, type PriceTable, type PriceTables } from './pricing'
import { claudeSessionLog } from './usageDelta'
import { buildSpawnSpec, expandHome, getConfig, hasProfile, isLoggedIn, kindBinaryPath, listConfigs } from './profiles'
import { hasSubscriptionQuota } from './apiKey'
import { realHome } from './shellEnv'
import { nativeSessionEntries, type NativeSessions } from './historyResume'

/**
 * Per-account token / cost statistics and quota windows.
 *
 *  - runs: usage CLIs reported for AgentSwitch's own steps (the only source of cost).
 *  - hist: tokens backfilled from local CLI history (claude: last 30 days, codex: all), per
 *    file and re-read only when the file changed. AgentSwitch's own sessions are excluded (they
 *    are counted as runs); for imported sessions only turns before the import count.
 *  - quota: claude rate_limit_event (seen during runs) and codex rollout token_count
 *    rate_limits. Nothing is invented: accounts without such data have quota = null.
 *
 * Tokens are kept per day and model; cost is computed when the snapshot is built, at the vendors'
 * API list prices (see pricing.ts), so a newer price table re-prices all history.
 *
 * Stats: userData/usage-stats.json · quota: userData/quota-cache.json · prices: userData/prices-litellm.json.
 */

const CLAUDE_DAYS = 30
const DAY = 86400_000

/** One model's tokens on one day; costUsd is only what a CLI reported (used for models without a price). */
type Bucket = UsageTotals & { cacheWrite1h?: number }
/** day -> model key (`<model as reported>`, `|long` when billed at the long-context tier) -> tokens */
type Days = Record<string, Record<string, Bucket>>
interface FileEntry {
  mtime: number
  size: number
  profileId: ProfileId
  days: Days
}
interface Stats {
  /**
   * 3: per model. 2: per run, no model. 1: summed claude's cumulative session cost and codex's
   * cumulative tokens. On the way to 3, run tokens before the upgrade are re-read from the CLIs'
   * own logs of AgentSwitch's sessions (`legacy`), which carry the model of every message.
   */
  version: 3
  runs: Record<ProfileId, Days>
  files: Record<string, FileEntry>
  /** AgentSwitch's own sessions up to `legacyUntil` (read once). */
  legacy: Record<string, FileEntry>
  legacyUntil: number
  legacyDone: boolean
  limitedAt: Record<ProfileId, number>
}

const statsFile = (): string => join(app.getPath('userData'), 'usage-stats.json')
const quotaFile = (): string => join(app.getPath('userData'), 'quota-cache.json')
const pricesFile = (): string => join(app.getPath('userData'), 'prices-litellm.json')
const customPricesFile = (): string => join(app.getPath('userData'), 'prices-custom.json')

const zero = (): Bucket => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, costUsd: 0, runs: 0 })
const n = (v: unknown): number => (typeof v === 'number' && isFinite(v) && v > 0 ? v : 0)
function add<T extends Bucket>(a: T, b: Partial<Bucket>): T {
  return {
    ...a,
    input: a.input + n(b.input),
    output: a.output + n(b.output),
    cacheRead: a.cacheRead + n(b.cacheRead),
    cacheWrite: a.cacheWrite + n(b.cacheWrite),
    reasoning: a.reasoning + n(b.reasoning),
    costUsd: a.costUsd + n(b.costUsd),
    runs: a.runs + n(b.runs),
    ...(a.cacheWrite1h || b.cacheWrite1h ? { cacheWrite1h: n(a.cacheWrite1h) + n(b.cacheWrite1h) } : {}),
    ...(a.unpriced || b.unpriced ? { unpriced: n(a.unpriced) + n(b.unpriced) } : {})
  }
}
const tokensOf = (b: Partial<Bucket>): number => n(b.input) + n(b.output) + n(b.cacheRead) + n(b.cacheWrite)

// ---- prices -----------------------------------------------------------------------------------------

const LITELLM_URL = 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json'
const PRICES_TTL = DAY

const ccswitch: PriceTable = {}
for (const [k, v] of Object.entries(builtinPrices.ccswitch)) {
  const r = cleanRate(v)
  if (r) ccswitch[k] = r
}
/** LiteLLM's table as last fetched (null: never; the built-in snapshot applies). */
let live: { fetchedAt: number; models: PriceTable } | null = loadLive()
let customPrices: PriceTable = loadCustomPrices()
let tables: PriceTables = { custom: customPrices, litellm: { ...parseLiteLLM(builtinPrices.litellm), ...(live?.models ?? {}) }, ccswitch }
const matches = new Map<string, Match | null>()

function loadCustomPrices(): PriceTable {
  try {
    const j = JSON.parse(readFileSync(customPricesFile(), 'utf8'))
    if (!j || typeof j !== 'object' || Array.isArray(j)) return {}
    const out: PriceTable = {}
    for (const [k, v] of Object.entries(j as Record<string, unknown>)) {
      const key = k.trim().toLowerCase()
      const r = cleanRate(v)
      if (key && r) out[key] = r
    }
    return out
  } catch {
    return {}
  }
}

function saveCustomPrices(): void {
  const f = customPricesFile()
  mkdirSync(app.getPath('userData'), { recursive: true })
  const tmp = `${f}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(customPrices, null, 2), 'utf8')
  renameSync(tmp, f)
}

/** Sets or clears (rate === null) a user custom price override and returns the refreshed snapshot. */
export function setCustomPrice(model: string, rate: PriceRate | null): UsageSnapshot {
  const key = model.trim().toLowerCase()
  if (!key) return snapshot()
  if (rate === null) {
    delete customPrices[key]
  } else {
    const cleaned = cleanRate(rate)
    if (!cleaned) throw new Error('Invalid price rate')
    customPrices[key] = cleaned
  }
  tables = { ...tables, custom: customPrices }
  matches.clear()
  saveCustomPrices()
  const snap = snapshot()
  listener?.(snap)
  return snap
}

function loadLive(): { fetchedAt: number; models: PriceTable } | null {
  try {
    const j = JSON.parse(readFileSync(pricesFile(), 'utf8'))
    if (typeof j?.fetchedAt !== 'number' || !j.models) return null
    const models: PriceTable = {}
    for (const [k, v] of Object.entries(j.models)) {
      const r = cleanRate(v)
      if (r) models[k] = r
    }
    return { fetchedAt: j.fetchedAt, models }
  } catch {
    return null
  }
}

let pricesPending: Promise<void> | null = null

/** Fetches LiteLLM's table once a day (t3code does the same); failures keep the last table. */
function refreshPrices(): Promise<void> {
  if (pricesPending || (live && Date.now() - live.fetchedAt < PRICES_TTL)) return pricesPending ?? Promise.resolve()
  pricesPending = (async () => {
    try {
      const res = await net.fetch(LITELLM_URL, { headers: { Accept: 'application/json' } })
      if (!res.ok) return
      const models = parseLiteLLM(await res.json())
      if (Object.keys(models).length < 50) return // not the table we expect
      live = { fetchedAt: Date.now(), models }
      tables = { custom: customPrices, litellm: { ...parseLiteLLM(builtinPrices.litellm), ...models }, ccswitch }
      matches.clear()
      mkdirSync(app.getPath('userData'), { recursive: true })
      writeFileSync(pricesFile(), JSON.stringify(live))
      changed()
    } catch {
      /* offline: keep the last table */
    } finally {
      pricesPending = null
    }
  })()
  return pricesPending
}

function priceOf(model: string): Match | null {
  if (!matches.has(model)) matches.set(model, findRate(model, tables))
  return matches.get(model) ?? null
}

/** Bucket key of a request (or run) of `model` whose prompt was `prompt` tokens. */
function modelKey(model: string | null | undefined, prompt: number): string {
  const m = (model ?? '').trim()
  return isLong(priceOf(m)?.rate, prompt) ? `${m}|long` : m
}

function put(days: Days, ts: number, key: string, u: Partial<Bucket>): void {
  const d = (days[dayKey(ts)] ??= {})
  d[key] = add(d[key] ?? zero(), u)
}

const pad = (x: number): string => String(x).padStart(2, '0')
export const dayKey = (ts: number): string => {
  const d = new Date(ts)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** Stats as stored, plus the pre-3 formats (runs: day -> totals, no model). Set by load(). */
type Stored = Omit<Stats, 'version' | 'runs'> & { version: 1 | 2 | 3; runs: Record<ProfileId, Record<string, any>> }
let old: Stored | null = null
let stats: Stats = load()
let quotas: Record<ProfileId, AccountQuota> = loadQuota()
let backfill: UsageSnapshot['backfill'] = 'idle'
let listener: ((s: UsageSnapshot) => void) | null = null
let notifyTimer: ReturnType<typeof setTimeout> | null = null
let saveTimer: ReturnType<typeof setTimeout> | null = null

function load(): Stats {
  try {
    const s = JSON.parse(readFileSync(statsFile(), 'utf8')) as Stored
    if (s.version === 3)
      return { version: 3, runs: s.runs ?? {}, files: s.files ?? {}, legacy: s.legacy ?? {}, legacyUntil: s.legacyUntil ?? 0, legacyDone: s.legacyDone ?? true, limitedAt: s.limitedAt ?? {} }
    if (s.version === 1 || s.version === 2) old = s
  } catch {
    /* fresh */
  }
  return { version: 3, runs: {}, files: {}, legacy: {}, legacyUntil: 0, legacyDone: true, limitedAt: old?.limitedAt ?? {} }
}

/** Bucket of tokens recorded before models were (`?claude` …): priced only by the user's override. */
export const UNRECORDED = '?'
const unrecorded = (kind: string | undefined): string => UNRECORDED + (kind ?? '')

/**
 * v1/v2 -> v3 (lazily: needs the account list). Old totals have no model:
 *  - history files that still exist are re-read (with models) by the next backfill; those the CLI
 *    has since deleted keep their totals under `?<kind>`.
 *  - run totals go under `?<kind>`; the next backfill re-reads AgentSwitch's own sessions from the
 *    CLIs' logs (`legacy`, up to now) and drops the old totals of every day those logs cover.
 */
function migrate(): void {
  if (!old) return
  const kinds = new Map(listConfigs().map((c) => [c.id, c.kind as string]))
  // v1 costs summed cumulative session totals
  const v1 = old.version === 1
  const kindOf = (id: ProfileId): string | undefined => kinds.get(id) ?? /^(claude|codex|gemini|reasonix)-/.exec(id)?.[1]
  const convert = (id: ProfileId, days: Record<string, any>): Days => {
    const out: Days = {}
    for (const [k, v] of Object.entries(days ?? {})) out[k] = { [unrecorded(kindOf(id))]: add(zero(), { ...v, costUsd: v1 ? 0 : v?.costUsd }) }
    return out
  }
  for (const [id, days] of Object.entries(old.runs ?? {})) stats.runs[id] = convert(id, days)
  for (const [path, f] of Object.entries(old.files ?? {})) if (f?.days && !existsSync(path)) stats.files[path] = { ...f, days: convert(f.profileId, f.days) }
  stats.legacyUntil = Date.now()
  stats.legacyDone = false
  old = null
  persist()
}
function loadQuota(): Record<ProfileId, AccountQuota> {
  try {
    return JSON.parse(readFileSync(quotaFile(), 'utf8'))
  } catch {
    return {}
  }
}
function persist(): void {
  if (saveTimer) return
  saveTimer = setTimeout(() => {
    saveTimer = null
    try {
      mkdirSync(app.getPath('userData'), { recursive: true })
      writeFileSync(statsFile(), JSON.stringify(stats))
      writeFileSync(quotaFile(), JSON.stringify(quotas, null, 2))
    } catch {
      /* best effort */
    }
  }, 500)
}
function changed(): void {
  persist()
  if (notifyTimer) return
  notifyTimer = setTimeout(() => {
    notifyTimer = null
    listener?.(snapshot())
  }, 300)
}

export function onUsageChange(cb: (s: UsageSnapshot) => void): void {
  listener = cb
}

// ---- snapshot ---------------------------------------------------------------------------------

const quotaErrors: Record<ProfileId, string> = {}

function setQuotaError(profileId: ProfileId, msg: string | null): void {
  const clean = msg ? msg.replace(/^error:\s*/i, '').replace(/\s+/g, ' ').trim().slice(0, 260) : null
  if (!clean) {
    if (profileId in quotaErrors) {
      delete quotaErrors[profileId]
      changed()
    }
    return
  }
  if (quotaErrors[profileId] !== clean) {
    quotaErrors[profileId] = clean
    changed()
  }
}

export function snapshot(): UsageSnapshot {
  migrate()
  const now = new Date()
  const today = dayKey(now.getTime())
  const monday = new Date(now)
  monday.setHours(0, 0, 0, 0)
  monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7))
  const weekFrom = dayKey(monday.getTime())
  const accounts: Record<ProfileId, AccountUsage> = {}
  const per = new Map<ProfileId, Days[]>()
  for (const [id, days] of Object.entries(stats.runs)) per.set(id, [...(per.get(id) ?? []), days])
  for (const f of [...Object.values(stats.files), ...Object.values(stats.legacy)]) per.set(f.profileId, [...(per.get(f.profileId) ?? []), f.days])
  const configs = listConfigs()
  const kinds = new Map(configs.map((c) => [c.id, c.kind as string]))
  const modelOf = (key: string): string => (key.endsWith('|long') ? key.slice(0, -5) : key)
  // tokens recorded without a model (`?claude` …) are estimated at the engine's most used priced model
  const usedMost = new Map<string, { key: string; tokens: number }>()
  {
    const byKind = new Map<string, number>()
    for (const [id, list] of per)
      for (const days of list)
        for (const models of Object.values(days))
          for (const [key, b] of Object.entries(models)) {
            const m = modelOf(key)
            if (m.startsWith(UNRECORDED) || !priceOf(m)) continue
            const k = `${kinds.get(id) ?? ''}\n${m}`
            byKind.set(k, (byKind.get(k) ?? 0) + tokensOf(b))
          }
    for (const [k, tokens] of byKind) {
      const [kind, model] = k.split('\n')
      if (tokens > (usedMost.get(kind)?.tokens ?? 0)) usedMost.set(kind, { key: model, tokens })
    }
  }
  const rateOf = (model: string): (Match & { estimate?: boolean }) | null => {
    const m = priceOf(model)
    if (m || !model.startsWith(UNRECORDED)) return m
    const best = usedMost.get(model.slice(UNRECORDED.length))
    const e = best ? priceOf(best.key) : null
    return e ? { ...e, estimate: true } : null
  }
  // For historical Codex records with empty/`unknown` model, estimate using the account's configured model.
  const codexAccountRateCache = new Map<ProfileId, (Match & { estimate: true }) | null>()
  const codexFallbackRateFor = (c: ProfileConfig): (Match & { estimate: true }) | null => {
    if (codexAccountRateCache.has(c.id)) return codexAccountRateCache.get(c.id) ?? null
    const candidatesList = [
      c.defaultModel,
      readCodexConfig(expandHome(c.configDir)).model,
      usedMost.get('codex')?.key,
      codexDefaultModel()
    ]
    let matched: (Match & { estimate: true }) | null = null
    for (const candidate of candidatesList) {
      if (!candidate || isUnknownModelName(candidate)) continue
      const hit = priceOf(candidate)
      if (hit) {
        matched = { ...hit, estimate: true }
        break
      }
    }
    codexAccountRateCache.set(c.id, matched)
    return matched
  }
  const models: Record<string, ModelPrice> = {}
  const recordModelPrice = (displayModel: string, m: (Match & { estimate?: boolean }) | null): void => {
    if (models[displayModel]) return
    const def = m?.source === 'custom' ? findRate(displayModel, { litellm: tables.litellm, ccswitch: tables.ccswitch }) : null
    models[displayModel] = {
      key: m?.key ?? null,
      source: m?.estimate ? 'estimate' : (m?.source ?? null),
      rate: m?.rate ?? null,
      ...(def ? { defaultRate: def.rate } : {})
    }
  }
  const priced = (c: ProfileConfig, key: string, b: Bucket): { bucket: Bucket; model: string } => {
    const rawModel = modelOf(key)
    const long = rawModel !== key
    if (c.kind === 'codex' && (isUnknownModelName(rawModel) || rawModel === unrecorded('codex'))) {
      const m = (rawModel.startsWith(UNRECORDED) ? priceOf(rawModel) : null) ?? codexFallbackRateFor(c)
      const displayModel = m ? unrecorded('codex') : rawModel
      recordModelPrice(displayModel, m)
      return {
        model: displayModel,
        bucket: { ...b, costUsd: m ? costOf(b, m.rate, long) : b.costUsd, unpriced: m ? 0 : tokensOf(b) }
      }
    }
    const m = rateOf(rawModel)
    recordModelPrice(rawModel, m)
    return {
      model: rawModel,
      bucket: { ...b, costUsd: m ? costOf(b, m.rate, long) : b.costUsd, unpriced: m ? 0 : tokensOf(b) }
    }
  }
  const daily = new Map<string, DailyUsage>()
  for (const c of configs) {
    const a: AccountUsage = {
      today: zero(),
      week: zero(),
      total: zero(),
      quota: quotas[c.id] ?? null,
      quotaError: quotaErrors[c.id] ?? null,
      limitedAt: stats.limitedAt[c.id] ?? null
    }
    for (const days of per.get(c.id) ?? [])
      for (const [k, buckets] of Object.entries(days))
        for (const [key, b] of Object.entries(buckets)) {
          const { bucket: v, model } = priced(c, key, b)
          const id = `${k}\n${c.id}\n${model}`
          const { cacheWrite1h: _, ...t } = v
          daily.set(id, add(daily.get(id) ?? { ...zero(), day: k, profileId: c.id, model }, t))
          a.total = add(a.total, v)
          if (k >= weekFrom) a.week = add(a.week, v)
          if (k === today) a.today = add(a.today, v)
        }
    accounts[c.id] = a
  }
  return {
    accounts,
    backfill,
    claudeDays: CLAUDE_DAYS,
    daily: [...daily.values()].filter((d) => tokensOf(d) > 0 || d.runs > 0),
    models,
    customPrices: { ...customPrices },
    pricesAt: live ? dayKey(live.fetchedAt) : builtinPrices.fetchedAt,
    pricesLive: !!live,
    updatedAt: Date.now()
  }
}

// ---- live updates from runs -------------------------------------------------------------------

/**
 * One finished AgentSwitch step: the CLI's own usage report for `model` (the run's model as the
 * CLI reported it). Its long-context tier is judged by the prompt of the run's last request.
 */
export function recordRun(profileId: ProfileId, model: string | null, u: Usage | null): void {
  migrate()
  let effectiveModel = model
  if (isUnknownModelName(effectiveModel) && hasProfile(profileId)) {
    const cfg = getConfig(profileId)
    if (cfg.kind === 'codex') {
      effectiveModel = resolveCodexFallbackModel({ defaultModel: cfg.defaultModel, codexHome: expandHome(cfg.configDir) })
    }
  }
  const days = (stats.runs[profileId] ??= {})
  put(days, Date.now(), modelKey(effectiveModel, n(u?.context)), { ...(u ?? {}), runs: 1 })
  changed()
}

export function recordQuota(profileId: ProfileId, q: QuotaReport & { groups?: QuotaGroup[] }, source: AccountQuota['source'], at = Date.now()): void {
  const prev = quotas[profileId]
  if (prev && prev.fetchedAt > at) return
  quotas[profileId] = { ...q, fetchedAt: at, source }
  delete quotaErrors[profileId]
  if (q.limited) stats.limitedAt[profileId] = at
  changed()
}

export function recordLimited(profileId: ProfileId): void {
  stats.limitedAt[profileId] = Date.now()
  changed()
}

// ---- codex rate limits (rollout token_count) ------------------------------------------------------

function tail(path: string, bytes: number): string {
  const size = statSync(path).size
  const fd = openSync(path, 'r')
  try {
    const len = Math.min(size, bytes)
    const buf = Buffer.alloc(len)
    readSync(fd, buf, 0, len, size - len)
    return buf.toString('utf8')
  } finally {
    closeSync(fd)
  }
}

/** Newest rollout files first (sessions/YYYY/MM/DD/rollout-<ISO>-<id>.jsonl). */
function newestRollouts(home: string, max: number): string[] {
  const out: string[] = []
  const desc = (dir: string): string[] => {
    try {
      return readdirSync(dir).sort().reverse()
    } catch {
      return []
    }
  }
  const root = join(home, 'sessions')
  for (const y of desc(root))
    for (const m of desc(join(root, y)))
      for (const d of desc(join(root, y, m))) {
        for (const f of desc(join(root, y, m, d))) {
          if (f.endsWith('.jsonl')) out.push(join(root, y, m, d, f))
          if (out.length >= max) return out
        }
      }
  return out
}

function codexWindow(w: any): QuotaWindow | null {
  if (!w || typeof w.used_percent !== 'number') return null
  return { percent: w.used_percent, resetsAt: typeof w.resets_at === 'number' ? w.resets_at * 1000 : null, minutes: Number(w.window_minutes) || 0 }
}

/** Latest rate_limits any rollout of this CODEX_HOME recorded (zero API calls). */
export function refreshCodexQuota(profileId: ProfileId): boolean {
  if (!hasProfile(profileId) || !hasSubscriptionQuota(getConfig(profileId))) return false
  const home = expandHome(getConfig(profileId).configDir)
  let best: { at: number; rl: any } | null = null
  for (const f of newestRollouts(home, 8)) {
    let text = ''
    try {
      text = tail(f, 512 * 1024)
    } catch {
      continue
    }
    const lines = text.split('\n')
    for (let i = lines.length - 1; i >= 0; i--) {
      const l = lines[i]
      if (!l.includes('"rate_limits"')) continue
      try {
        const d = JSON.parse(l)
        const rl = d.payload?.rate_limits
        if (!rl) continue
        const at = toMs(d.timestamp)
        if (!best || at > best.at) best = { at, rl }
        break
      } catch {
        /* partial line */
      }
    }
  }
  if (!best) return false
  const wins = [codexWindow(best.rl.primary), codexWindow(best.rl.secondary)].filter((w): w is QuotaWindow => !!w)
  const five = wins.find((w) => w.minutes > 0 && w.minutes <= 600) ?? null
  const seven = wins.find((w) => w.minutes >= 1440) ?? null
  const limited = !!best.rl.rate_limit_reached_type || wins.some((w) => w.percent >= 100 && (!w.resetsAt || w.resetsAt > Date.now()))
  recordQuota(profileId, { fiveHour: five, sevenDay: seven, limited, plan: typeof best.rl.plan_type === 'string' ? best.rl.plan_type : null }, 'codex-rollout', best.at || Date.now())
  return true
}

// ---- codex live quota (`codex app-server` JSON-RPC `account/rateLimits/read`, zero tokens) ----

export const CODEX_APP_SERVER_PROBE_ARGS = [
  'app-server',
  '--disable',
  'plugins',
  '--disable',
  'remote_plugin',
  '--disable',
  'hooks',
  '--disable',
  'apps',
  '--disable',
  'memories',
  '--disable',
  'goals',
  '--disable',
  'daemon_auto_start',
  '--disable',
  'shell_snapshot',
  '--disable',
  'in_app_updates',
  '-c',
  'mcp_servers={}',
  '-c',
  'check_for_update_on_startup=false'
] as const

const codexPending = new Map<ProfileId, Promise<boolean>>()

export function refreshCodexLive(profileId: ProfileId): Promise<boolean> {
  if (!hasProfile(profileId) || !hasSubscriptionQuota(getConfig(profileId)) || !isLoggedIn(profileId)) return Promise.resolve(false)
  const running = codexPending.get(profileId)
  if (running) return running
  const p = new Promise<boolean>((resolve) => {
    const bin = kindBinaryPath('codex')
    if (!bin || !hasProfile(profileId)) return resolve(false)
    const authFile = join(expandHome(getConfig(profileId).configDir), 'auth.json')
    if (!existsSync(authFile)) return resolve(false)
    let probeHome: string | null = null
    let cleaned = false
    const cleanup = () => {
      if (cleaned || !probeHome) return
      cleaned = true
      try {
        rmSync(probeHome, { recursive: true, force: true })
      } catch {
        /* best effort */
      }
    }
    const startProc = () => {
      const env = buildSpawnSpec(profileId, 'run', undefined, false).env
      // Ephemeral CODEX_HOME with only auth.json linked keeps the user's real CODEX_HOME untouched
      // (no SQLite writes/locks, no config.toml MCP servers, no hooks.json, no plugin sync).
      probeHome = mkdtempSync(join(tmpdir(), 'agentswitch-codex-probe-'))
      symlinkSync(authFile, join(probeHome, 'auth.json'))
      return spawn(bin, [...CODEX_APP_SERVER_PROBE_ARGS], {
        env: { ...env, CODEX_HOME: probeHome },
        cwd: probeHome,
        stdio: ['pipe', 'pipe', 'ignore']
      })
    }
    let proc: ReturnType<typeof startProc>
    try {
      proc = startProc()
    } catch {
      cleanup()
      return resolve(false)
    }
    let done = false
    const finish = (ok: boolean) => {
      if (done) return
      done = true
      clearTimeout(timer)
      try {
        proc.kill()
      } catch {
        /* already exited */
      }
      resolve(ok)
    }
    const timer = setTimeout(() => finish(false), 15_000)
    proc.on('error', () => {
      finish(false)
      cleanup()
    })
    proc.on('close', () => {
      finish(false)
      cleanup()
    })

    const rl = createInterface({ input: proc.stdout })
    rl.on('line', (line) => {
      let msg: any
      try {
        msg = JSON.parse(line)
      } catch {
        return
      }
      if (msg.id === 1) {
        try {
          proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'initialized' }) + '\n')
          proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'account/rateLimits/read', params: {} }) + '\n')
        } catch {
          finish(false)
        }
        return
      }
      if (msg.id !== 2) return
      if (msg.error?.message) {
        setQuotaError(profileId, String(msg.error.message))
        return finish(false)
      }
      const r = msg.result?.rateLimits
      if (!r || typeof r !== 'object') return finish(false)
      const parseWin = (w: any): QuotaWindow | null => {
        if (!w || typeof w.usedPercent !== 'number') return null
        return {
          percent: w.usedPercent,
          resetsAt: typeof w.resetsAt === 'number' ? w.resetsAt * 1000 : null,
          minutes: Number(w.windowDurationMins) || 0
        }
      }
      const wins = [parseWin(r.primary), parseWin(r.secondary)].filter((w): w is QuotaWindow => !!w)
      if (!wins.length) return finish(false)
      const five = wins.find((w) => w.minutes > 0 && w.minutes <= 600) ?? null
      const seven = wins.find((w) => w.minutes >= 1440) ?? null
      const limited = !!r.rateLimitReachedType || wins.some((w) => w.percent >= 100 && (!w.resetsAt || w.resetsAt > Date.now()))
      recordQuota(profileId, { fiveHour: five, sevenDay: seven, limited, plan: typeof r.planType === 'string' ? r.planType : null }, 'codex-rpc')
      finish(true)
    })

    try {
      proc.stdin.write(
        JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { clientInfo: { name: 'agentswitch', version: '0.1.0' } } }) + '\n'
      )
    } catch {
      finish(false)
    }
  }).finally(() => codexPending.delete(profileId))
  codexPending.set(profileId, p)
  return p
}

// ---- claude live quota (OAuth `/api/oauth/usage` via local credentials, zero tokens) -----------

const claudePending = new Map<ProfileId, Promise<boolean>>()

function safeRealpath(p: string): string {
  try {
    return realpathSync(p)
  } catch {
    return p
  }
}

function readClaudeOauthToken(configDir: string): Promise<string | null> {
  const dir = safeRealpath(expandHome(configDir))
  const parseToken = (raw: string): string | null => {
    try {
      const tok = JSON.parse(raw)?.claudeAiOauth?.accessToken
      return typeof tok === 'string' && tok.length > 0 ? tok : null
    } catch {
      return null
    }
  }
  const credFile = join(dir, '.credentials.json')
  if (existsSync(credFile)) {
    try {
      const tok = parseToken(readFileSync(credFile, 'utf8'))
      if (tok) return Promise.resolve(tok)
    } catch {
      /* fall through to keychain */
    }
  }
  if (process.platform !== 'darwin') return Promise.resolve(null)
  const defaultDir = safeRealpath(join(realHome, '.claude'))
  const service =
    dir === defaultDir ? 'Claude Code-credentials' : `Claude Code-credentials-${createHash('sha256').update(dir).digest('hex').slice(0, 8)}`
  return new Promise((resolve) => {
    execFile('/usr/bin/security', ['find-generic-password', '-s', service, '-w'], { timeout: 5000 }, (err, stdout) => {
      if (err) return resolve(null)
      resolve(parseToken(String(stdout).trim()))
    })
  })
}

function fetchClaudeUsageJson(
  token: string,
  env: NodeJS.ProcessEnv
): Promise<{ status: number; text: string }> {
  const url = 'https://api.anthropic.com/api/oauth/usage'
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    'anthropic-beta': 'oauth-2025-04-20',
    'User-Agent': 'claude-code/2.1.0',
    Accept: 'application/json'
  }
  const hasEnvProxy = !!(env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy || env.ALL_PROXY || env.all_proxy)
  if (hasEnvProxy && process.platform !== 'win32') {
    return new Promise((resolve, reject) => {
      const args = [
        '-sS',
        '--max-time',
        '12',
        '-w',
        '\n%{http_code}',
        ...Object.entries(headers).flatMap(([k, v]) => ['-H', `${k}: ${v}`]),
        url
      ]
      execFile('/usr/bin/curl', args, { env, timeout: 15_000, maxBuffer: 2 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) return reject(new Error(String(stderr || err.message).trim()))
        const s = String(stdout)
        const idx = s.lastIndexOf('\n')
        const status = Number(idx >= 0 ? s.slice(idx + 1).trim() : '') || 0
        const text = idx >= 0 ? s.slice(0, idx) : s
        resolve({ status, text })
      })
    })
  }
  // No explicit proxy env: use Electron's net.fetch so macOS system proxy settings are honoured.
  return net.fetch(url, { headers, signal: AbortSignal.timeout(12_000) }).then(async (res) => ({
    status: res.status,
    text: await res.text()
  }))
}

export function refreshClaudeOauth(profileId: ProfileId): Promise<boolean> {
  if (hasProfile(profileId) && !hasSubscriptionQuota(getConfig(profileId))) return Promise.resolve(false)
  const running = claudePending.get(profileId)
  if (running) return running
  const p = (async (): Promise<boolean> => {
    if (!hasProfile(profileId)) return false
    const cfg = getConfig(profileId)
    const token = await readClaudeOauthToken(cfg.configDir)
    if (!token) return false
    let env: NodeJS.ProcessEnv = process.env
    try {
      env = buildSpawnSpec(profileId, 'run', undefined, false).env
    } catch {
      /* fallback to process.env */
    }
    try {
      const res = await fetchClaudeUsageJson(token, env)
      if (res.status < 200 || res.status >= 300) {
        let detail = `HTTP ${res.status}`
        try {
          const body: any = JSON.parse(res.text)
          const m = body?.error?.message || body?.message
          if (typeof m === 'string' && m.trim()) detail = `${detail}: ${m.trim()}`
        } catch {
          /* keep HTTP status */
        }
        setQuotaError(profileId, detail)
        return false
      }
      const d: any = JSON.parse(res.text)
      const parseWin = (w: any, minutes: number): QuotaWindow | null => {
        if (!w || typeof w.utilization !== 'number') return null
        const t = w.resets_at ? Date.parse(String(w.resets_at)) : NaN
        return { percent: Math.round(w.utilization * 10) / 10, resetsAt: isNaN(t) ? null : t, minutes }
      }
      const five = parseWin(d?.five_hour, 300)
      const seven = parseWin(d?.seven_day, 10080)
      if (!five && !seven) return false
      const limited = [five, seven].some((w) => !!w && w.percent >= 100 && (!w.resetsAt || w.resetsAt > Date.now()))
      recordQuota(profileId, { fiveHour: five, sevenDay: seven, limited, plan: null }, 'claude-oauth')
      return true
    } catch (e) {
      setQuotaError(profileId, e instanceof Error ? e.message : String(e))
      return false
    }
  })().finally(() => claudePending.delete(profileId))
  claudePending.set(profileId, p)
  return p
}

// ---- agy quota (`agy -p "/usage" --output-format json`: local command, no model call) -----------

export const AGY_AUTH_PROMPT_RE = /Authentication required|Please visit the URL to log in|Waiting for authentication/i

const agyPending = new Map<ProfileId, Promise<boolean>>()
const AGY_QUOTA_MAX_BYTES = 4 * 1024 * 1024

/** false: no data (API-key login exits 2, not logged in, older agy, parse failure). */
export function refreshAgyQuota(profileId: ProfileId): Promise<boolean> {
  if (!hasProfile(profileId) || !hasSubscriptionQuota(getConfig(profileId)) || !isLoggedIn(profileId)) return Promise.resolve(false)
  const running = agyPending.get(profileId)
  if (running) return running
  const p = new Promise<boolean>((resolve) => {
    const bin = kindBinaryPath('gemini')
    if (!bin || !hasProfile(profileId)) return resolve(false)
    let env: NodeJS.ProcessEnv
    try {
      env = buildSpawnSpec(profileId, 'run', undefined, false).env
    } catch {
      return resolve(false)
    }
    const proc = spawn(bin, ['-p', '/usage', '--output-format', 'json', '--log-file', '/dev/null'], {
      env: { ...env, AGY_CLI_DISABLE_AUTO_UPDATE: '1', SSH_CONNECTION: '1', SSH_TTY: '1' },
      cwd: tmpdir(),
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let stdout = ''
    let stderr = ''
    let done = false
    const finish = (ok: boolean) => {
      if (done) return
      done = true
      clearTimeout(timer)
      try {
        proc.kill()
      } catch {
        /* already exited */
      }
      resolve(ok)
    }
    const timer = setTimeout(() => {
      setQuotaError(profileId, 'agy /usage timed out')
      finish(false)
    }, 30_000)

    proc.stdout?.setEncoding('utf8')
    proc.stderr?.setEncoding('utf8')
    proc.stdout?.on('data', (chunk: string) => {
      if (stdout.length < AGY_QUOTA_MAX_BYTES) stdout += chunk.slice(0, AGY_QUOTA_MAX_BYTES - stdout.length)
    })
    proc.stderr?.on('data', (chunk: string) => {
      if (stderr.length < AGY_QUOTA_MAX_BYTES) stderr += chunk.slice(0, AGY_QUOTA_MAX_BYTES - stderr.length)
      if (AGY_AUTH_PROMPT_RE.test(stderr)) {
        setQuotaError(profileId, 'Authentication required')
        finish(false)
      }
    })
    proc.on('error', (err) => {
      setQuotaError(profileId, err.message)
      finish(false)
    })
    proc.on('close', (code) => {
      if (done) return
      clearTimeout(timer)
      if (code === 2) {
        // GEMINI_API_KEY: no account quota exists; keep local stats only
        setQuotaError(profileId, null)
        if (quotas[profileId]?.source === 'agy-usage') {
          delete quotas[profileId]
          changed()
        }
        return finish(false)
      }
      try {
        const jsonLine = stdout.trim().split('\n').filter((l) => l.startsWith('{')).pop()
        const d = jsonLine ? JSON.parse(jsonLine) : null
        if (d?.error) {
          setQuotaError(profileId, String(d.error))
          return finish(false)
        }
        const groups: QuotaGroup[] = (d?.command?.data?.groups ?? []).map((g: any): QuotaGroup => {
          const buckets: any[] = Array.isArray(g.buckets) ? g.buckets : []
          const win = (w: string, minutes: number): QuotaWindow | null => {
            const b = buckets.find((x) => x.window === w)
            if (!b || typeof b.remaining_fraction !== 'number') return null
            const t = Date.parse(String(b.reset_time ?? ''))
            return { percent: Math.round((1 - b.remaining_fraction) * 1000) / 10, resetsAt: isNaN(t) ? null : t, minutes }
          }
          const desc = String(g.description ?? '')
          const listed = /Models within this group:\s*(.+)$/i.exec(desc)?.[1]
          return {
            key: String(buckets[0]?.id ?? g.name ?? '').replace(/-(5h|weekly)$/, ''),
            name: String(g.name ?? ''),
            models: listed ? listed.split(',').map((x) => x.trim()).filter(Boolean) : [String(g.name ?? '')],
            fiveHour: win('5h', 300),
            sevenDay: win('weekly', 10080)
          }
        })
        if (!groups.length) {
          const fallback = stderr.trim().split('\n').find((l) => l.trim()) || (code ? `exit code ${code}` : null)
          if (fallback) setQuotaError(profileId, fallback)
          return finish(false)
        }
        const main = groups.find((g) => g.key === 'gemini') ?? groups[0]
        const limited = [main.fiveHour, main.sevenDay].some((w) => !!w && w.percent >= 100 && (!w.resetsAt || w.resetsAt > Date.now()))
        recordQuota(profileId, { fiveHour: main.fiveHour, sevenDay: main.sevenDay, limited, plan: null, groups }, 'agy-usage')
        finish(true)
      } catch (e) {
        const fallback = stderr.trim().split('\n').find((l) => l.trim()) || (e instanceof Error ? e.message : String(e))
        if (fallback) setQuotaError(profileId, fallback)
        finish(false)
      }
    })
  }).finally(() => agyPending.delete(profileId))
  agyPending.set(profileId, p)
  return p
}

// ---- history backfill ---------------------------------------------------------------------------

/** Messages in [since, cut] count (cut 0: no upper bound). */
const inWindow = (ts: number, since: number, cut: number): boolean => !!ts && ts >= since && (cut <= 0 || ts <= cut)

async function claudeFileDays(path: string, since: number, cut: number): Promise<Days> {
  // the same API message is split over several records with the same usage: keep one per id
  const msgs = new Map<string, { ts: number; model: string; u: any }>()
  const rl = createInterface({ input: createReadStream(path, { encoding: 'utf8' }), crlfDelay: Infinity })
  for await (const line of rl) {
    if (!line || line.startsWith('{"type":') || !line.includes('"usage"')) continue
    let d: any
    try {
      d = JSON.parse(line)
    } catch {
      continue
    }
    if (d.type !== 'assistant' || !d.message?.usage || d.message.model === '<synthetic>') continue
    const ts = toMs(d.timestamp)
    if (!inWindow(ts, since, cut)) continue
    msgs.set(String(d.message.id ?? d.uuid), { ts, model: String(d.message.model ?? ''), u: d.message.usage })
  }
  const days: Days = {}
  for (const { ts, model, u } of msgs.values()) {
    const prompt = n(u.input_tokens) + n(u.cache_read_input_tokens) + n(u.cache_creation_input_tokens)
    put(days, ts, modelKey(model, prompt), {
      input: u.input_tokens,
      output: u.output_tokens,
      cacheRead: u.cache_read_input_tokens,
      cacheWrite: u.cache_creation_input_tokens,
      cacheWrite1h: u.cache_creation?.ephemeral_1h_input_tokens
    })
  }
  return days
}

async function codexFileDays(path: string, since: number, cut: number): Promise<Days> {
  // token_count carries running totals: attribute each increase to its day and the turn's model
  const days: Days = {}
  let prev: any = null
  let model = ''
  const rl = createInterface({ input: createReadStream(path, { encoding: 'utf8' }), crlfDelay: Infinity })
  for await (const line of rl) {
    if (line.includes('"turn_context"')) {
      try {
        const d = JSON.parse(line)
        if (d.type === 'turn_context' && d.payload?.model) model = String(d.payload.model)
      } catch {
        /* partial line */
      }
      continue
    }
    if (!line.includes('"token_count"') || !line.includes('"total_token_usage"')) continue
    let d: any
    try {
      d = JSON.parse(line)
    } catch {
      continue
    }
    const t = d.payload?.info?.total_token_usage
    if (!t) continue
    const ts = toMs(d.timestamp)
    const delta = (k: string): number => Math.max(0, n(t[k]) - n(prev?.[k]))
    const inc = { input: delta('input_tokens'), cached: delta('cached_input_tokens'), cw: delta('cache_write_input_tokens'), out: delta('output_tokens'), rs: delta('reasoning_output_tokens') }
    prev = t
    if (!inWindow(ts, since, cut)) continue
    if (!inc.input && !inc.out) continue
    const prompt = n(d.payload.info.last_token_usage?.input_tokens)
    const cached = Math.min(inc.cached, inc.input)
    put(days, ts, modelKey(model, prompt), { input: inc.input - cached, cacheRead: cached, cacheWrite: inc.cw, output: inc.out, reasoning: inc.rs })
  }
  return days
}

/**
 * agy: conversations/<id>.db gen_metadata = one row per model call; protobuf 1.4 is its usage
 * (2 uncached input · 3 output incl. thinking · 5 cache read · 9 thinking), 1.19 the model
 * (e.g. gemini-3.8-flash-tiered). Reverse-engineered from agy 1.5.13 (checked: 3 == 9 + 10 on
 * every row); unknown layouts simply count nothing.
 * Time: 1.20 {last_step_index} -> steps.step_payload 5.1.1 (seconds).
 */
function agyFileDays(path: string, since: number, cut: number, fallbackTs: number): Days {
  const days: Days = {}
  const rows =
    withDb(path, (db) => ({
      gens: db.prepare('select data from gen_metadata order by idx').all() as { data: Uint8Array | null }[],
      steps: db.prepare('select idx, step_payload from steps').all() as { idx: number; step_payload: Uint8Array | null }[]
    })) ?? null
  if (!rows) return days
  const stepTime = new Map<number, number>()
  for (const s of rows.steps) {
    if (!s.step_payload) continue
    const sec = pbAll(Buffer.from(s.step_payload), [5, 1, 1])[0]
    if (typeof sec === 'number' && sec > 1e9) stepTime.set(s.idx, sec * 1000)
  }
  const int = (b: Buffer, f: number): number => {
    const v = pbAll(b, [1, 4, f])[0]
    return typeof v === 'number' ? v : 0
  }
  for (const g of rows.gens) {
    if (!g.data) continue
    const b = Buffer.from(g.data)
    let ts = fallbackTs
    for (const kv of pbAll(b, [1, 20])) {
      if (!Buffer.isBuffer(kv)) continue
      const k = pbAll(kv, [1])[0]
      const v = pbAll(kv, [2])[0]
      if (Buffer.isBuffer(k) && k.toString() === 'last_step_index' && Buffer.isBuffer(v)) ts = stepTime.get(Number(v.toString())) ?? ts
    }
    if (!inWindow(ts, since, cut)) continue
    const input = int(b, 2)
    const output = int(b, 3)
    if (!input && !output) continue
    const m = pbAll(b, [1, 19])[0]
    const model = Buffer.isBuffer(m) ? m.toString() : ''
    put(days, ts, modelKey(model, input + int(b, 5)), { input, output, cacheRead: int(b, 5), reasoning: int(b, 9) })
  }
  return days
}

/**
 * AgentSwitch's own sessions as the CLIs logged them, for the v3 upgrade (see migrate): each
 * thread's native session per account, from its import time if it was imported.
 */
function ownSessionFiles(): { path: string; profileId: ProfileId; kind: string; since: number }[] {
  const dir = join(app.getPath('userData'), 'threads')
  const out = new Map<string, { path: string; profileId: ProfileId; kind: string; since: number }>()
  let files: string[] = []
  try {
    files = readdirSync(dir)
  } catch {
    return []
  }
  for (const f of files) {
    let j: NativeSessions
    try {
      j = JSON.parse(readFileSync(join(dir, f), 'utf8'))
    } catch {
      continue
    }
    for (const [profileId, sid] of nativeSessionEntries(j)) {
      if (!sid || !hasProfile(profileId)) continue
      const cfg = getConfig(profileId)
      let path: string | null = null
      try {
        if (cfg.kind === 'claude') {
          const home = expandHome(cfg.configDir)
          path = claudeSessionLog(cfg.configDir === '~' || home === expandHome('~') ? expandHome('~/.claude') : home, sid)
        } else if (cfg.kind === 'codex') path = codexRollout(cfg, sid)
        else if (cfg.kind === 'gemini') path = agyConversationDb(cfg, sid)
      } catch {
        path = null
      }
      if (!path || !existsSync(path)) continue
      // accounts sharing one session store (symlinked projects/) list the same file: count it once
      path = safeRealpath(path)
      const since = (j.imported ?? []).includes(sid) ? n(j.importedAt?.[sid]) : 0
      const prev = out.get(path)
      out.set(path, { path, profileId: prev?.profileId ?? profileId, kind: cfg.kind, since: prev ? Math.min(prev.since, since) : since })
    }
  }
  return [...out.values()]
}

async function readLegacy(): Promise<void> {
  const since30 = Date.now() - CLAUDE_DAYS * DAY
  for (const f of ownSessionFiles()) {
    try {
      const st = statSync(f.path)
      const days =
        f.kind === 'claude'
          ? await claudeFileDays(f.path, Math.max(f.since, since30), stats.legacyUntil)
          : f.kind === 'codex'
            ? await codexFileDays(f.path, f.since, stats.legacyUntil)
            : agyFileDays(f.path, f.since, stats.legacyUntil, st.mtimeMs)
      stats.legacy[f.path] = { mtime: st.mtimeMs, size: st.size, profileId: f.profileId, days }
      changed()
    } catch {
      /* unreadable: skip */
    }
    await new Promise((r) => setImmediate(r))
  }
  // the logs replace the old run totals of the days they cover (run counts stay)
  const covered = new Set<string>()
  for (const f of Object.values(stats.legacy)) for (const [day, models] of Object.entries(f.days)) if (Object.values(models).some((b) => tokensOf(b) > 0)) covered.add(`${f.profileId}|${day}`)
  for (const [id, days] of Object.entries(stats.runs))
    for (const [day, models] of Object.entries(days))
      for (const [key, b] of Object.entries(models))
        if (key.startsWith(UNRECORDED) && covered.has(`${id}|${day}`)) models[key] = { ...zero(), runs: b.runs }
  stats.legacyDone = true
  changed()
}

let backfillRunning: Promise<void> | null = null

/** Incremental: only files whose size/mtime changed are re-read. Never blocks a run. */
export function runBackfill(): Promise<void> {
  if (backfillRunning) return backfillRunning
  backfillRunning = (async () => {
    backfill = 'running'
    changed()
    try {
      migrate()
      if (!stats.legacyDone) await readLegacy()
      const entries = listHistory(true)
      const cuts = importedCutoffs()
      const since = Date.now() - CLAUDE_DAYS * DAY
      const seen = new Set<string>()
      const pathOf = (e: (typeof entries)[number]): string | null => {
        if (e.kind === 'claude') return claudePath(e)
        if (e.kind === 'codex') return rolloutPaths.get(e.nativeId) ?? null
        if (e.kind !== 'gemini') return null
        const cfg = hasProfile(e.profileId) ? getConfig(e.profileId) : null
        return cfg ? agyConversationDb(cfg, e.nativeId) : null
      }
      for (const e of entries) {
        const path = pathOf(e)
        if (!path || !existsSync(path)) continue
        let st: { mtimeMs: number; size: number }
        try {
          const f = statSync(path)
          st = { mtimeMs: f.mtimeMs, size: f.size }
          // agy writes through the WAL: its mtime/size reflect new turns before a checkpoint
          if (e.kind === 'gemini' && existsSync(path + '-wal')) {
            const w = statSync(path + '-wal')
            st = { mtimeMs: Math.max(f.mtimeMs, w.mtimeMs), size: f.size + w.size }
          }
        } catch {
          continue
        }
        if (e.kind === 'claude' && st.mtimeMs < since) continue
        seen.add(path)
        const prev = stats.files[path]
        if (prev && prev.mtime === st.mtimeMs && prev.size === st.size && prev.profileId === e.profileId) continue
        const cut = cuts.get(e.nativeId) ?? 0
        try {
          const days = e.kind === 'claude' ? await claudeFileDays(path, since, cut) : e.kind === 'codex' ? await codexFileDays(path, 0, cut) : agyFileDays(path, 0, cut, e.updatedAt || st.mtimeMs)
          stats.files[path] = { mtime: st.mtimeMs, size: st.size, profileId: e.profileId, days }
          changed()
        } catch {
          /* unreadable file: skip */
        }
        await new Promise((r) => setImmediate(r))
      }
      // sessions that became AgentSwitch's own (or vanished from the list) no longer count as history
      const listed = new Set(entries.map(pathOf).filter(Boolean))
      for (const p of Object.keys(stats.files)) if (!listed.has(p) && !seen.has(p) && existsSync(p)) delete stats.files[p]
    } finally {
      backfill = 'done'
      backfillRunning = null
      changed()
    }
  })()
  return backfillRunning
}

// ---- refresh ------------------------------------------------------------------------------------

/**
 * Live zero-token refresh for all three CLIs:
 *  - codex:  `codex app-server` `account/rateLimits/read` (falls back to local rollout logs)
 *  - gemini: `agy -p "/usage" --output-format json`
 *  - claude: OAuth `/api/oauth/usage` via local credentials; when probe=true, accounts whose
 *            OAuth token expired or is unavailable fall back to a tiny haiku message.
 */
/** Trigger provider-specific post-run quota refresh (kept inside the usage/quota adapter layer). */
export function refreshPostRunQuota(cfg: { id: ProfileId; kind: ProfileKind }, ok: boolean): void {
  if (cfg.kind === 'codex') refreshCodexQuota(cfg.id)
  else if (cfg.kind === 'gemini' && ok) void refreshAgyQuota(cfg.id)
}

export async function refreshUsage(probe: boolean): Promise<UsageSnapshot> {
  // API-key accounts have no subscription quota, and a probe would spend the user's credits.
  const configs = listConfigs().filter(hasSubscriptionQuota)
  const codexTask = Promise.all(
    configs
      .filter((c) => c.kind === 'codex')
      .map(async (c) => {
        const ok = isLoggedIn(c.id) ? await refreshCodexLive(c.id) : false
        if (!ok) refreshCodexQuota(c.id)
      })
  )
  const agyTask = Promise.all(configs.filter((c) => c.kind === 'gemini' && isLoggedIn(c.id)).map((c) => refreshAgyQuota(c.id)))
  const claudeTask = Promise.all(
    configs
      .filter((c) => c.kind === 'claude' && isLoggedIn(c.id))
      .map(async (c) => {
        const ok = await refreshClaudeOauth(c.id)
        if (ok || !probe) return
        const dir = tmpdir()
        let usage: Usage | null = null
        const h = runAgent(
          { cfg: { ...c, autoApprove: 'edits' }, model: 'haiku', prompt: 'Reply with exactly: OK', system: null, cwd: dir, images: [], resume: null, outDir: dir, ephemeralProbe: true },
          (e) => {
            if (e.t === 'quota') recordQuota(c.id, e.quota, 'claude-stream')
            if (e.t === 'usage') usage = { ...(usage ?? {}), ...e.usage }
            if (e.t === 'rate_limited') recordLimited(c.id)
          },
          () => {}
        )
        const r = await h.done
        recordRun(c.id, r.model ?? 'haiku', usage)
      })
  )
  await Promise.all([codexTask, agyTask, claudeTask, refreshPrices()])
  void runBackfill()
  changed()
  return snapshot()
}

/** Startup: passive quota checks + backfill in the background, after the window is up. */
export function startUsage(): void {
  for (const c of listConfigs()) if (c.kind === 'codex') refreshCodexQuota(c.id)
  setTimeout(() => {
    for (const c of listConfigs()) {
      if (!hasSubscriptionQuota(c) || !isLoggedIn(c.id)) continue
      // Skip `agy -p /usage` on startup: agy boots its full language server and user MCPs.
      if (c.kind === 'codex') void refreshCodexLive(c.id)
      else if (c.kind === 'claude') void refreshClaudeOauth(c.id)
    }
  }, 4000)
  setTimeout(() => void runBackfill(), 8000)
  setTimeout(() => void refreshPrices(), 10_000)
  setInterval(() => void refreshPrices(), 6 * 3600_000)
  setInterval(() => void runBackfill(), 30 * 60_000)
}
