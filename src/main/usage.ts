import { app, net } from 'electron'
import { createHash } from 'node:crypto'
import { closeSync, createReadStream, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { execFile, spawn } from 'node:child_process'
import type { AccountQuota, AccountUsage, ProfileId, QuotaGroup, QuotaReport, QuotaWindow, Usage, UsageSnapshot, UsageTotals } from '@shared/types'
import { runAgent } from './agentRunner'
import { agyConversationDb, claudePath, importedCutoffs, listHistory, pbAll, rolloutPaths, toMs, withDb } from './history'
import { buildSpawnSpec, expandHome, getConfig, hasProfile, isLoggedIn, kindBinaryPath, listConfigs } from './profiles'
import { hasSubscriptionQuota } from './apiKey'
import { realHome } from './shellEnv'

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
 * Stats: userData/usage-stats.json · quota: userData/quota-cache.json.
 */

const CLAUDE_DAYS = 30
const DAY = 86400_000

type Days = Record<string, UsageTotals>
interface FileEntry {
  mtime: number
  size: number
  profileId: ProfileId
  days: Days
}
interface Stats {
  /** 2: run usage is per run (v1 summed claude's cumulative session cost and codex's cumulative tokens). */
  version: 1 | 2
  runs: Record<ProfileId, Days>
  files: Record<string, FileEntry>
  limitedAt: Record<ProfileId, number>
}

const statsFile = (): string => join(app.getPath('userData'), 'usage-stats.json')
const quotaFile = (): string => join(app.getPath('userData'), 'quota-cache.json')

const zero = (): UsageTotals => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, costUsd: 0, runs: 0 })
const n = (v: unknown): number => (typeof v === 'number' && isFinite(v) && v > 0 ? v : 0)
function add(a: UsageTotals, b: Partial<UsageTotals>): UsageTotals {
  return {
    input: a.input + n(b.input),
    output: a.output + n(b.output),
    cacheRead: a.cacheRead + n(b.cacheRead),
    cacheWrite: a.cacheWrite + n(b.cacheWrite),
    reasoning: a.reasoning + n(b.reasoning),
    costUsd: a.costUsd + n(b.costUsd),
    runs: a.runs + n(b.runs)
  }
}
const pad = (x: number): string => String(x).padStart(2, '0')
export const dayKey = (ts: number): string => {
  const d = new Date(ts)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

let stats: Stats = load()
let quotas: Record<ProfileId, AccountQuota> = loadQuota()
let backfill: UsageSnapshot['backfill'] = 'idle'
let listener: ((s: UsageSnapshot) => void) | null = null
let notifyTimer: ReturnType<typeof setTimeout> | null = null
let saveTimer: ReturnType<typeof setTimeout> | null = null

function load(): Stats {
  try {
    const s = JSON.parse(readFileSync(statsFile(), 'utf8')) as Stats
    if (s.version === 1 || s.version === 2) return { version: s.version, runs: s.runs ?? {}, files: s.files ?? {}, limitedAt: s.limitedAt ?? {} }
  } catch {
    /* fresh */
  }
  return { version: 2, runs: {}, files: {}, limitedAt: {} }
}

/**
 * v1 -> v2: v1 recorded claude's session-cumulative total_cost_usd and codex's session-cumulative
 * tokens as each run's own, so every turn re-counted all earlier ones. The real per-run values
 * cannot be recovered: drop those costs and codex run tokens (run counts and history stay).
 * Runs lazily (needs the account list).
 */
function migrate(): void {
  if (stats.version !== 1) return
  const codex = new Set(listConfigs().filter((c) => c.kind === 'codex').map((c) => c.id))
  for (const [id, days] of Object.entries(stats.runs))
    for (const [k, v] of Object.entries(days))
      days[k] = codex.has(id) ? { ...zero(), runs: v.runs } : { ...v, costUsd: 0 }
  stats.version = 2
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
  for (const f of Object.values(stats.files)) per.set(f.profileId, [...(per.get(f.profileId) ?? []), f.days])
  for (const c of listConfigs()) {
    const a: AccountUsage = {
      today: zero(),
      week: zero(),
      total: zero(),
      quota: quotas[c.id] ?? null,
      quotaError: quotaErrors[c.id] ?? null,
      limitedAt: stats.limitedAt[c.id] ?? null
    }
    for (const days of per.get(c.id) ?? [])
      for (const [k, v] of Object.entries(days)) {
        a.total = add(a.total, v)
        if (k >= weekFrom) a.week = add(a.week, v)
        if (k === today) a.today = add(a.today, v)
      }
    accounts[c.id] = a
  }
  return { accounts, backfill, claudeDays: CLAUDE_DAYS, updatedAt: Date.now() }
}

// ---- live updates from runs -------------------------------------------------------------------

/** One finished AgentSwitch step: the CLI's own usage report (cost included when the CLI gives it). */
export function recordRun(profileId: ProfileId, u: Usage | null): void {
  migrate()
  const key = dayKey(Date.now())
  const days = (stats.runs[profileId] ??= {})
  days[key] = add(days[key] ?? zero(), { ...(u ?? {}), runs: 1 })
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

const codexPending = new Map<ProfileId, Promise<boolean>>()

export function refreshCodexLive(profileId: ProfileId): Promise<boolean> {
  if (hasProfile(profileId) && !hasSubscriptionQuota(getConfig(profileId))) return Promise.resolve(false)
  const running = codexPending.get(profileId)
  if (running) return running
  const p = new Promise<boolean>((resolve) => {
    const bin = kindBinaryPath('codex')
    if (!bin || !hasProfile(profileId)) return resolve(false)
    let env: NodeJS.ProcessEnv
    try {
      env = buildSpawnSpec(profileId, 'run').env
    } catch {
      return resolve(false)
    }
    const cwd = join(app.getPath('userData'), 'usage-probe')
    mkdirSync(cwd, { recursive: true })
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
    const proc = spawn(bin, ['app-server'], { env, cwd, stdio: ['pipe', 'pipe', 'ignore'] })
    const timer = setTimeout(() => finish(false), 15_000)
    proc.on('error', () => finish(false))
    proc.on('exit', () => finish(false))

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
      env = buildSpawnSpec(profileId, 'run').env
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

const agyPending = new Map<ProfileId, Promise<boolean>>()

/** false: no data (API-key login exits 2, not logged in, older agy, parse failure). */
export function refreshAgyQuota(profileId: ProfileId): Promise<boolean> {
  if (hasProfile(profileId) && !hasSubscriptionQuota(getConfig(profileId))) return Promise.resolve(false)
  const running = agyPending.get(profileId)
  if (running) return running
  const p = new Promise<boolean>((resolve) => {
    const bin = kindBinaryPath('gemini')
    if (!bin || !hasProfile(profileId)) return resolve(false)
    let env: NodeJS.ProcessEnv
    try {
      env = buildSpawnSpec(profileId, 'run').env
    } catch {
      return resolve(false)
    }
    const cwd = join(app.getPath('userData'), 'usage-probe')
    mkdirSync(cwd, { recursive: true })
    execFile(bin, ['-p', '/usage', '--output-format', 'json'], { env, cwd, timeout: 45_000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err && (err as { code?: unknown }).code === 2) {
        // GEMINI_API_KEY: no account quota exists; keep local stats only
        setQuotaError(profileId, null)
        if (quotas[profileId]?.source === 'agy-usage') {
          delete quotas[profileId]
          changed()
        }
        return resolve(false)
      }
      try {
        const jsonLine = String(stdout).trim().split('\n').filter((l) => l.startsWith('{')).pop()
        const d = jsonLine ? JSON.parse(jsonLine) : null
        if (d?.error) {
          setQuotaError(profileId, String(d.error))
          return resolve(false)
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
          const fallback = String(stderr || '').trim().split('\n').find((l) => l.trim()) || (err ? err.message : null)
          if (fallback) setQuotaError(profileId, fallback)
          return resolve(false)
        }
        const main = groups.find((g) => g.key === 'gemini') ?? groups[0]
        const limited = [main.fiveHour, main.sevenDay].some((w) => !!w && w.percent >= 100 && (!w.resetsAt || w.resetsAt > Date.now()))
        recordQuota(profileId, { fiveHour: main.fiveHour, sevenDay: main.sevenDay, limited, plan: null, groups }, 'agy-usage')
        resolve(true)
      } catch (e) {
        const fallback = String(stderr || '').trim().split('\n').find((l) => l.trim()) || (err ? err.message : e instanceof Error ? e.message : String(e))
        if (fallback) setQuotaError(profileId, fallback)
        resolve(false)
      }
    })
  }).finally(() => agyPending.delete(profileId))
  agyPending.set(profileId, p)
  return p
}

// ---- history backfill ---------------------------------------------------------------------------

async function claudeFileDays(path: string, since: number, cut: number): Promise<Days> {
  // the same API message is split over several records with the same usage: keep one per id
  const msgs = new Map<string, { ts: number; u: any }>()
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
    if (!ts || ts < since || (cut > 0 && ts > cut)) continue
    msgs.set(String(d.message.id ?? d.uuid), { ts, u: d.message.usage })
  }
  const days: Days = {}
  for (const { ts, u } of msgs.values()) {
    const k = dayKey(ts)
    days[k] = add(days[k] ?? zero(), {
      input: u.input_tokens,
      output: u.output_tokens,
      cacheRead: u.cache_read_input_tokens,
      cacheWrite: u.cache_creation_input_tokens
    })
  }
  return days
}

async function codexFileDays(path: string, cut: number): Promise<Days> {
  // token_count carries running totals: attribute each increase to its day
  const days: Days = {}
  let prev: any = null
  const rl = createInterface({ input: createReadStream(path, { encoding: 'utf8' }), crlfDelay: Infinity })
  for await (const line of rl) {
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
    if (!ts || (cut > 0 && ts > cut)) continue
    if (!inc.input && !inc.out) continue
    const k = dayKey(ts)
    days[k] = add(days[k] ?? zero(), { input: Math.max(0, inc.input - inc.cached), cacheRead: inc.cached, cacheWrite: inc.cw, output: inc.out, reasoning: inc.rs })
  }
  return days
}

/**
 * agy: conversations/<id>.db gen_metadata = one row per model call; protobuf 1.4 is its usage
 * (2 uncached input · 3 output incl. thinking · 5 cache read · 9 thinking). Reverse-engineered
 * from agy 1.5.13 (checked: 3 == 9 + 10 on every row); unknown layouts simply count nothing.
 * Time: 1.20 {last_step_index} -> steps.step_payload 5.1.1 (seconds).
 */
function agyFileDays(path: string, cut: number, fallbackTs: number): Days {
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
    if (cut > 0 && ts > cut) continue
    const input = int(b, 2)
    const output = int(b, 3)
    if (!input && !output) continue
    const k = dayKey(ts)
    days[k] = add(days[k] ?? zero(), { input, output, cacheRead: int(b, 5), reasoning: int(b, 9) })
  }
  return days
}

let backfillRunning: Promise<void> | null = null

/** Incremental: only files whose size/mtime changed are re-read. Never blocks a run. */
export function runBackfill(): Promise<void> {
  if (backfillRunning) return backfillRunning
  backfillRunning = (async () => {
    backfill = 'running'
    changed()
    try {
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
          const days = e.kind === 'claude' ? await claudeFileDays(path, since, cut) : e.kind === 'codex' ? await codexFileDays(path, cut) : agyFileDays(path, cut, e.updatedAt || st.mtimeMs)
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
        const dir = join(app.getPath('userData'), 'usage-probe')
        mkdirSync(dir, { recursive: true })
        let usage: Usage | null = null
        const h = runAgent(
          { cfg: { ...c, autoApprove: 'edits' }, model: 'haiku', prompt: 'Reply with exactly: OK', system: null, cwd: dir, images: [], resume: null, outDir: dir },
          (e) => {
            if (e.t === 'quota') recordQuota(c.id, e.quota, 'claude-stream')
            if (e.t === 'usage') usage = { ...(usage ?? {}), ...e.usage }
            if (e.t === 'rate_limited') recordLimited(c.id)
          },
          () => {}
        )
        await h.done
        recordRun(c.id, usage)
      })
  )
  await Promise.all([codexTask, agyTask, claudeTask])
  void runBackfill()
  changed()
  return snapshot()
}

/** Startup: backfill in the background, after the window is up. */
export function startUsage(): void {
  for (const c of listConfigs()) if (c.kind === 'codex') refreshCodexQuota(c.id)
  setTimeout(() => {
    for (const c of listConfigs()) {
      if (c.kind === 'reasonix' || !isLoggedIn(c.id)) continue
      if (c.kind === 'gemini') void refreshAgyQuota(c.id)
      else if (c.kind === 'codex') void refreshCodexLive(c.id)
      else if (c.kind === 'claude') void refreshClaudeOauth(c.id)
    }
  }, 4000)
  setTimeout(() => void runBackfill(), 8000)
  setInterval(() => void runBackfill(), 30 * 60_000)
}
