import { app, net } from 'electron'
import { closeSync, createReadStream, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import type { AccountQuota, AccountUsage, DailyUsage, ModelPrice, OnlinePriceSource, PriceRate, ProfileConfig, ProfileId, ProfileKind, QuotaErrorKind, QuotaGroup, QuotaReport, QuotaWindow, Usage, UsageSnapshot, UsageTotals } from '@shared/types'
import { codexRolloutEventModel, runAgent } from './agentRunner'
import { codexConfigDir, codexDefaultModel, readCodexConfig, resolveRunModel } from './models'
import { cleanModelName } from '@shared/modelSpec'
import { agyConversationDb, claudePath, codexRollout, importedCutoffs, listHistory, pbAll, rolloutPaths, toMs, withDb } from './history'
import builtinPrices from './prices.builtin.json'
import { cleanRate, costOf, findRate, isLong, mergePriceTables, parseLiteLLM, PRICE_SOURCES, refreshPriceCache, type Match, type PriceCache, type PriceCacheEntry, type PriceFetch, type PriceTable, type PriceTables } from './pricing'
import { claudeSessionLog } from './usageDelta'
import { buildSpawnSpec, claudeCredentialService, clearProfileKeychainCache, getConfig, hasProfile, isLoggedIn, kindBinaryPath, listConfigs, resolveProfileDir, safeRealpath } from './profiles'
import { hasSubscriptionQuota } from './apiKey'
import { getBaseEnv } from './shellEnv'
import { authExpired, oauthCredentialFile, OAUTH_AUTH_ERROR_RE, quotaFailure, refreshOAuthCredentials, runWithOAuth401Recovery, type OAuthCredentialStore, type QuotaAttempt, type RefreshResult } from './oauthQuotaAuth'
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
 * Stats: userData/usage-stats.json · quota: userData/quota-cache.json · prices: userData/prices-cache.v2.json.
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
  modelAttribution?: number
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
const pricesFile = (): string => join(app.getPath('userData'), 'prices-cache.v2.json')
const legacyPricesFile = (): string => join(app.getPath('userData'), 'prices-litellm.json')
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

const PRICES_TTL = DAY

const ccswitch: PriceTable = {}
for (const [k, v] of Object.entries(builtinPrices.ccswitch)) {
  const r = cleanRate(v)
  if (r) ccswitch[k] = r
}
let live = loadPriceCache()
const customPrices = loadCustomPrices()
const mergedPrices = (cache: PriceCache) => mergePriceTables(Object.fromEntries(Object.entries(cache).map(([key, entry]) => [key, entry.models])))
const tables: PriceTables = { custom: customPrices, online: mergedPrices(live), litellm: parseLiteLLM(builtinPrices.litellm), ccswitch }
const matches = new Map<string, Match | null>()

function loadCustomPrices(): PriceTable {
  try {
    const j = JSON.parse(readFileSync(customPricesFile(), 'utf8'))
    if (!j || typeof j !== 'object' || Array.isArray(j)) return Object.create(null)
    const out: PriceTable = Object.create(null)
    for (const [k, v] of Object.entries(j as Record<string, unknown>)) {
      const key = k.trim().toLowerCase()
      const r = cleanRate(v)
      if (key && r) out[key] = r
    }
    return out
  } catch {
    return Object.create(null)
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
  matches.clear()
  saveCustomPrices()
  const snap = snapshot()
  listener?.(snap)
  return snap
}

function readCachedPrices(value: any): PriceCacheEntry | null {
  if (!Number.isFinite(value?.fetchedAt) || !value.models || typeof value.models !== 'object') return null
  const models: PriceTable = Object.create(null)
  for (const [key, raw] of Object.entries(value.models)) {
    const rate = cleanRate(raw)
    if (rate) models[key] = rate
  }
  return Object.keys(models).length ? {
    models,
    fetchedAt: value.fetchedAt,
    etag: typeof value.etag === 'string' ? value.etag : undefined,
    lastModified: typeof value.lastModified === 'string' ? value.lastModified : undefined
  } : null
}

function loadPriceCache(): PriceCache {
  try {
    const raw = JSON.parse(readFileSync(pricesFile(), 'utf8'))
    const cache: PriceCache = {}
    for (const key of Object.keys(PRICE_SOURCES) as OnlinePriceSource[]) {
      const entry = readCachedPrices(raw?.[key])
      if (entry) cache[key] = entry
    }
    if (Object.keys(cache).length) return cache
  } catch {
    // Older installations may have a LiteLLM-only cache.
  }
  try {
    const entry = readCachedPrices(JSON.parse(readFileSync(legacyPricesFile(), 'utf8')))
    return entry ? { litellm: entry } : {}
  } catch {
    return {}
  }
}

let pricesPending: { request: Promise<UsageSnapshot>; force: boolean } | null = null

export function syncPrices(force = false): Promise<UsageSnapshot> {
  if (pricesPending) {
    return !force || pricesPending.force ? pricesPending.request : pricesPending.request.then(() => syncPrices(true))
  }
  const request = refreshPriceCache(live, fetchPriceJson, PRICES_TTL, force).then((cache) => {
    const updated = cache !== live
    if (updated) {
      live = cache
      tables.online = mergedPrices(cache)
      matches.clear()
      try {
        const file = pricesFile()
        mkdirSync(app.getPath('userData'), { recursive: true })
        const tmp = `${file}.${process.pid}.tmp`
        writeFileSync(tmp, JSON.stringify(cache), 'utf8')
        renameSync(tmp, file)
      } catch {
        // The online prices also remain available in memory.
      }
    }
    const result = snapshot()
    if (updated) listener?.(result)
    return result
  }).finally(() => { pricesPending = null })
  pricesPending = { request, force }
  return request
}

const fetchPriceJson: PriceFetch = async (url, headers) => {
  let env: NodeJS.ProcessEnv = { ...process.env }
  try {
    env = { ...getBaseEnv(), ...env }
  } catch {
    // Login-shell environment may still be initializing.
  }
  const proxy = env.https_proxy || env.HTTPS_PROXY || env.http_proxy || env.HTTP_PROXY || env.all_proxy || env.ALL_PROXY
  if (proxy) {
    return new Promise((resolve, reject) => {
      const args = [
        '--disable', '--silent', '--show-error', '--max-time', '8', '--compressed', '--dump-header', '-',
        ...Object.entries(headers).flatMap(([key, value]) => ['--header', `${key}: ${value}`]), url
      ]
      const curl = process.platform === 'win32' ? 'curl.exe' : '/usr/bin/curl'
      execFile(curl, args, { env: { ...env, https_proxy: proxy }, timeout: 8000, maxBuffer: 24 * 1024 * 1024 }, (error, stdout) => {
        if (error) return reject(error)
        // curl can print a proxy CONNECT response before the origin response.
        let remaining = stdout
        let block: RegExpExecArray | null
        let response: { status: number; headers: Record<string, string> } | null = null
        while ((block = /^HTTP\/\S+ (\d{3})[\s\S]*?\r?\n\r?\n/.exec(remaining))) {
          response = { status: Number(block[1]), headers: parseCurlHeaderBlock(block[0]) }
          remaining = remaining.slice(block[0].length)
        }
        if (!response) return reject(new Error('Missing price response headers'))
        resolve({ ...response, text: remaining })
      })
    })
  }
  const response = await net.fetch(url, { headers, signal: AbortSignal.timeout(8000), credentials: 'omit', cache: 'no-store' })
  return { status: response.status, text: await response.text(), headers: Object.fromEntries(response.headers) }
}

function priceOf(model: string): Match | null {
  if (!matches.has(model)) matches.set(model, findRate(model, tables))
  return matches.get(model) ?? null
}

/** Computes USD cost for a single request using the active custom, cached and built-in price tables. */
export function priceForRequest(
  model: string | null | undefined,
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; cacheWrite1h?: number },
  fallbackCostUsd?: number | null
): { model: string; costUsd: number | null } {
  const m = cleanModelName(model) ?? ''
  const hit = m ? priceOf(m) : null
  if (hit) {
    const prompt = n(tokens.input) + n(tokens.cacheRead) + n(tokens.cacheWrite)
    const long = isLong(hit.rate, prompt)
    return { model: m, costUsd: costOf(tokens, hit.rate, long) }
  }
  const fb = typeof fallbackCostUsd === 'number' && Number.isFinite(fallbackCostUsd) && fallbackCostUsd >= 0 ? fallbackCostUsd : null
  return { model: m, costUsd: fb }
}

/** Bucket key of a request (or run) of `model` whose prompt was `prompt` tokens. */
function modelKey(model: string | null | undefined, prompt: number): string {
  const m = cleanModelName(model) ?? ''
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

export interface QuotaErrorInfo {
  kind: QuotaErrorKind
  message: string
  resetAt: number | null
}

const RATE_LIMIT_RE =
  /\b429\b|rate[_\s-]*limit|too many requests|quota\s*(exceeded|exhausted|reached|limit)|resource_exhausted|usage\s*limit|hit\s+your\s+limit|limit\s+reached|credit\s+balance/i

function cleanErrorMessage(msg: string): string {
  return msg.replace(/^error:\s*/i, '').replace(/\s+/g, ' ').trim().slice(0, 260)
}

function parseDurationMs(raw: string): number | null {
  let total = 0
  let matched = false
  const re = /(\d+(?:\.\d+)?)\s*(ms|milliseconds?|s|sec(?:ond)?s?|m|min(?:ute)?s?|h|hours?|d|days?)/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(raw))) {
    const v = Number(m[1])
    if (!Number.isFinite(v) || v < 0) continue
    const u = m[2].toLowerCase()
    if (u === 'ms' || u.startsWith('milli')) total += v
    else if (u.startsWith('s')) total += v * 1000
    else if (u.startsWith('m')) total += v * 60_000
    else if (u.startsWith('h')) total += v * 3600_000
    else if (u.startsWith('d')) total += v * DAY
    matched = true
  }
  return matched && total > 0 ? Math.round(total) : null
}

