import { app } from 'electron'
import { closeSync, copyFileSync, createReadStream, existsSync, mkdtempSync, openSync, readdirSync, readFileSync, readSync, realpathSync, rmSync, statSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { LEGACY_USER_DATA } from './legacy'
import { createInterface } from 'node:readline'
import { createTwoFilesPatch } from 'diff'
import { DatabaseSync } from 'node:sqlite'
import type { AgentEvent, HistoryActivity, HistoryEntry, HistoryMessage, HistoryThread, ProfileConfig, ProfileId } from '@shared/types'
import { agyTool, capJson, capText, claudeResult, claudeTool, createdDiff, unwrapShell } from './agentRunner'
import { expandHome, listConfigs } from './profiles'

/**
 * Local CLI history (strictly read-only): claude ~/.claude/projects/*.jsonl, codex
 * $CODEX_HOME/state_*.sqlite + rollout jsonl, agy ~/.gemini/antigravity-cli sqlite (+ protobuf
 * steps). Never writes to, locks or checkpoints any CLI file; sqlite opens read-only, and falls
 * back to a private temp copy if that fails.
 */

type Act = Extract<AgentEvent, { t: 'activity' }>

const HEAD = 256 * 1024
const TAIL = 256 * 1024
const MAX_MESSAGES = 400
/** Prompts AgentSwitch itself sends to the CLIs (its own runs are not "history"). */
/** Folders AgentSwitch runs in itself (private workspaces, usage probes), incl. the AgentMux-era userData. */
const isOwnDir = (cwd: string, userData: string): boolean => cwd.startsWith(userData) || cwd.startsWith(LEGACY_USER_DATA)
const OWN_PROMPT_RE = /^\s*(你在 (?:AgentSwitch|AgentMux) 中工作|## (之前的对话|用户消息|用户原始消息|用户附件|本轮前序步骤|你的任务))/

export const toMs = (v: unknown): number => {
  if (typeof v === 'number' && isFinite(v)) return v > 1e12 ? v : v > 1e9 ? v * 1000 : 0
  if (typeof v === 'string' && v) {
    if (/^\d+$/.test(v)) return toMs(Number(v))
    const t = Date.parse(v.replace(' ', 'T').replace(/(\.\d{3})\d+/, '$1'))
    return isNaN(t) || t < 1e11 ? 0 : t // '0001-01-01' = unset
  }
  return 0
}
const oneLine = (s: string, n = 60): string => {
  const t = s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
  return t.length > n ? t.slice(0, n) + '…' : t
}
const fileUri = (u: string): string => (u.startsWith('file://') ? decodeURIComponent(u.slice(7)) : u)
const isDir = (p: string | null): boolean => {
  try {
    return !!p && statSync(p).isDirectory()
  } catch {
    return false
  }
}

// ---- AgentSwitch's own sessions (hidden) / imported (kept) -----------------------------------------

/** CLI sessions of chats deleted in AgentSwitch (userData/deleted-sessions.json): never listed again. */
export function deletedSessions(): Set<string> {
  try {
    const j = JSON.parse(readFileSync(join(app.getPath('userData'), 'deleted-sessions.json'), 'utf8'))
    return new Set(Array.isArray(j) ? j.filter((x: unknown): x is string => typeof x === 'string') : [])
  } catch {
    return new Set()
  }
}

export function ownSessions(): Set<string> {
  const out = deletedSessions()
  const dir = join(app.getPath('userData'), 'threads')
  let files: string[] = []
  try {
    files = readdirSync(dir)
  } catch {
    return out
  }
  for (const f of files) {
    try {
      const j = JSON.parse(readFileSync(join(dir, f), 'utf8')) as { sessions?: Record<string, string>; imported?: string[] }
      const imp = new Set(j.imported ?? [])
      for (const sid of Object.values(j.sessions ?? {})) if (!imp.has(sid)) out.add(sid)
    } catch {
      /* skip */
    }
  }
  return out
}

/** Imported native sessions -> import time: later turns are AgentSwitch's own (counted as runs). */
export function importedCutoffs(): Map<string, number> {
  const out = new Map<string, number>()
  const dir = join(app.getPath('userData'), 'threads')
  let files: string[] = []
  try {
    files = readdirSync(dir)
  } catch {
    return out
  }
  for (const f of files) {
    try {
      const j = JSON.parse(readFileSync(join(dir, f), 'utf8')) as { imported?: string[]; importedAt?: Record<string, number> }
      for (const sid of j.imported ?? []) out.set(sid, Math.min(out.get(sid) ?? Infinity, j.importedAt?.[sid] ?? 0))
    } catch {
      /* skip */
    }
  }
  return out
}

// ---- sqlite (read-only) ---------------------------------------------------------------------------

export function withDb<T>(path: string, fn: (db: DatabaseSync) => T): T | null {
  if (!existsSync(path)) return null
  try {
    const db = new DatabaseSync(path, { readOnly: true })
    try {
      return fn(db)
    } finally {
      db.close()
    }
  } catch {
    // e.g. WAL db without a -shm we may create: read a private copy instead
    let tmp: string | null = null
    try {
      tmp = mkdtempSync(join(tmpdir(), 'agentswitch-hist-'))
      const dst = join(tmp, basename(path))
      copyFileSync(path, dst)
      for (const ext of ['-wal', '-shm']) if (existsSync(path + ext)) copyFileSync(path + ext, dst + ext)
      const db = new DatabaseSync(dst, { readOnly: false })
      try {
        return fn(db)
      } finally {
        db.close()
      }
    } catch {
      return null
    } finally {
      if (tmp) rmSync(tmp, { recursive: true, force: true })
    }
  }
}

// ---- claude -----------------------------------------------------------------------------------------

interface ClaudeMeta {
  size: number
  mtime: number
  sessionId: string
  title: string | null
  firstPrompt: string | null
  cwd: string | null
  accountUuid: string | null
  createdAt: number
  updatedAt: number
}

const indexFile = (): string => join(app.getPath('userData'), 'history-index.v1.json')
let claudeIndex: Record<string, ClaudeMeta> | null = null
function loadIndex(): Record<string, ClaudeMeta> {
  if (claudeIndex) return claudeIndex
  try {
    claudeIndex = JSON.parse(readFileSync(indexFile(), 'utf8'))
  } catch {
    claudeIndex = {}
  }
  return claudeIndex!
}

/** Records that never matter for display (big request caches etc.); they start with `{"type":`. */
const CLAUDE_SKIP_RE = /^\{"type":"(api-request|file-history|attachment|deferred|data-flow|tools-used|mcp_|agent_listing|skill_listing|prompt_snapshot|cost-state|hook_|queue-operation|atis-latch|mode"|permission-mode|last-prompt)/

function readSlice(fd: number, pos: number, len: number): string {
  const buf = Buffer.alloc(len)
  const n = readSync(fd, buf, 0, len, pos)
  return buf.subarray(0, n).toString('utf8')
}

function userText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((b: any) => (b?.type === 'text' ? String(b.text ?? '') : b?.type === 'image' ? '[图片]' : ''))
    .filter(Boolean)
    .join('\n')
}

/** User text as shown: drops harness wrappers; '' = not a real user turn. */
function cleanClaudeUser(raw: string): string {
  let t = raw.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
  const cmd = /<command-name>([^<]*)<\/command-name>/.exec(t)
  if (cmd) {
    const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(t)?.[1]?.trim()
    return `${cmd[1].trim()}${args ? ' ' + args : ''}`
  }
  if (/^\s*<(local-command-stdout|local-command-stderr|local-command-caveat|bash-stdout|bash-stderr)>/.test(t)) return ''
  if (/^\s*\[Request interrupted/.test(t)) return ''
  t = t.trim()
  return t
}

function scanClaude(path: string, size: number, mtime: number): ClaudeMeta {
  const m: ClaudeMeta = { size, mtime, sessionId: basename(path, '.jsonl'), title: null, firstPrompt: null, cwd: null, accountUuid: null, createdAt: 0, updatedAt: mtime }
  let fd: number | null = null
  try {
    fd = openSync(path, 'r')
    const chunks = size <= HEAD + TAIL ? [readSlice(fd, 0, size)] : [readSlice(fd, 0, HEAD), readSlice(fd, size - TAIL, TAIL)]
    let custom: string | null = null
    let ai: string | null = null
    let summary: string | null = null
    chunks.forEach((chunk, ci) => {
      const lines = chunk.split('\n')
      // partial lines at chunk boundaries can't be parsed
      if (chunks.length > 1) ci === 0 ? lines.pop() : lines.shift()
      for (const line of lines) {
        if (!line || CLAUDE_SKIP_RE.test(line)) continue
        let d: any
        try {
          d = JSON.parse(line)
        } catch {
          continue
        }
        if (d.type === 'custom-title') custom = String(d.customTitle ?? d.title ?? '') || custom
        else if (d.type === 'ai-title') ai = String(d.aiTitle ?? '') || ai
        else if (d.type === 'summary') summary = String(d.summary ?? '') || summary
        else if (d.type === 'session-owner') m.accountUuid = d.accountUuid ?? m.accountUuid
        if (d.timestamp) {
          const t = toMs(d.timestamp)
          if (t && (!m.createdAt || t < m.createdAt)) m.createdAt = t
        }
        if (!m.cwd && typeof d.cwd === 'string') m.cwd = d.cwd
        if (ci === 0 && !m.firstPrompt && d.type === 'user' && !d.isMeta && !d.isSidechain) {
          const t = cleanClaudeUser(userText(d.message?.content))
          if (t) m.firstPrompt = t.slice(0, 400)
        }
      }
    })
    m.title = custom || ai || summary
  } catch {
    /* unreadable: listed with fallbacks */
  } finally {
    if (fd !== null) closeSync(fd)
  }
  if (!m.createdAt) m.createdAt = mtime
  return m
}

/** sessionId -> { profile, first prompt, project } from each account's own history.jsonl. */
function claudeOwners(profiles: ProfileConfig[]): Map<string, { profileId: ProfileId; display: string; project: string | null }> {
  const out = new Map<string, { profileId: ProfileId; display: string; project: string | null }>()
  for (const p of profiles) {
    let text = ''
    try {
      text = readFileSync(join(expandHome(p.configDir), 'history.jsonl'), 'utf8')
    } catch {
      continue
    }
    for (const line of text.split('\n')) {
      if (!line) continue
      try {
        const d = JSON.parse(line)
        if (typeof d.sessionId === 'string' && !out.has(d.sessionId)) out.set(d.sessionId, { profileId: p.id, display: String(d.display ?? ''), project: typeof d.project === 'string' ? d.project : null })
      } catch {
        /* skip */
      }
    }
  }
  return out
}

/** oauthAccount.accountUuid per profile (from .claude.json; no secrets read). */
function claudeAccountIds(profiles: ProfileConfig[]): Map<string, ProfileId> {
  const out = new Map<string, ProfileId>()
  for (const p of profiles) {
    const dir = expandHome(p.configDir)
    const home = expandHome('~')
    const cands = [join(dir, '.claude.json'), ...(dir.replace(/\/$/, '') === join(home, '.claude') ? [join(home, '.claude.json')] : [])]
    for (const f of cands) {
      try {
        const id = JSON.parse(readFileSync(f, 'utf8'))?.oauthAccount?.accountUuid
        if (typeof id === 'string') {
          out.set(id, p.id)
          break
        }
      } catch {
        /* next */
      }
    }
  }
  return out
}

function listClaude(profiles: ProfileConfig[], own: Set<string>, userData: string): HistoryEntry[] {
  if (!profiles.length) return []
  const owners = claudeOwners(profiles)
  const accounts = claudeAccountIds(profiles)
  // accounts sharing one projects dir (e.g. ~/.claude2/projects -> ~/.claude/projects)
  const groups = new Map<string, ProfileConfig[]>()
  for (const p of profiles) {
    try {
      const real = realpathSync(join(expandHome(p.configDir), 'projects'))
      groups.set(real, [...(groups.get(real) ?? []), p])
    } catch {
      /* no projects dir */
    }
  }
  const index = loadIndex()
  const seen = new Set<string>()
  const out: HistoryEntry[] = []
  let dirty = false
  for (const [root, group] of groups) {
    let dirs: string[] = []
    try {
      dirs = readdirSync(root)
    } catch {
      continue
    }
    for (const d of dirs) {
      let files: string[] = []
      try {
        files = readdirSync(join(root, d)).filter((f) => f.endsWith('.jsonl')) // depth 2 only: subagent files live deeper
      } catch {
        continue
      }
      for (const f of files) {
        const path = join(root, d, f)
        let st: ReturnType<typeof statSync>
        try {
          st = statSync(path)
        } catch {
          continue
        }
        if (!st.isFile()) continue
        let meta = index[path]
        if (!meta || meta.size !== st.size || meta.mtime !== st.mtimeMs) {
          meta = scanClaude(path, st.size, st.mtimeMs)
          index[path] = meta
          dirty = true
        }
        seen.add(path)
        const sid = meta.sessionId
        if (own.has(sid)) continue
        const owner = owners.get(sid)
        if (meta.firstPrompt && OWN_PROMPT_RE.test(meta.firstPrompt)) continue
        if (!meta.firstPrompt && !meta.title && !owner?.display) continue // empty session
        if (meta.cwd && isOwnDir(meta.cwd, userData)) continue
        const profileId = owner?.profileId ?? (meta.accountUuid ? accounts.get(meta.accountUuid) : undefined) ?? group[0].id
        out.push({
          key: `${profileId}:${sid}`,
          profileId,
          kind: 'claude',
          nativeId: sid,
          title: oneLine(meta.title || meta.firstPrompt || owner?.display || '未命名会话'),
          cwd: meta.cwd ?? owner?.project ?? null,
          createdAt: meta.createdAt,
          updatedAt: meta.updatedAt
        })
      }
    }
  }
  for (const k of Object.keys(index))
    if (!seen.has(k)) {
      delete index[k]
      dirty = true
    }
  if (dirty)
    try {
      writeFileSync(indexFile(), JSON.stringify(index))
    } catch {
      /* cache only */
    }
  return out
}

function newAssistant(at: number, model: string | null): Extract<HistoryMessage, { role: 'assistant' }> {
  return { role: 'assistant', text: '', thinking: '', activity: [], outputs: [], model, at, endAt: at }
}
const asHist = (a: Act): HistoryActivity => ({ id: a.id, type: a.type, target: a.target, status: a.status === 'running' ? 'done' : a.status, detail: a.detail })

async function parseClaude(path: string): Promise<HistoryMessage[]> {
  const msgs: HistoryMessage[] = []
  let cur: Extract<HistoryMessage, { role: 'assistant' }> | null = null
  let lastMsgId: string | null = null
  const tools = new Map<string, { name: string; input: Record<string, any>; act: Act; msg: Extract<HistoryMessage, { role: 'assistant' }>; i: number }>()
  const rl = createInterface({ input: createReadStream(path, { encoding: 'utf8' }), crlfDelay: Infinity })
  for await (const line of rl) {
    if (!line || line.startsWith('{"type":')) continue // user/assistant records start with parentUuid
    let d: any
    try {
      d = JSON.parse(line)
    } catch {
      continue
    }
    if ((d.type !== 'user' && d.type !== 'assistant') || d.isSidechain) continue
    const at = toMs(d.timestamp) || Date.now()
    const content = d.message?.content
    if (d.type === 'user') {
      if (Array.isArray(content))
        for (const b of content) {
          if (b?.type !== 'tool_result') continue
          const t = tools.get(b.tool_use_id)
          if (!t) continue
          const done = claudeResult(t.name, t.input, t.act, b, d.toolUseResult)
          t.msg.activity[t.i] = asHist(done)
          t.msg.endAt = at
        }
      if (d.isMeta || d.isCompactSummary) continue
      const text = cleanClaudeUser(userText(content))
      if (!text) continue
      msgs.push({ role: 'user', text, at })
      cur = null
      lastMsgId = null
      continue
    }
    if (!Array.isArray(content)) continue
    if (!cur) {
      cur = newAssistant(at, d.message?.model ?? null)
      msgs.push(cur)
    }
    cur.endAt = at
    if (d.message?.model && d.message.model !== '<synthetic>') cur.model = d.message.model
    const newMsg = d.message?.id && d.message.id !== lastMsgId
    lastMsgId = d.message?.id ?? lastMsgId
    for (const b of content) {
      if (b?.type === 'text' && b.text) {
        cur.text += (cur.text && newMsg ? '\n\n' : '') + b.text
      } else if (b?.type === 'thinking' && b.thinking) {
        cur.thinking += (cur.thinking ? '\n\n' : '') + b.thinking
      } else if (b?.type === 'tool_use') {
        const input = b.input && typeof b.input === 'object' ? b.input : {}
        const act = claudeTool(String(b.id), String(b.name), input)
        if (!act) continue
        cur.activity.push(asHist(act))
        tools.set(String(b.id), { name: String(b.name), input, act, msg: cur, i: cur.activity.length - 1 })
      }
    }
  }
  return msgs
}

// ---- codex ------------------------------------------------------------------------------------------

function codexDb(home: string): string | null {
  try {
    const f = readdirSync(home)
      .map((n) => /^state_(\d+)\.sqlite$/.exec(n))
      .filter((m): m is RegExpExecArray => !!m)
      .sort((a, b) => Number(b[1]) - Number(a[1]))[0]
    return f ? join(home, f[0]) : null
  } catch {
    return null
  }
}

export const rolloutPaths = new Map<string, string>() // codex thread id -> rollout file

function listCodex(p: ProfileConfig, own: Set<string>, userData: string): HistoryEntry[] {
  const home = expandHome(p.configDir)
  const db = codexDb(home)
  const rows: Record<string, any>[] = (db ? withDb(db, (d) => d.prepare('select * from threads where coalesce(archived, 0) = 0').all() as Record<string, any>[]) : null) ?? []
  const out: HistoryEntry[] = []
  for (const r of rows) {
    const id = String(r.id ?? '')
    if (!id || own.has(id)) continue
    const src = String(r.source ?? '')
    if (src.startsWith('{') || /subagent|guardian/i.test(src) || r.attached_thread_parent_id || r.agent_role) continue
    const first = String(r.first_user_message ?? r.preview ?? '')
    if (OWN_PROMPT_RE.test(first)) continue
    const cwd = typeof r.cwd === 'string' && r.cwd ? fileUri(r.cwd) : null
    if ((!!cwd && isOwnDir(cwd, userData))) continue
    const rollout = typeof r.rollout_path === 'string' ? r.rollout_path : null
    if (!rollout || !existsSync(rollout)) continue
    if (r.has_user_event === 0 && !first) continue
    rolloutPaths.set(id, rollout)
    out.push({
      key: `${p.id}:${id}`,
      profileId: p.id,
      kind: 'codex',
      nativeId: id,
      title: oneLine(String(r.name || r.title || first || '未命名会话')),
      cwd,
      createdAt: toMs(r.created_at_ms) || toMs(r.created_at),
      updatedAt: toMs(r.updated_at_ms) || toMs(r.updated_at) || toMs(r.recency_at_ms)
    })
  }
  return out
}

function codexItem(cur: Extract<HistoryMessage, { role: 'assistant' }>, it: any): void {
  switch (it?.type) {
    case 'AgentMessage': {
      const t = (Array.isArray(it.content) ? it.content : []).map((c: any) => String(c?.text ?? '')).join('')
      if (t.trim()) cur.text += (cur.text ? '\n\n' : '') + t
      return
    }
    case 'Reasoning': {
      const t = (Array.isArray(it.summary_text) ? it.summary_text : [])
        .map((s: any) => String(typeof s === 'string' ? s : (s?.text ?? '')))
        .join('\n\n')
        .replace(/\*\*/g, '')
        .trim()
      if (t) cur.thinking += (cur.thinking ? '\n\n' : '') + t
      return
    }
    case 'CommandExecution': {
      const raw = Array.isArray(it.command) ? (it.command.length >= 3 && /sh$/.test(String(it.command[0])) ? String(it.command[it.command.length - 1]) : it.command.join(' ')) : String(it.command ?? '')
      const cmd = unwrapShell(raw)
      const code = typeof it.exit_code === 'number' ? it.exit_code : null
      cur.activity.push({
        id: it.id,
        type: 'run',
        target: cmd.slice(0, 300),
        status: code !== null && code !== 0 ? 'error' : 'done',
        detail: { tool: 'command_execution', input: capText(cmd, 4096), output: capText(it.aggregated_output ?? ''), exitCode: code }
      })
      return
    }
    case 'FileChange': {
      const ch = it.changes
      const list: { path: string; c: any }[] = Array.isArray(ch) ? ch.map((c: any) => ({ path: String(c?.path ?? ''), c })) : ch && typeof ch === 'object' ? Object.entries(ch).map(([path, c]) => ({ path, c })) : []
      for (const { path, c } of list) {
        let diff: string | undefined
        if (c?.type === 'add' && typeof c.content === 'string') diff = createdDiff(path, c.content)
        else if (typeof c?.unified_diff === 'string') diff = `--- a/${path}\n+++ b/${path}\n${c.unified_diff}`
        cur.activity.push({ id: `${it.id}:${path}`, type: 'write', target: path, status: it.status === 'failed' ? 'error' : 'done', detail: { tool: c?.type === 'delete' ? 'delete' : 'apply_patch', diff: diff ? capText(diff, 16 * 1024) : undefined } })
        if (c?.type === 'add') cur.outputs.push(path)
      }
      return
    }
    case 'McpToolCall':
      cur.activity.push({
        id: it.id,
        type: 'tool',
        target: `${it.server ?? 'mcp'}.${it.tool ?? ''}`,
        status: it.status === 'failed' ? 'error' : 'done',
        detail: { tool: `${it.server}.${it.tool}`, input: capJson(it.arguments ?? {}), output: it.result !== undefined ? capJson(it.result, 8192) : undefined }
      })
      return
    case 'Extension':
      if (it.kind === 'web.search' || it.query)
        cur.activity.push({ id: it.id, type: 'search', target: String(it.query ?? it.action?.url ?? ''), status: 'done', detail: { tool: String(it.kind ?? 'web'), input: capJson(it.action ?? it.query ?? '') } })
      return
    case 'ImageView':
      cur.activity.push({ id: it.id, type: 'read', target: fileUri(String(it.path ?? '')), status: 'done', detail: { tool: 'view_image' } })
      return
  }
}

/** Codex desktop wraps answers to its in-chat questions in a protocol tag: show them readably. */
function codexUserText(text: string): string {
  const m = /^<send_user_message_question_reply>\s*([\s\S]*?)\s*<\/send_user_message_question_reply>$/.exec(text)
  if (!m) return text
  try {
    const items = JSON.parse(m[1]) as { question?: string; answer?: string }[]
    if (!Array.isArray(items)) return text
    return items
      .map((q) => `回答提问「${oneLine(String(q.question ?? ''), 80)}」\n${String(q.answer ?? '').trim()}`)
      .join('\n\n')
  } catch {
    return text
  }
}

async function parseCodex(path: string): Promise<HistoryMessage[]> {
  const msgs: HistoryMessage[] = []
  const fallback: HistoryMessage[] = [] // older rollouts without item_completed events
  let cur: Extract<HistoryMessage, { role: 'assistant' }> | null = null
  let model: string | null = null
  let sawItems = false
  const rl = createInterface({ input: createReadStream(path, { encoding: 'utf8' }), crlfDelay: Infinity })
  for await (const line of rl) {
    if (!line) continue
    let d: any
    try {
      d = JSON.parse(line)
    } catch {
      continue
    }
    const p = d.payload ?? {}
    const at = toMs(d.timestamp) || Date.now()
    if (d.type === 'turn_context' && p.model) model = String(p.model)
    if (d.type === 'event_msg' && p.type === 'item_completed') {
      sawItems = true
      const it = p.item
      if (it?.type === 'UserMessage') {
        const text = (Array.isArray(it.content) ? it.content : []).map((c: any) => (c?.type === 'text' ? String(c.text ?? '') : c?.type ? '[图片]' : '')).join('\n').trim()
        if (text) msgs.push({ role: 'user', text: codexUserText(text), at })
        cur = null
        continue
      }
      if (it?.type === 'ContextCompaction') continue
      if (!cur) {
        cur = newAssistant(at, model)
        msgs.push(cur)
      }
      cur.endAt = at
      cur.model = model ?? cur.model
      codexItem(cur, it)
    } else if (!sawItems && d.type === 'response_item' && p.type === 'message' && (p.role === 'user' || p.role === 'assistant')) {
      const text = (Array.isArray(p.content) ? p.content : []).map((c: any) => String(c?.text ?? '')).join('').trim()
      if (!text || /^<(environment_context|user_instructions|permissions|turn_aborted)/.test(text)) continue
      if (p.role === 'user') fallback.push({ role: 'user', text, at })
      else {
        const a = newAssistant(at, model)
        a.text = text
        fallback.push(a)
      }
    }
  }
  return sawItems ? msgs.filter((m) => m.role === 'user' || m.text || m.activity.length || m.thinking) : fallback
}

// ---- agy (protobuf steps, schema reverse-engineered: field paths may change) -----------------------

type Pb = Map<number, (number | Buffer)[]>

function varint(b: Buffer, i: number): [number, number] {
  let r = 0
  let s = 1
  for (;;) {
    if (i >= b.length) throw new Error('eof')
    const x = b[i++]
    r += (x & 0x7f) * s
    if (x < 0x80) return [r, i]
    s *= 128
    if (s > 2 ** 63) throw new Error('varint')
  }
}

function pb(b: Buffer): Pb | null {
  const out: Pb = new Map()
  let i = 0
  try {
    while (i < b.length) {
      let k: number
      ;[k, i] = varint(b, i)
      const f = Math.floor(k / 8)
      const w = k % 8
      if (f === 0) return null
      let v: number | Buffer
      if (w === 0) [v, i] = varint(b, i)
      else if (w === 1) {
        v = 0
        i += 8
      } else if (w === 5) {
        v = 0
        i += 4
      } else if (w === 2) {
        let n: number
        ;[n, i] = varint(b, i)
        if (i + n > b.length) return null
        v = b.subarray(i, i + n)
        i += n
      } else return null
      if (i > b.length) return null
      out.set(f, [...(out.get(f) ?? []), v])
    }
    return out
  } catch {
    return null
  }
}

/** All values at a field path (e.g. [20, 7]); intermediate fields are decoded as messages. */
export function pbAll(b: Buffer | null, path: number[]): (number | Buffer)[] {
  if (!b) return []
  let cur: (number | Buffer)[] = [b]
  for (const f of path) {
    const next: (number | Buffer)[] = []
    for (const v of cur) {
      if (!Buffer.isBuffer(v)) continue
      const m = pb(v)
      if (m) next.push(...(m.get(f) ?? []))
    }
    cur = next
  }
  return cur
}
const pbStr = (b: Buffer | null, path: number[]): string => {
  const v = pbAll(b, path)[0]
  return Buffer.isBuffer(v) ? v.toString('utf8') : ''
}

const AGY_USER = 14
const AGY_AGENT = 15
const AGY_TOOL = 132

const agyDir = (p: ProfileConfig): string => join(expandHome(p.configDir), '.gemini', 'antigravity-cli')
export const agyConversationDb = (p: ProfileConfig, id: string): string => join(agyDir(p), 'conversations', `${id}.db`)
const agyPreview = new Map<string, string>()

function listAgy(p: ProfileConfig, own: Set<string>, userData: string): HistoryEntry[] {
  const dir = agyDir(p)
  const rows = withDb(join(dir, 'conversation_summaries.db'), (d) => d.prepare('select * from conversation_summaries').all() as Record<string, any>[]) ?? []
  const out: HistoryEntry[] = []
  for (const r of rows) {
    const id = String(r.conversation_id ?? '')
    if (!id || own.has(id)) continue
    if (r.parent_conversation_id || Number(r.nesting_depth ?? 0) > 0) continue
    const preview = String(r.preview ?? '')
    if (OWN_PROMPT_RE.test(preview)) continue
    if (!preview && !r.title && !Number(r.step_count ?? 0)) continue // empty conversation
    const db = join(dir, 'conversations', `${id}.db`)
    if (!existsSync(db)) continue
    let cwd: string | null = null
    try {
      const ws = JSON.parse(String(r.workspace_uris || '[]'))
      if (Array.isArray(ws) && typeof ws[0] === 'string') cwd = fileUri(ws[0])
    } catch {
      /* none */
    }
    if ((!!cwd && isOwnDir(cwd, userData))) continue
    let created = 0
    try {
      created = statSync(db).birthtimeMs
    } catch {
      /* ignore */
    }
    agyPreview.set(id, preview)
    out.push({
      key: `${p.id}:${id}`,
      profileId: p.id,
      kind: 'gemini',
      nativeId: id,
      title: oneLine(String(r.title || preview || '未命名会话')),
      cwd,
      createdAt: created || toMs(r.last_modified_time),
      updatedAt: toMs(r.last_modified_time) || toMs(r.last_user_input_time)
    })
  }
  return out
}

/** agy history keeps edit arguments (not file contents): show them as a diff of the edited span. */
function agyDiff(file: string, args: Record<string, any>): string | undefined {
  const content = args.Content ?? args.CodeContent ?? args.content
  if (typeof content === 'string') return capText(createdDiff(file, content), 16 * 1024)
  const before = args.TargetContent ?? args.Target ?? args.target
  const after = args.ReplacementContent ?? args.Replacement ?? args.replacement
  if (typeof before === 'string' && typeof after === 'string')
    return capText(createTwoFilesPatch(`a/${file}`, `b/${file}`, before.endsWith('\n') ? before : before + '\n', after.endsWith('\n') ? after : after + '\n', '', '', { context: 3 }).replace(/^(Index:[^\n]*\n)?=+\n/, ''), 16 * 1024)
  return undefined
}

function parseAgy(p: ProfileConfig, id: string): HistoryMessage[] {
  const rows = withDb(join(agyDir(p), 'conversations', `${id}.db`), (d) => d.prepare('select idx, step_type, step_payload from steps order by idx').all() as { idx: number; step_type: number; step_payload: Uint8Array | null }[]) ?? []
  const msgs: HistoryMessage[] = []
  let cur: Extract<HistoryMessage, { role: 'assistant' }> | null = null
  const calls = new Map<string, { msg: Extract<HistoryMessage, { role: 'assistant' }>; i: number; name: string; args: any }>()
  let last = 0
  for (const r of rows) {
    if (!r.step_payload) continue
    const b = Buffer.from(r.step_payload)
    const sec = pbAll(b, [5, 1, 1])[0]
    const at = typeof sec === 'number' && sec > 1e9 ? sec * 1000 : last
    last = at
    if (r.step_type === AGY_USER) {
      const text = pbStr(b, [19, 2]).trim()
      if (text) msgs.push({ role: 'user', text, at })
      cur = null
    } else if (r.step_type === AGY_AGENT) {
      if (!cur) {
        cur = newAssistant(at, null)
        msgs.push(cur)
      }
      cur.endAt = at
      const text = pbStr(b, [20, 1]).trim()
      const thought = pbStr(b, [20, 3]).trim()
      if (text) cur.text += (cur.text ? '\n\n' : '') + text
      if (thought) cur.thinking += (cur.thinking ? '\n\n' : '') + thought
      for (const c of pbAll(b, [20, 7])) {
        if (!Buffer.isBuffer(c)) continue
        const callId = pbStr(c, [1])
        const name = pbStr(c, [2])
        let args: any = {}
        try {
          args = JSON.parse(pbStr(c, [3]) || '{}')
        } catch {
          /* raw */
        }
        const act = agyTool({ tool_name: name, tool_info: { parameters: args }, state: 'DONE', step_index: callId || r.idx })
        if (!act || !name) continue
        if (act.type === 'write') act.detail = { ...act.detail, diff: agyDiff(act.target, args) }
        cur.activity.push(asHist(act))
        if (callId) calls.set(callId, { msg: cur, i: cur.activity.length - 1, name, args })
      }
    } else if (r.step_type === AGY_TOOL) {
      const callId = pbStr(b, [5, 4, 1])
      const c = calls.get(callId)
      if (!c) continue
      const output = pbStr(b, [140, 2, 1])
      const act = agyTool({ tool_name: c.name, tool_info: { parameters: c.args, output }, state: 'DONE', step_index: callId })
      if (act?.type === 'write') act.detail = { ...act.detail, diff: agyDiff(act.target, c.args) }
      if (act) c.msg.activity[c.i] = asHist(act)
      c.msg.endAt = at
    }
  }
  return msgs
}

// ---- public API ---------------------------------------------------------------------------------------

let cache: { at: number; entries: HistoryEntry[] } | null = null

export function listHistory(force = false): HistoryEntry[] {
  if (!force && cache && Date.now() - cache.at < 20_000) return cache.entries
  const own = ownSessions()
  const userData = app.getPath('userData')
  const cfgs = listConfigs()
  const entries: HistoryEntry[] = []
  const safe = (fn: () => HistoryEntry[]): void => {
    try {
      entries.push(...fn())
    } catch {
      /* one source failing never blocks the others */
    }
  }
  safe(() => listClaude(cfgs.filter((c) => c.kind === 'claude'), own, userData))
  for (const c of cfgs) {
    if (c.kind === 'codex') safe(() => listCodex(c, own, userData))
    if (c.kind === 'gemini') safe(() => listAgy(c, own, userData))
  }
  entries.sort((a, b) => b.updatedAt - a.updatedAt)
  cache = { at: Date.now(), entries }
  return entries
}

export function claudePath(entry: HistoryEntry): string | null {
  const meta = Object.entries(loadIndex()).find(([, m]) => m.sessionId === entry.nativeId)
  return meta ? meta[0] : null
}

export async function openHistory(key: string): Promise<HistoryThread> {
  let entry = (cache?.entries ?? listHistory()).find((e) => e.key === key)
  if (!entry) entry = listHistory(true).find((e) => e.key === key)
  if (!entry) throw new Error('找不到这条历史记录（可能已被 CLI 删除）')
  const cfg = listConfigs().find((c) => c.id === entry!.profileId)
  let messages: HistoryMessage[] = []
  let notice: string | null = null
  try {
    if (entry.kind === 'claude') {
      const p = claudePath(entry)
      if (p) messages = await parseClaude(p)
    } else if (entry.kind === 'codex') {
      const p = rolloutPaths.get(entry.nativeId)
      if (p) messages = await parseCodex(p)
    } else if (cfg) messages = parseAgy(cfg, entry.nativeId)
  } catch (e) {
    notice = `解析中断：${String(e instanceof Error ? e.message : e)}`
  }
  if (!messages.length) {
    const preview = entry.kind === 'gemini' ? agyPreview.get(entry.nativeId) : null
    messages = preview ? [{ role: 'user', text: preview, at: entry.createdAt }] : []
    notice = '此对话格式无法完整解析，仅显示摘要。继续发消息仍会接着原会话。'
  }
  if (messages.length > MAX_MESSAGES) {
    notice = `对话较长，仅显示最近 ${MAX_MESSAGES} 条消息。`
    messages = messages.slice(-MAX_MESSAGES)
  }
  return { entry, messages, notice }
}

export const cwdExists = isDir

/** Handoff document export (fallback when the source account can't write one). */
export function writeHandoff(cwd: string, turnId: string, markdown: string): string {
  const dir = join(cwd, '.agentswitch', 'handoffs')
  mkdirSync(dir, { recursive: true })
  const base = join(cwd, '.agentswitch')
  if (!existsSync(join(base, '.gitignore'))) writeFileSync(join(base, '.gitignore'), '*\n')
  const file = join(dir, `${turnId.replace(/[^\w-]/g, '')}.md`)
  writeFileSync(file, markdown)
  return file
}
