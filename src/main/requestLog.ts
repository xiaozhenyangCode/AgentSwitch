import { app } from 'electron'
import { randomBytes } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type {
  ProfileConfig,
  ProfileId,
  ProfileKind,
  RequestLogCounts,
  RequestLogEntry,
  RequestLogPage,
  RequestLogQuery,
  RequestLogStatusFilter
} from '@shared/types'
import { priceForRequest } from './usage'

/**
 * Per-request LLM telemetry log persisted in `<userData>/request-logs.sqlite`.
 *
 * Uses Node's built-in `node:sqlite` (`DatabaseSync`) with automatic retention cleanup
 * (30 days or 10,000 rows, whichever is tighter) and indexed pagination/filtering.
 */

export const REQUEST_LOG_MAX_AGE_MS = 30 * 86400_000
export const REQUEST_LOG_MAX_ROWS = 10_000
const DEFAULT_LIMIT = 100
const MAX_LIMIT = 500
const RAW_USAGE_MAX_CHARS = 4096
const PRUNE_EVERY_N_WRITES = 20

const uid = (): string => randomBytes(8).toString('hex')
const posInt = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.round(v) : 0)

// ---- pure normalization & metric helpers ----------------------------------------------------

export interface NormalizedTokens {
  uncachedInputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
}

/**
 * Normalizes raw token counts into strictly mutually exclusive buckets:
 *   - `uncachedInputTokens`: newly processed (non-cached) input tokens
 *   - `outputTokens`: generated output tokens
 *   - `cacheReadTokens`: prompt tokens served from cache
 *   - `cacheWriteTokens`: prompt tokens written into cache
 *
 * When `inputIncludesCacheRead` is true (e.g. raw Codex/Gemini total input), `cacheReadTokens`
 * is deducted from `totalInput` so uncached input is never double-counted.
 */
export function normalizeTokens(input: {
  uncachedInput?: number | null
  totalInput?: number | null
  output?: number | null
  cacheRead?: number | null
  cacheWrite?: number | null
  inputIncludesCacheRead?: boolean
}): NormalizedTokens {
  const outputTokens = posInt(input.output)
  const cacheReadTokens = posInt(input.cacheRead)
  const cacheWriteTokens = posInt(input.cacheWrite)
  let uncachedInputTokens: number
  if (input.inputIncludesCacheRead) {
    const total = posInt(input.totalInput ?? input.uncachedInput)
    uncachedInputTokens = Math.max(0, total - Math.min(cacheReadTokens, total))
  } else {
    uncachedInputTokens = posInt(input.uncachedInput ?? input.totalInput)
  }
  return { uncachedInputTokens, outputTokens, cacheReadTokens, cacheWriteTokens }
}

/** Cache hit rate: `cacheRead / (uncachedInput + cacheRead + cacheWrite)` (null if denominator is 0). */
export function computeCacheHitRate(t: Pick<NormalizedTokens, 'uncachedInputTokens' | 'cacheReadTokens' | 'cacheWriteTokens'>): number | null {
  const denom = posInt(t.uncachedInputTokens) + posInt(t.cacheReadTokens) + posInt(t.cacheWriteTokens)
  return denom > 0 ? posInt(t.cacheReadTokens) / denom : null
}

export interface PerformanceMetrics {
  ttftMs: number | null
  durationMs: number | null
  tokensPerSecond: number | null
}

/**
 * Computes TTFT, total duration, and output generation speed (`tok/s`).
 * - Non-streaming requests always have `ttftMs = null` and `tokensPerSecond = null`.
 * - Short outputs (`< 50` tokens) or ultra-short generation intervals (`< 200ms`) return
 *   `tokensPerSecond = null` to avoid distorted spikes.
 */