function parseResetValue(raw: unknown, now: number, treatNumericAsDelta: boolean): number | null {
  if (raw === null || raw === undefined || raw === '') return null
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) {
    if (treatNumericAsDelta) return now + Math.round(raw * 1000)
    return raw < 1e12 ? Math.round(raw * 1000) : Math.round(raw)
  }
  const s = String(raw).trim()
  if (!s) return null
  if (/^\d+(?:\.\d+)?$/.test(s)) {
    const num = Number(s)
    if (!Number.isFinite(num) || num <= 0) return null
    if (treatNumericAsDelta) return now + Math.round(num * 1000)
    return num < 1e12 ? Math.round(num * 1000) : Math.round(num)
  }
  const dur = parseDurationMs(s)
  if (dur !== null && !/[TZ]|\d{4}-\d{2}-\d{2}|GMT/i.test(s)) return now + dur
  const parsed = Date.parse(s)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

export function classifyQuotaError(input: {
  status?: number | null
  message?: string | null
  body?: unknown
  headers?: Record<string, string | null | undefined>
  now?: number
}): QuotaErrorInfo | null {
  const now = input.now ?? Date.now()
  const rawMsg = input.message ?? (input.status ? `HTTP ${input.status}` : '')
  const message = cleanErrorMessage(rawMsg)
  if (!message) return null

  const bodyObj = input.body && typeof input.body === 'object' ? (input.body as Record<string, any>) : null
  const bodyErr = bodyObj?.error && typeof bodyObj.error === 'object' ? (bodyObj.error as Record<string, any>) : null
  const bodyData = bodyObj?.data && typeof bodyObj.data === 'object' ? (bodyObj.data as Record<string, any>) : null
  const codeHints = [bodyObj?.code, bodyObj?.type, bodyObj?.status, bodyErr?.code, bodyErr?.type, bodyErr?.status, bodyData?.code]
    .filter((v) => v !== undefined && v !== null)
    .map((v) => String(v))
    .join(' ')
  const statusHint = /\b(?:HTTP(?:\/[\d.]+)?|status(?: code)?)[:\s]+([45]\d{2})\b/i.exec(rawMsg)?.[1]
  const bodyStatus = [bodyErr?.code, bodyErr?.status, bodyObj?.code, bodyObj?.status, bodyData?.code]
    .map(Number).find((value) => value >= 400 && value < 600)
  const status = input.status ?? bodyStatus ?? (statusHint ? Number(statusHint) : 0)
  const serverError = status >= 500
  const isAuth = status === 401 || !serverError &&
    OAUTH_AUTH_ERROR_RE.test([rawMsg, codeHints, bodyObj?.error, bodyErr?.message, bodyData?.message].join(' '))
  const isRateLimited = status === 429 || /\b429\b/.test(codeHints) ||
    (!isAuth && !serverError && (RATE_LIMIT_RE.test(rawMsg) || RATE_LIMIT_RE.test(codeHints)))

  let resetAt: number | null = null
  const hdrs: Record<string, string> = {}
  for (const [k, v] of Object.entries(input.headers ?? {})) {
    if (typeof v === 'string' && v.trim()) hdrs[k.toLowerCase()] = v.trim()
  }
  const headerChecks: [string, boolean][] = [
    ['retry-after', true],
    ['anthropic-ratelimit-unified-reset', false],
    ['anthropic-ratelimit-unified-5h-reset', false],
    ['anthropic-ratelimit-unified-7d-reset', false],
    ['x-ratelimit-reset', false],
    ['x-ratelimit-reset-requests', true],
    ['x-ratelimit-reset-tokens', true]
  ]
  for (const [h, isDelta] of headerChecks) {
    if (!hdrs[h]) continue
    const ts = parseResetValue(hdrs[h], now, isDelta)
    if (ts && ts > now) {
      resetAt = ts
      break
    }
  }
  if (!resetAt) {
    const sources = [bodyObj, bodyErr, bodyData].filter((o): o is Record<string, any> => !!o)
    const fieldChecks: [string, boolean, boolean][] = [
      ['resets_at', false, false],
      ['resetsAt', false, false],
      ['reset_at', false, false],
      ['resetAt', false, false],
      ['reset_time', false, false],
      ['resetTime', false, false],
      ['retry_after', true, false],
      ['retryAfter', true, false],
      ['retry_after_ms', true, true],
      ['retryAfterMs', true, true]
    ]
    for (const src of sources) {
      for (const [field, isDelta, isMs] of fieldChecks) {
        const val = src[field]
        if (val === undefined || val === null) continue
        const ts = isMs && typeof val === 'number' && val > 0 ? now + Math.round(val) : parseResetValue(val, now, isDelta)
        if (ts && ts > now) {
          resetAt = ts
          break
        }
      }
      if (resetAt) break
    }
  }
  if (!resetAt && isRateLimited) {
    const iso = /\b(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2}))\b/.exec(message)?.[1]
    if (iso) {
      const ts = Date.parse(iso)
      if (Number.isFinite(ts) && ts > now) resetAt = ts
    }
  }
  if (!resetAt && isRateLimited) {
    const rel = /(?:retry|try\s+again|reset(?:s)?)\s+(?:after|in)\s+([^.,;\n]+)/i.exec(message)?.[1]
    if (rel) {
      const dur = parseDurationMs(rel)
      if (dur) resetAt = now + dur
    }
  }

  return { kind: isRateLimited ? 'rate_limited' : isAuth ? 'auth_expired' : 'error', message, resetAt }
}

const quotaErrors: Record<ProfileId, QuotaErrorInfo> = {}

function setQuotaError(profileId: ProfileId, err: string | QuotaErrorInfo | null): void {
  const info: QuotaErrorInfo | null = !err
    ? null
    : typeof err === 'string'
      ? classifyQuotaError({ message: err })
      : { ...err, message: cleanErrorMessage(err.message) }
  if (!info || !info.message) {
    if (profileId in quotaErrors) {
      delete quotaErrors[profileId]
      changed()
    }
    return
  }
  if (info.kind === 'rate_limited') stats.limitedAt[profileId] = Date.now()
  const prev = quotaErrors[profileId]
  if (!prev || prev.kind !== info.kind || prev.message !== info.message || prev.resetAt !== info.resetAt) {
    quotaErrors[profileId] = info
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
      readCodexConfig(codexConfigDir(c)).model,
      usedMost.get('codex')?.key,
      codexDefaultModel()
    ]
    let matched: (Match & { estimate: true }) | null = null
    for (const candidate of candidatesList) {
      if (!cleanModelName(candidate)) continue
      const hit = candidate ? priceOf(candidate) : null
      if (hit) {
        matched = { ...hit, estimate: true }
        break
      }
    }
    codexAccountRateCache.set(c.id, matched)
    return matched
  }
  const models: Record<string, ModelPrice> = Object.create(null)
  const recordModelPrice = (displayModel: string, m: (Match & { estimate?: boolean }) | null): void => {
    if (models[displayModel]) return
    const def = m?.source === 'custom' ? findRate(displayModel, { online: tables.online, litellm: tables.litellm, ccswitch: tables.ccswitch }) : null
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
    if (c.kind === 'codex' && (!cleanModelName(rawModel) || rawModel === unrecorded('codex'))) {
      const m = (rawModel.startsWith(UNRECORDED) ? priceOf(rawModel) : null) ?? codexFallbackRateFor(c)
      const displayModel = unrecorded('codex')
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
    const err = quotaErrors[c.id]
    const a: AccountUsage = {
      today: zero(),
      week: zero(),
      total: zero(),
      quota: quotas[c.id] ?? null,
      quotaError: err?.message ?? null,
      quotaErrorKind: err?.kind ?? null,
      quotaErrorResetAt: err?.resetAt ?? null,
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
  const pricesSources = Object.keys(live) as OnlinePriceSource[]
  const pricesSyncedAt = pricesSources.length ? Math.max(...Object.values(live).map((entry) => entry.fetchedAt)) : null
  return {
    accounts,
    backfill,
    claudeDays: CLAUDE_DAYS,
    daily: [...daily.values()].filter((d) => tokensOf(d) > 0 || d.runs > 0),
    models,
    customPrices: { ...customPrices },
    pricesAt: pricesSyncedAt === null ? builtinPrices.fetchedAt : dayKey(pricesSyncedAt),
    pricesLive: pricesSyncedAt !== null,
    pricesSyncedAt,
    pricesSources,
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
  const effectiveModel = cleanModelName(model) ?? (hasProfile(profileId) ? resolveRunModel(getConfig(profileId)) : null)
  const days = (stats.runs[profileId] ??= {})
  put(days, Date.now(), modelKey(effectiveModel, n(u?.context)), { ...(u ?? {}), runs: 1 })
  changed()
}

export function recordQuota(
  profileId: ProfileId,
  q: QuotaReport & { groups?: QuotaGroup[] },
  source: AccountQuota['source'],
  at = Date.now(),
  opts?: { preserveError?: boolean }
): void {
  const prev = quotas[profileId]
  if (prev && prev.fetchedAt >= at) return
  quotas[profileId] = { ...q, fetchedAt: at, source }
  if (!opts?.preserveError && quotaErrors[profileId]?.kind !== 'auth_expired') delete quotaErrors[profileId]
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
export function refreshCodexQuota(profileId: ProfileId, preserveError = false): boolean {
  if (!hasProfile(profileId) || quotaPaused.has(profileId) || !hasSubscriptionQuota(getConfig(profileId))) return false
  const home = resolveProfileDir(getConfig(profileId))
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
  if (!best || best.at < (codexRolloutCutoff.get(profileId) ?? 0)) return false
  const wins = [codexWindow(best.rl.primary), codexWindow(best.rl.secondary)].filter((w): w is QuotaWindow => !!w)
  const five = wins.find((w) => w.minutes > 0 && w.minutes <= 600) ?? null
  const seven = wins.find((w) => w.minutes >= 1440) ?? null
  const limited = !!best.rl.rate_limit_reached_type || wins.some((w) => w.percent >= 100 && (!w.resetsAt || w.resetsAt > Date.now()))
  recordQuota(
    profileId,
    { fiveHour: five, sevenDay: seven, limited, plan: typeof best.rl.plan_type === 'string' ? best.rl.plan_type : null },
    'codex-rollout',
    best.at || Date.now(),
    { preserveError }
  )
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

type QuotaData = { report: QuotaReport & { groups?: QuotaGroup[] }; source: AccountQuota['source'] } | 'api-key' | null

const quotaPending = new Map<ProfileId, { controller: AbortController; request: Promise<boolean> }>()
const claudeProbes = new Map<ProfileId, ReturnType<typeof runAgent>>()
const quotaPaused = new Set<ProfileId>()
export function pauseAccountQuota(id: ProfileId, paused: boolean): void {
  if (paused) quotaPaused.add(id)
  else quotaPaused.delete(id)
}
const codexRolloutCutoff = new Map<ProfileId, number>()

export function clearAccountUsageCache(id: ProfileId, opts?: { keepStats?: boolean }): void {
  quotaPending.get(id)?.controller.abort()
  quotaPending.delete(id)
  claudeProbes.get(id)?.kill(true)
  claudeProbes.delete(id)
  delete quotas[id]
  delete quotaErrors[id]
  delete stats.limitedAt[id]
  if (opts?.keepStats) {
    if (hasProfile(id) && getConfig(id).kind === 'codex') codexRolloutCutoff.set(id, Date.now())
  } else {
    codexRolloutCutoff.delete(id)
    delete stats.runs[id]
    if (old?.runs) delete old.runs[id]
    for (const files of [stats.files, stats.legacy, old?.files ?? {}]) {
      for (const [path, entry] of Object.entries(files)) if (entry.profileId === id) delete files[path]
    }
  }
  mkdirSync(app.getPath('userData'), { recursive: true })
  writeFileSync(quotaFile(), JSON.stringify(quotas, null, 2))
  // Convert legacy stats before writing the current format.
  migrate()
  writeFileSync(statsFile(), JSON.stringify(stats))
  changed()
}

function refreshOAuthQuota(id: ProfileId, kind: ProfileKind, run: (cfg: ProfileConfig, signal: AbortSignal) => Promise<QuotaAttempt<QuotaData>>): Promise<boolean> {
  if (!hasProfile(id) || quotaPaused.has(id)) return Promise.resolve(false)
  const cfg = getConfig(id)
  if (cfg.kind !== kind || !hasSubscriptionQuota(cfg)) return Promise.resolve(false)
  const pending = quotaPending.get(id)
  if (pending) return pending.request
  const controller = new AbortController()
  const request = Promise.resolve().then(async () => {
    const { signal } = controller
    if (signal.aborted) return false
    const result = await run(cfg, signal)
    if (signal.aborted || !hasProfile(id)) return false
    const current = getConfig(id)
    if (!hasSubscriptionQuota(current) || resolveProfileDir(current) !== resolveProfileDir(cfg)) return false
    if ('error' in result) {
      setQuotaError(id, result.error)
      return false
    }
    if (!result.value) return false
    if (result.value === 'api-key') {
      setQuotaError(id, null)
      if (quotas[id]?.source === 'agy-usage') {
        delete quotas[id]
        changed()
      }
      return false
    }
    const { report, source } = result.value
    recordQuota(id, report, source)
    setQuotaError(id, null)
    return true
  }).finally(() => {
    if (quotaPending.get(id)?.controller === controller) quotaPending.delete(id)
  })
  quotaPending.set(id, { controller, request })
  return request
}

function stopQuotaProcess(proc: ChildProcess): void {
  if (proc.exitCode != null) return
  if (proc.pid) {
    try {
      process.kill(-proc.pid, 'SIGKILL')
      return
    } catch {
      // The process group may have exited already.
    }
  }
  proc.kill('SIGKILL')
}

const quotaError = (input: Parameters<typeof classifyQuotaError>[0]) =>
  ({ error: classifyQuotaError(input) ?? quotaFailure('Quota request failed') })

export function refreshCodexLive(id: ProfileId): Promise<boolean> {
  return refreshOAuthQuota(id, 'codex', (cfg, signal) => {
    const dir = resolveProfileDir(cfg)
    const store = oauthCredentialFile(safeRealpath(join(dir, 'auth.json')))
    let rejectedToken: string | undefined
    return runWithOAuth401Recovery(id, {
      signal,
      request: async (reload) => {
        const { env } = buildSpawnSpec(id, 'run', undefined, false)
        const credentials = await store.read()
        signal.throwIfAborted()
        if (!credentials) return reload ? { error: authExpired() } : { value: null }
        rejectedToken = credentials.tokens?.access_token
        return requestCodexQuota(dir, env, signal)
      },
      refresh: () => refreshOAuthCredentials('codex', store, oauthPost(id, signal), signal, rejectedToken)
    })
  })
}

function requestCodexQuota(dir: string, env: NodeJS.ProcessEnv, signal: AbortSignal): Promise<QuotaAttempt<QuotaData>> {
  return new Promise((resolve) => {
    const bin = kindBinaryPath('codex')
    if (!bin) return resolve({ value: null })
    const proc = spawn(bin, [...CODEX_APP_SERVER_PROBE_ARGS, '-c', 'cli_auth_credentials_store="file"'], {
      env, cwd: dir, detached: true, stdio: ['pipe', 'pipe', 'pipe']
    })
    let stderr = ''
    proc.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-8192) })
    let done = false
    const finish = (result: QuotaAttempt<QuotaData>) => {
      if (done) return
      done = true
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
      stopQuotaProcess(proc)
      resolve(result)
    }
    const abort = () => finish({ value: null })
    const timer = setTimeout(() => finish(quotaError({ message: 'Codex quota request timed out' })), 15_000)
    signal.addEventListener('abort', abort, { once: true })
    proc.on('error', (err) => finish(quotaError({ message: err.message })))
    proc.stdin.on('error', () => { /* The child close event supplies its error. */ })
    proc.on('close', () => finish(quotaError({ message: stderr.trim() || 'Codex quota process exited' })))

    const rl = createInterface({ input: proc.stdout })
    rl.on('line', (line) => {
      if (done) return
      let msg: any
      try { msg = JSON.parse(line) } catch { return }
      if (msg.id !== 1 && msg.id !== 2) return
      if (msg.error) {
        const code = msg.error.data?.status ?? msg.error.data?.statusCode ?? msg.error.code
        const status = Number(code) >= 100 && Number(code) < 600 ? Number(code) : undefined
        return finish(quotaError({ status, message: String(msg.error.message ?? msg.error), body: msg.error }))
      }
      if (msg.id === 1) {
        proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'initialized' }) + '\n')
        proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'account/rateLimits/read', params: {} }) + '\n')
        return
      }
      const r = msg.result?.rateLimits
      if (!r || typeof r !== 'object') return finish({ value: null })
      const parseWin = (w: any): QuotaWindow | null => {
        if (!w || typeof w.usedPercent !== 'number') return null
        return {
          percent: w.usedPercent,
          resetsAt: typeof w.resetsAt === 'number' ? w.resetsAt * 1000 : null,
          minutes: Number(w.windowDurationMins) || 0
        }
      }
      const wins = [parseWin(r.primary), parseWin(r.secondary)].filter((w): w is QuotaWindow => !!w)
      if (!wins.length) return finish({ value: null })
      const fiveHour = wins.find((w) => w.minutes > 0 && w.minutes <= 600) ?? null
      const sevenDay = wins.find((w) => w.minutes >= 1440) ?? null
      const limited = !!r.rateLimitReachedType || wins.some((w) => w.percent >= 100 && (!w.resetsAt || w.resetsAt > Date.now()))
      finish({ value: { source: 'codex-rpc', report: { fiveHour, sevenDay, limited, plan: typeof r.planType === 'string' ? r.planType : null } } })
    })
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { clientInfo: { name: 'agentswitch', version: '0.1.0' } } }) + '\n')
  })
}