export function computePerformanceMetrics(input: {
  startedAt?: number | null
  firstTokenAt?: number | null
  endedAt?: number | null
  outputTokens: number
  streaming: boolean
}): PerformanceMetrics {
  const start = typeof input.startedAt === 'number' && Number.isFinite(input.startedAt) ? input.startedAt : null
  const first = typeof input.firstTokenAt === 'number' && Number.isFinite(input.firstTokenAt) ? input.firstTokenAt : null
  const end = typeof input.endedAt === 'number' && Number.isFinite(input.endedAt) ? input.endedAt : null

  const durationMs = start !== null && end !== null && end >= start ? Math.round(end - start) : null
  if (!input.streaming) return { ttftMs: null, durationMs, tokensPerSecond: null }

  const ttftMs = start !== null && first !== null && first >= start ? Math.round(first - start) : null
  let tokensPerSecond: number | null = null
  if (first !== null && end !== null && input.outputTokens >= 50) {
    const genMs = end - first
    if (genMs >= 200) {
      tokensPerSecond = Math.round((input.outputTokens / (genMs / 1000)) * 10) / 10
    }
  }
  return { ttftMs, durationMs, tokensPerSecond }
}

const STATUS_429_RE = /\b429\b|rate[_\s-]*limit|too many requests|quota\s*(exceeded|exhausted|reached)|resource_exhausted|usage\s*limit/i
const STATUS_401_RE = /\b401\b|unauthorized|unauthenticated|invalid[_\s-]*api[_\s-]*key|authentication\s*(failed|required|error)|expired\s*token|not\s+logged\s+in/i
const STATUS_403_RE = /\b403\b|forbidden|permission\s*denied|access\s*denied|insufficient\s*permission/i
const STATUS_408_RE = /\b408\b|timed?\s*out|timeout|etimedout|deadline[_\s-]*exceeded/i

/** Maps run outcome / error signals to unified HTTP-like status codes (200/401/403/408/429/499/500). */
export function mapStatusCode(input: {
  ok: boolean
  stopped?: boolean
  rateLimited?: boolean
  error?: string | null
  statusCode?: number | null
}): number {
  if (typeof input.statusCode === 'number' && Number.isInteger(input.statusCode) && input.statusCode >= 100 && input.statusCode <= 599) {
    return input.statusCode
  }
  if (input.stopped) return 499
  if (input.rateLimited) return 429
  const msg = (input.error ?? '').trim()
  if (msg) {
    if (STATUS_429_RE.test(msg)) return 429
    if (STATUS_401_RE.test(msg)) return 401
    if (STATUS_403_RE.test(msg)) return 403
    if (STATUS_408_RE.test(msg)) return 408
  }
  if (input.ok) return 200
  return 500
}

/** Human-readable provider label for an account. */
export function resolveProviderLabel(cfg: Pick<ProfileConfig, 'kind' | 'apiKey'>): string {
  if (cfg.apiKey?.provider === 'deepseek') return 'DeepSeek'
  if (cfg.apiKey?.provider === 'custom') {
    const url = cfg.apiKey.baseUrl?.trim()
    if (url) {
      try {
        return new URL(url).host || 'Custom API'
      } catch {
        /* fallback */
      }
    }
    return 'Custom API'
  }
  switch (cfg.kind) {
    case 'claude':
      return 'Anthropic'
    case 'codex':
      return 'OpenAI'
    case 'gemini':
      return 'Google'
    case 'reasonix':
      return 'DeepSeek'
  }
}

function serializeRawUsage(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null
  try {
    const text = JSON.stringify(raw)
    if (!text) return null
    if (text.length <= RAW_USAGE_MAX_CHARS) return text
    return JSON.stringify({ _truncated: true, preview: text.slice(0, RAW_USAGE_MAX_CHARS - 64) })
  } catch {
    return null
  }
}