function claudeKeychainStore(dir: string, signal: AbortSignal): OAuthCredentialStore {
  const service = claudeCredentialService(dir)
  const security = (args: string[], missingIsNull = false): Promise<string | null> => new Promise((resolve, reject) => {
    execFile('/usr/bin/security', args, { timeout: 5000, signal }, (err, stdout, stderr) => {
      if (!err) resolve(stdout)
      else if (missingIsNull && (err.code === 44 || /could not be found/i.test(stderr))) resolve(null)
      else reject(new Error('Could not access Claude OAuth Keychain credentials'))
    })
  })
  return {
    async read() {
      const secret = await security(['find-generic-password', '-s', service, '-w'], true)
      return secret === null ? null : JSON.parse(secret)
    },
    async write(data) {
      const item = await security(['find-generic-password', '-s', service])
      const account = /"acct"<[^>]+>="([^"]*)"/.exec(item ?? '')?.[1]
      const keychain = /^keychain: "([^"]+)"/m.exec(item ?? '')?.[1]
      if (!account || !keychain) throw new Error('Could not identify Claude OAuth Keychain item')
      await security(['add-generic-password', '-U', '-s', service, '-a', account, '-w', JSON.stringify(data), keychain])
    }
  }
}

async function readClaudeCredentials(dir: string, signal: AbortSignal) {
  const file = oauthCredentialFile(safeRealpath(join(dir, '.credentials.json')))
  const data = await file.read()
  if (data?.claudeAiOauth?.accessToken || data?.claudeAiOauth?.refreshToken || process.platform !== 'darwin') {
    return { store: file, data }
  }
  const store = claudeKeychainStore(dir, signal)
  return { store, data: await store.read() }
}

function parseCurlHeaderBlock(raw: string): Record<string, string> {
  const blocks = raw.trim().split(/\r?\n\r?\n/).filter((b) => b.trim())
  const last = blocks[blocks.length - 1] ?? ''
  const out: Record<string, string> = {}
  for (const line of last.split(/\r?\n/)) {
    const idx = line.indexOf(':')
    if (idx <= 0) continue
    const k = line.slice(0, idx).trim().toLowerCase()
    const v = line.slice(idx + 1).trim()
    if (k && v) out[k] = v
  }
  return out
}

function oauthHttp(
  url: string, headers: Record<string, string>, env: NodeJS.ProcessEnv, signal: AbortSignal, body?: string
): Promise<{ status: number; text: string; headers: Record<string, string> }> {
  const hasEnvProxy = !!(env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy || env.ALL_PROXY || env.all_proxy)
  if (hasEnvProxy && process.platform !== 'win32') {
    return new Promise((resolve, reject) => {
      const hdrFile = join(tmpdir(), `agentswitch-claude-hdr-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`)
      const args = [
        '-q', '-sS',
        '--proto', '=https',
        '--max-time',
        '12',
        '-D',
        hdrFile,
        '-w',
        '\n%{http_code}',
        '--config', '-',
        url
      ]
      const child = execFile('/usr/bin/curl', args, { env, signal, timeout: 15_000, maxBuffer: 2 * 1024 * 1024 }, (err, stdout) => {
        let respHeaders: Record<string, string> = {}
        try {
          if (existsSync(hdrFile)) respHeaders = parseCurlHeaderBlock(readFileSync(hdrFile, 'utf8'))
        } catch {
          /* best effort */
        } finally {
          try {
            rmSync(hdrFile, { force: true })
          } catch {
            /* best effort */
          }
        }
        if (err) return reject(new Error('OAuth HTTP request through proxy failed'))
        const s = String(stdout)
        const idx = s.lastIndexOf('\n')
        const status = Number(idx >= 0 ? s.slice(idx + 1).trim() : '') || 0
        const text = idx >= 0 ? s.slice(0, idx) : s
        resolve({ status, text, headers: respHeaders })
      })
      const config = Object.entries(headers).map(([k, v]) => `header = ${JSON.stringify(`${k}: ${v}`)}`)
      if (body) config.push('request = "POST"', `data-binary = ${JSON.stringify(body)}`)
      child.stdin?.on('error', () => { /* The exit callback reports request failures. */ })
      child.stdin?.end(config.join('\n') + '\n')
    })
  }
  // No explicit proxy env: use Electron's net.fetch so macOS system proxy settings are honoured.
  return net.fetch(url, { headers, method: body ? 'POST' : 'GET', body, redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(12_000)]) }).then(async (res) => {
    const respHeaders: Record<string, string> = {}
    res.headers?.forEach((v, k) => {
      respHeaders[k.toLowerCase()] = v
    })
    return { status: res.status, text: await res.text(), headers: respHeaders }
  })
}