function parseRawUsage(text: string | null): unknown {
  if (!text) return undefined
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

// ---- SQLite store ---------------------------------------------------------------------------

let db: DatabaseSync | null = null
let dbPath: string | null = null
let writesSincePrune = 0
let changeListener: (() => void) | null = null
let notifyTimer: ReturnType<typeof setTimeout> | null = null

export function onRequestLogChange(cb: () => void): void {
  changeListener = cb
}

function notifyChanged(): void {
  if (!changeListener || notifyTimer) return
  notifyTimer = setTimeout(() => {
    notifyTimer = null
    changeListener?.()
  }, 250)
}

function logDbFile(): string {
  return join(app.getPath('userData'), 'request-logs.sqlite')
}

function getDb(): DatabaseSync {
  const target = logDbFile()
  if (db && dbPath === target) return db
  if (db) {
    try {
      db.close()
    } catch {
      /* ignore */
    }
    db = null
  }
  mkdirSync(app.getPath('userData'), { recursive: true })
  const conn = new DatabaseSync(target)
  conn.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    CREATE TABLE IF NOT EXISTS request_logs (
      id TEXT PRIMARY KEY,
      timestamp INTEGER NOT NULL,
      account_id TEXT NOT NULL,
      account_name TEXT NOT NULL,
      engine_kind TEXT NOT NULL,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      project_dir TEXT,
      thread_id TEXT,
      run_id TEXT,
      turn_index INTEGER,
      uncached_input_tokens INTEGER NOT NULL,
      output_tokens INTEGER NOT NULL,
      cache_read_tokens INTEGER NOT NULL,
      cache_write_tokens INTEGER NOT NULL,
      cost_usd REAL,
      ttft_ms INTEGER,
      duration_ms INTEGER,
      tokens_per_second REAL,
      status_code INTEGER NOT NULL,
      error_summary TEXT,
      raw_usage TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_req_logs_ts ON request_logs(timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_req_logs_status ON request_logs(status_code, timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_req_logs_account ON request_logs(account_id, timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_req_logs_engine ON request_logs(engine_kind, timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_req_logs_model ON request_logs(model, timestamp DESC);
  `)
  db = conn
  dbPath = target
  pruneRequestLogs()
  return conn
}

/** Closes the database handle (used by tests when switching temp directories). */
export function closeRequestLogDb(): void {
  if (notifyTimer) {
    clearTimeout(notifyTimer)
    notifyTimer = null
  }
  if (db) {
    try {
      db.close()
    } catch {
      /* ignore */
    }
    db = null
    dbPath = null
  }
}

/** Enforces the 30-day age limit and 10,000-row capacity cap. */
export function pruneRequestLogs(opts?: { maxAgeMs?: number; maxRows?: number; now?: number }): void {
  const conn = db ?? getDb()
  const now = opts?.now ?? Date.now()
  const maxAgeMs = opts?.maxAgeMs ?? REQUEST_LOG_MAX_AGE_MS
  const maxRows = opts?.maxRows ?? REQUEST_LOG_MAX_ROWS
  const cutoff = now - maxAgeMs
  conn.prepare('DELETE FROM request_logs WHERE timestamp < ?').run(cutoff)
  const countRow = conn.prepare('SELECT COUNT(*) AS cnt FROM request_logs').get() as { cnt: number } | undefined
  const total = Number(countRow?.cnt ?? 0)
  if (total > maxRows) {
    conn
      .prepare(
        `DELETE FROM request_logs WHERE rowid IN (
          SELECT rowid FROM request_logs ORDER BY timestamp DESC, rowid DESC LIMIT -1 OFFSET ?
        )`
      )
      .run(maxRows)
  }
}

export interface RecordRequestLogInput {
  id?: string
  timestamp?: number
  accountId: ProfileId
  accountName: string
  engineKind: ProfileKind
  provider: string
  model: string | null | undefined
  projectDir?: string | null
  threadId?: string | null
  runId?: string | null
  turnIndex?: number | null
  uncachedInputTokens?: number | null
  totalInputTokens?: number | null
  outputTokens?: number | null
  cacheReadTokens?: number | null
  cacheWriteTokens?: number | null
  cacheWrite1hTokens?: number | null
  inputIncludesCacheRead?: boolean
  costUsd?: number | null
  startedAt?: number | null
  firstTokenAt?: number | null
  endedAt?: number | null
  streaming?: boolean
  statusCode: number
  errorSummary?: string | null
  rawUsage?: unknown
}

/** Normalizes, prices, and persists one LLM request log entry. */
export function recordRequestLog(input: RecordRequestLogInput): RequestLogEntry {
  const conn = getDb()
  const ts = input.timestamp ?? input.endedAt ?? Date.now()
  const tokens = normalizeTokens({
    uncachedInput: input.uncachedInputTokens,
    totalInput: input.totalInputTokens,
    output: input.outputTokens,
    cacheRead: input.cacheReadTokens,
    cacheWrite: input.cacheWriteTokens,
    inputIncludesCacheRead: input.inputIncludesCacheRead
  })
  const priced = priceForRequest(
    input.model,
    {
      input: tokens.uncachedInputTokens,
      output: tokens.outputTokens,
      cacheRead: tokens.cacheReadTokens,
      cacheWrite: tokens.cacheWriteTokens,
      cacheWrite1h: posInt(input.cacheWrite1hTokens) || undefined
    },
    input.costUsd
  )
  const hasAnyTokens =
    tokens.uncachedInputTokens + tokens.outputTokens + tokens.cacheReadTokens + tokens.cacheWriteTokens > 0
  const costUsd = hasAnyTokens ? priced.costUsd : input.costUsd ?? null
  const perf = computePerformanceMetrics({
    startedAt: input.startedAt,
    firstTokenAt: input.firstTokenAt,
    endedAt: input.endedAt ?? ts,
    outputTokens: tokens.outputTokens,
    streaming: input.streaming === true
  })
  const errorSummary = input.errorSummary ? input.errorSummary.replace(/\s+/g, ' ').trim().slice(0, 400) : null
  const entry: RequestLogEntry = {
    id: input.id ?? uid(),
    timestamp: Math.round(ts),
    accountId: input.accountId,
    accountName: input.accountName,
    engineKind: input.engineKind,
    provider: input.provider,
    model: priced.model || 'unknown',
    projectDir: input.projectDir ?? null,
    threadId: input.threadId ?? null,
    runId: input.runId ?? null,
    turnIndex: input.turnIndex ?? null,
    ...tokens,
    costUsd,
    ...perf,
    statusCode: input.statusCode,
    errorSummary,
    rawUsage: input.rawUsage
  }

  conn
    .prepare(
      `INSERT OR REPLACE INTO request_logs (
        id, timestamp, account_id, account_name, engine_kind, provider, model,
        project_dir, thread_id, run_id, turn_index,
        uncached_input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
        cost_usd, ttft_ms, duration_ms, tokens_per_second,
        status_code, error_summary, raw_usage
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      entry.id,
      entry.timestamp,
      entry.accountId,
      entry.accountName,
      entry.engineKind,
      entry.provider,
      entry.model,
      entry.projectDir ?? null,
      entry.threadId ?? null,
      entry.runId ?? null,
      entry.turnIndex ?? null,
      entry.uncachedInputTokens,
      entry.outputTokens,
      entry.cacheReadTokens,
      entry.cacheWriteTokens,
      entry.costUsd,
      entry.ttftMs,
      entry.durationMs,
      entry.tokensPerSecond,
      entry.statusCode,
      entry.errorSummary ?? null,
      serializeRawUsage(entry.rawUsage)
    )

  writesSincePrune++
  if (writesSincePrune >= PRUNE_EVERY_N_WRITES) {
    writesSincePrune = 0
    pruneRequestLogs()
  }
  notifyChanged()
  return entry
}

function buildStatusFilter(statusCode: RequestLogStatusFilter | undefined, params: (string | number)[]): string | null {
  if (statusCode === undefined || statusCode === 'all') return null
  if (statusCode === '2xx') return 'status_code >= 200 AND status_code < 300'
  if (statusCode === '429') return 'status_code = 429'
  if (statusCode === '4xx5xx') return 'status_code >= 400'
  if (typeof statusCode === 'number' && Number.isInteger(statusCode)) {
    params.push(statusCode)
    return 'status_code = ?'
  }
  return null
}

/** Paginated, filtered query of persisted request logs ordered newest-first. */
export function queryRequestLogs(query: RequestLogQuery = {}): RequestLogPage {
  const conn = getDb()
  const offset = Math.max(0, Math.floor(query.offset ?? 0))
  const limit = Math.min(MAX_LIMIT, Math.max(1, Math.floor(query.limit ?? DEFAULT_LIMIT)))

  const where: string[] = []
  const params: (string | number)[] = []
  const statusSql = buildStatusFilter(query.statusCode, params)
  if (statusSql) where.push(statusSql)
  if (query.accountId) {
    where.push('account_id = ?')
    params.push(query.accountId)
  }
  if (query.engineKind) {
    where.push('engine_kind = ?')
    params.push(query.engineKind)
  }
  if (query.model) {
    where.push('model = ?')
    params.push(query.model)
  }
  const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : ''

  const countRow = conn
    .prepare(
      `SELECT
        COUNT(*) AS total,
        COUNT(DISTINCT account_id) AS accounts,
        COUNT(DISTINCT model) AS models,
        SUM(CASE WHEN status_code >= 200 AND status_code < 300 THEN 1 ELSE 0 END) AS status2xx,
        SUM(CASE WHEN status_code = 429 THEN 1 ELSE 0 END) AS status429,
        SUM(CASE WHEN status_code >= 400 THEN 1 ELSE 0 END) AS statusError
       FROM request_logs`
    )
    .get() as Record<string, number | null> | undefined

  const counts: RequestLogCounts = {
    total: Number(countRow?.total ?? 0),
    accounts: Number(countRow?.accounts ?? 0),
    models: Number(countRow?.models ?? 0),
    status2xx: Number(countRow?.status2xx ?? 0),
    status429: Number(countRow?.status429 ?? 0),
    statusError: Number(countRow?.statusError ?? 0)
  }

  const filteredRow = where.length
    ? (conn.prepare(`SELECT COUNT(*) AS cnt FROM request_logs ${whereClause}`).get(...params) as { cnt: number } | undefined)
    : { cnt: counts.total }
  const filteredTotal = Number(filteredRow?.cnt ?? 0)

  const rows = conn
    .prepare(
      `SELECT
        id, timestamp, account_id, account_name, engine_kind, provider, model,
        project_dir, thread_id, run_id, turn_index,
        uncached_input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
        cost_usd, ttft_ms, duration_ms, tokens_per_second,
        status_code, error_summary, raw_usage
       FROM request_logs
       ${whereClause}
       ORDER BY timestamp DESC, rowid DESC
       LIMIT ? OFFSET ?`
    )
    .all(...params, limit, offset) as Record<string, any>[]

  const entries: RequestLogEntry[] = rows.map((r) => ({
    id: String(r.id),
    timestamp: Number(r.timestamp),
    accountId: String(r.account_id),
    accountName: String(r.account_name),
    engineKind: String(r.engine_kind) as ProfileKind,
    provider: String(r.provider),
    model: String(r.model),
    projectDir: r.project_dir ?? null,
    threadId: r.thread_id ?? null,
    runId: r.run_id ?? null,
    turnIndex: r.turn_index ?? null,
    uncachedInputTokens: Number(r.uncached_input_tokens),
    outputTokens: Number(r.output_tokens),
    cacheReadTokens: Number(r.cache_read_tokens),
    cacheWriteTokens: Number(r.cache_write_tokens),
    costUsd: r.cost_usd === null || r.cost_usd === undefined ? null : Number(r.cost_usd),
    ttftMs: r.ttft_ms === null || r.ttft_ms === undefined ? null : Number(r.ttft_ms),
    durationMs: r.duration_ms === null || r.duration_ms === undefined ? null : Number(r.duration_ms),
    tokensPerSecond: r.tokens_per_second === null || r.tokens_per_second === undefined ? null : Number(r.tokens_per_second),
    statusCode: Number(r.status_code),
    errorSummary: r.error_summary ?? null,
    rawUsage: parseRawUsage(r.raw_usage ?? null)
  }))

  const availableModels = (
    conn.prepare("SELECT DISTINCT model FROM request_logs WHERE model != '' ORDER BY model ASC").all() as { model: string }[]
  ).map((r) => r.model)
  const availableEngines = (
    conn.prepare('SELECT DISTINCT engine_kind FROM request_logs ORDER BY engine_kind ASC').all() as { engine_kind: string }[]
  ).map((r) => r.engine_kind as ProfileKind)

  return {
    entries,
    total: counts.total,
    filteredTotal,
    hasMore: offset + entries.length < filteredTotal,
    counts,
    availableModels,
    availableEngines
  }
}