function oauthPost(id: ProfileId, signal: AbortSignal) {
  return (url: string, body: Record<string, string>) => oauthHttp(url, { 'Content-Type': 'application/json' },
    buildSpawnSpec(id, 'run', undefined, false).env, signal, JSON.stringify(body))
}

export function refreshClaudeOauth(id: ProfileId): Promise<boolean> {
  return refreshOAuthQuota(id, 'claude', (cfg, signal) => {
    const dir = resolveProfileDir(cfg)
    let store: OAuthCredentialStore | undefined
    let rejectedToken: string | undefined
    return runWithOAuth401Recovery(id, {
      signal,
      request: async (reload) => {
        const { env } = buildSpawnSpec(id, 'run', undefined, false)
        const credentials = await readClaudeCredentials(dir, signal)
        store = credentials.store
        const token = credentials.data?.claudeAiOauth?.accessToken
        if (typeof token !== 'string' || !token) {
          return reload || credentials.data?.claudeAiOauth?.refreshToken || isLoggedIn(id) ? { error: authExpired() } : { value: null }
        }
        rejectedToken = token
        const res = await oauthHttp('https://api.anthropic.com/api/oauth/usage', {
          Authorization: `Bearer ${token}`,
          'anthropic-beta': 'oauth-2025-04-20',
          'User-Agent': 'claude-code/2.1.0',
          Accept: 'application/json'
        }, env, signal)
        if (res.status < 200 || res.status >= 300) {
          let body: any
          try { body = JSON.parse(res.text) } catch { /* Keep HTTP status. */ }
          const message = body?.error?.message ?? body?.message
          return quotaError({ status: res.status, message: `HTTP ${res.status}${typeof message === 'string' ? ': ' + message : ''}`, body, headers: res.headers })
        }
        const d = JSON.parse(res.text)
        const parseWin = (w: any, minutes: number): QuotaWindow | null => {
          if (!w || typeof w.utilization !== 'number') return null
          const t = w.resets_at ? Date.parse(String(w.resets_at)) : NaN
          return { percent: Math.round(w.utilization * 10) / 10, resetsAt: isNaN(t) ? null : t, minutes }
        }
        const fiveHour = parseWin(d?.five_hour, 300)
        const sevenDay = parseWin(d?.seven_day, 10080)
        if (!fiveHour && !sevenDay) return { value: null }
        const limited = [fiveHour, sevenDay].some((w) => !!w && w.percent >= 100 && (!w.resetsAt || w.resetsAt > Date.now()))
        return { value: { source: 'claude-oauth', report: { fiveHour, sevenDay, limited, plan: null } } }
      },
      refresh: () => store ? refreshOAuthCredentials('claude', store, oauthPost(id, signal), signal, rejectedToken) : Promise.resolve(authExpired())
    })
  })
}

// ---- agy quota (`agy -p "/usage" --output-format json`: local command, no model call) -----------

export const AGY_AUTH_PROMPT_RE = /Authentication required|Please visit the URL to log in|Waiting for authentication/i
const hasAgyAuthPrompt = (output: string): boolean => output.split(/\r?\n/).some((line) =>
  !line.trimStart().startsWith('{') && AGY_AUTH_PROMPT_RE.test(line) && !/\b(?:HTTP|status(?: code)?)[:\s]+5\d{2}\b/i.test(line))
const AGY_QUOTA_MAX_BYTES = 4 * 1024 * 1024

export function refreshAgyQuota(id: ProfileId): Promise<boolean> {
  return refreshOAuthQuota(id, 'gemini', (cfg, signal) => runWithOAuth401Recovery<QuotaData>(id, {
    signal,
    request: async (reload) => {
      const bin = kindBinaryPath('gemini')
      if (!bin) return { value: null }
      clearProfileKeychainCache(resolveProfileDir(cfg))
      if (!reload && !isLoggedIn(id)) return { value: null }
      const { env } = buildSpawnSpec(id, 'run', undefined, true)
      const result = await runAgyQuotaCommand(bin, env, false, signal)
      if ('error' in result) return result
      if (!result.value) return { value: null }
      const { stdout, stderr, code } = result.value
      try {
        const jsonLine = stdout.trim().split('\n').filter((l) => l.startsWith('{')).pop()
        const d = jsonLine ? JSON.parse(jsonLine) : null
        if (d?.error) {
          const message = typeof d.error === 'string' ? d.error : String(d.error.message ?? JSON.stringify(d.error))
          return quotaError({ message, body: d })
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
          if (stderr.trim()) return quotaError({ message: stderr.trim(), body: d })
          if (code === 2) return { value: 'api-key' } // agy with external API-key auth has no OAuth subscription.
          return code ? quotaError({ message: `exit code ${code}`, body: d }) : { value: null }
        }
        const main = groups.find((g) => g.key === 'gemini') ?? groups[0]
        const limited = [main.fiveHour, main.sevenDay].some((w) => !!w && w.percent >= 100 && (!w.resetsAt || w.resetsAt > Date.now()))
        return { value: { source: 'agy-usage', report: { fiveHour: main.fiveHour, sevenDay: main.sevenDay, limited, plan: null, groups } } }
      } catch (err) {
        return quotaError({ message: stderr.trim() || String(err) })
      }
    },
    refresh: async (): Promise<RefreshResult> => {
      const bin = kindBinaryPath('gemini')
      if (!bin) return quotaFailure('agy is unavailable')
      const { env } = buildSpawnSpec(id, 'run', undefined, true)
      const result = await runAgyQuotaCommand(bin, env, true, signal)
      if ('error' in result) return result.error
      if (result.value?.code === 0) return 'refreshed'
      return quotaError({ message: result.value?.stderr.trim() || 'agy models failed' }).error
    }
  }))
}

function runAgyQuotaCommand(bin: string, env: NodeJS.ProcessEnv, refresh: boolean, signal: AbortSignal): Promise<QuotaAttempt<{ stdout: string; stderr: string; code: number | null } | null>> {
  return new Promise((resolve) => {
    const args = refresh ? ['models'] : ['-p', '/usage', '--output-format', 'json', '--log-file', '/dev/null']
    const proc = spawn(bin, args, {
      env: { ...env, AGY_CLI_DISABLE_AUTO_UPDATE: '1', SSH_CONNECTION: '1', SSH_TTY: '1' },
      cwd: tmpdir(), detached: true, stdio: ['ignore', 'pipe', 'pipe']
    })
    let stdout = ''
    let stderr = ''
    let done = false
    const finish = (result: QuotaAttempt<{ stdout: string; stderr: string; code: number | null } | null>) => {
      if (done) return
      done = true
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
      stopQuotaProcess(proc)
      resolve(result)
    }
    const abort = () => finish({ value: null })
    const timer = setTimeout(() => finish(quotaError({ message: `agy ${refresh ? 'models' : '/usage'} timed out` })), refresh ? 15_000 : 30_000)
    signal.addEventListener('abort', abort, { once: true })
    proc.stdout?.setEncoding('utf8')
    proc.stderr?.setEncoding('utf8')
    proc.stdout?.on('data', (chunk: string) => {
      stdout += chunk.slice(0, AGY_QUOTA_MAX_BYTES - stdout.length)
      if (hasAgyAuthPrompt(stdout)) finish({ error: authExpired() })
    })
    proc.stderr?.on('data', (chunk: string) => {
      stderr += chunk.slice(0, AGY_QUOTA_MAX_BYTES - stderr.length)
      if (hasAgyAuthPrompt(stderr)) finish({ error: authExpired() })
    })
    proc.on('error', (err) => finish(quotaError({ message: err.message })))
    proc.on('close', (code) => finish({ value: { stdout, stderr, code } }))
  })
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

export async function codexFileDays(path: string, since: number, cut: number): Promise<Days> {
  // token_count carries running totals: attribute each increase to its day and the turn's model.
  const days: Days = {}
  let prev: any = null
  let model: string | null = null
  let sessionModel: string | null = null
  const pending: { ts: number; prompt: number; usage: Partial<Bucket> }[] = []
  const flush = (fallback: string | null): void => {
    for (const row of pending.splice(0)) put(days, row.ts, modelKey(fallback, row.prompt), row.usage)
  }
  const rl = createInterface({ input: createReadStream(path, { encoding: 'utf8' }), crlfDelay: Infinity })
  for await (const line of rl) {
    if (!line.includes('"turn_context"') && !line.includes('"session_meta"') && !line.includes('"total_token_usage"')) continue
    let d: any
    try {
      d = JSON.parse(line)
    } catch {
      continue
    }
    if (d.type === 'session_meta') sessionModel = codexRolloutEventModel(d) ?? sessionModel
    else if (d.type === 'turn_context') {
      model = codexRolloutEventModel(d) ?? model
      if (model) flush(model)
    }
    if (d.payload?.type !== 'token_count') continue
    const t = d.payload?.info?.total_token_usage
    if (!t) continue
    const ts = toMs(d.timestamp)
    const delta = (k: string): number => Math.max(0, n(t[k]) - n(prev?.[k]))
    const input = delta('input_tokens')
    const output = delta('output_tokens')
    const cached = Math.min(delta('cached_input_tokens'), input)
    const usage = { input: input - cached, output, cacheRead: cached, cacheWrite: delta('cache_write_input_tokens'), reasoning: delta('reasoning_output_tokens') }
    prev = t
    if (!inWindow(ts, since, cut) || (!input && !output)) continue
    const prompt = n(d.payload.info.last_token_usage?.input_tokens)
    if (model) put(days, ts, modelKey(model, prompt), usage)
    else pending.push({ ts, prompt, usage })
  }
  flush(sessionModel)
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
          path = claudeSessionLog(resolveProfileDir(cfg), sid)
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

const CODEX_MODEL_ATTRIBUTION = 1
const needsCodexAttribution = (entry: FileEntry): boolean =>
  entry.modelAttribution !== CODEX_MODEL_ATTRIBUTION
  && Object.values(entry.days).some((models) => Object.keys(models).some((model) => !cleanModelName(model) || model === unrecorded('codex')))

async function readLegacy(): Promise<void> {
  const alreadyDone = stats.legacyDone
  const since30 = Date.now() - CLAUDE_DAYS * DAY
  for (const f of ownSessionFiles()) {
    const previous = stats.legacy[f.path]
    if (alreadyDone && (f.kind !== 'codex' || !previous || !needsCodexAttribution(previous))) continue
    try {
      const st = statSync(f.path)
      const days =
        f.kind === 'claude'
          ? await claudeFileDays(f.path, Math.max(f.since, since30), stats.legacyUntil)
          : f.kind === 'codex'
            ? await codexFileDays(f.path, f.since, stats.legacyUntil)
            : agyFileDays(f.path, f.since, stats.legacyUntil, st.mtimeMs)
      if (!hasProfile(f.profileId)) continue
      stats.legacy[f.path] = { mtime: st.mtimeMs, size: st.size, profileId: f.profileId, days, ...(f.kind === 'codex' ? { modelAttribution: CODEX_MODEL_ATTRIBUTION } : {}) }
      changed()
    } catch {
      /* unreadable: skip */
    }
    await new Promise((r) => setImmediate(r))
  }
  if (alreadyDone) return
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
      if (!stats.legacyDone || Object.values(stats.legacy).some((f) => f.profileId.startsWith('codex-') && needsCodexAttribution(f))) await readLegacy()
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
        if (prev && prev.mtime === st.mtimeMs && prev.size === st.size && prev.profileId === e.profileId && (e.kind !== 'codex' || !needsCodexAttribution(prev))) continue
        const cut = cuts.get(e.nativeId) ?? 0
        try {
          const days = e.kind === 'claude' ? await claudeFileDays(path, since, cut) : e.kind === 'codex' ? await codexFileDays(path, 0, cut) : agyFileDays(path, 0, cut, e.updatedAt || st.mtimeMs)
          if (!hasProfile(e.profileId)) continue
          stats.files[path] = { mtime: st.mtimeMs, size: st.size, profileId: e.profileId, days, ...(e.kind === 'codex' ? { modelAttribution: CODEX_MODEL_ATTRIBUTION } : {}) }
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
 *  - claude: OAuth `/api/oauth/usage` via local credentials. Unclassified failures can use the
 *            optional Haiku probe. Rate limits and expired logins do not trigger the probe.
 */
/** Trigger provider-specific post-run quota refresh (kept inside the usage/quota adapter layer). */
export function refreshPostRunQuota(cfg: { id: ProfileId; kind: ProfileKind }, ok: boolean): void {
  if (cfg.kind === 'codex') refreshCodexQuota(cfg.id)
  else if (cfg.kind === 'gemini' && ok) void refreshAgyQuota(cfg.id)
}

export function refreshAccountQuota(id: ProfileId): Promise<boolean> {
  if (!hasProfile(id)) return Promise.resolve(false)
  switch (getConfig(id).kind) {
    case 'claude': return refreshClaudeOauth(id)
    case 'codex': return refreshCodexLive(id)
    case 'gemini': return refreshAgyQuota(id)
    default: return Promise.resolve(false)
  }
}

export async function refreshUsage(probe: boolean): Promise<UsageSnapshot> {
  // API-key accounts have no subscription quota, and a probe would spend the user's credits.
  const configs = listConfigs().filter(hasSubscriptionQuota)
  const codexTask = Promise.all(
    configs
      .filter((c) => c.kind === 'codex')
      .map(async (c) => {
        const ok = isLoggedIn(c.id) ? await refreshCodexLive(c.id) : false
        if (!ok && quotaErrors[c.id]?.kind !== 'auth_expired') refreshCodexQuota(c.id, !!quotaErrors[c.id])
      })
  )
  const agyTask = Promise.all(configs.filter((c) => c.kind === 'gemini').map((c) => refreshAgyQuota(c.id)))
  const claudeTask = Promise.all(
    configs
      .filter((c) => c.kind === 'claude')
      .map(async (c) => {
        const ok = await refreshClaudeOauth(c.id)
        if (ok || !probe || !hasProfile(c.id) || quotaPaused.has(c.id) || !isLoggedIn(c.id) || claudeProbes.has(c.id) ||
          quotaErrors[c.id]?.kind === 'rate_limited' || quotaErrors[c.id]?.kind === 'auth_expired') return
        const dir = tmpdir()
        let usage: Usage | null = null
        let h: ReturnType<typeof runAgent> | undefined
        h = runAgent(
          { cfg: { ...c, autoApprove: 'edits' }, model: 'haiku', prompt: 'Reply with exactly: OK', system: null, cwd: dir, images: [], resume: null, outDir: dir, ephemeralProbe: true },
          (e) => {
            if (h && claudeProbes.get(c.id) !== h) return
            if (e.t === 'quota') recordQuota(c.id, e.quota, 'claude-stream')
            if (e.t === 'usage') usage = { ...(usage ?? {}), ...e.usage }
            if (e.t === 'rate_limited') {
              recordLimited(c.id)
              setQuotaError(c.id, { kind: 'rate_limited', message: 'Rate limited', resetAt: null })
            }
          },
          () => {}
        )
        claudeProbes.set(c.id, h)
        try {
          const r = await h.done
          if (claudeProbes.get(c.id) === h) recordRun(c.id, r.model ?? 'haiku', usage)
        } finally {
          if (claudeProbes.get(c.id) === h) claudeProbes.delete(c.id)
        }
      })
  )
  void syncPrices()
  await Promise.all([codexTask, agyTask, claudeTask])
  void runBackfill()
  changed()
  return snapshot()
}

/** Startup: passive quota checks + backfill in the background, after the window is up. */
export function startUsage(): void {
  for (const c of listConfigs()) if (c.kind === 'codex') refreshCodexQuota(c.id)
  setTimeout(() => {
    for (const c of listConfigs()) {
      if (!hasSubscriptionQuota(c)) continue
      // Skip `agy -p /usage` on startup: agy boots its full language server and user MCPs.
      if (c.kind === 'codex' && isLoggedIn(c.id)) void refreshCodexLive(c.id)
      else if (c.kind === 'claude') void refreshClaudeOauth(c.id)
    }
  }, 4000)
  setTimeout(() => void runBackfill(), 8000)
  setTimeout(() => void syncPrices(), 10_000)
  setInterval(() => void syncPrices(), 6 * 3600_000)
  setInterval(() => void runBackfill(), 30 * 60_000)
}
