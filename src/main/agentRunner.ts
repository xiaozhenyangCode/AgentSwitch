import { spawn, type ChildProcess } from 'node:child_process'
import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { AgentEvent, AutoApprove, ProfileConfig, QuotaWindow } from '@shared/types'
import { splitSpec } from '@shared/modelSpec'
import { buildSpawnSpec, expandHome, getConfig, kindBinaryPath } from './profiles'
import { agyModelId } from './models'
import { t } from './i18n'
import { isClaudeModelWarning, isInvalidKeyError } from './apiKey'

/**
 * Runs one non-interactive CLI turn through pipes (no PTY: clean NDJSON, no ANSI/line
 * wrapping) and normalises its event stream. Args are passed as an array, never through a
 * shell, so prompt text can't be interpreted as commands.
 *
 * Measured stream formats (2026-11-21):
 *   claude -p --output-format stream-json --verbose --include-partial-messages
 *   codex exec --json            (item-level events; no token deltas)
 *   agy -p --output-format stream-json
 */

export interface RunSpec {
  cfg: ProfileConfig
  model: string | null
  prompt: string
  /** Extra instructions (claude: --append-system-prompt; others: prefixed to the prompt). */
  system: string | null
  cwd: string
  /** Absolute image paths the model should see (codex: -i; others: listed in the prompt). */
  images: string[]
  /** Session to continue (claude --resume / codex exec resume / agy --conversation). */
  resume: string | null
  /** Where generated files must end up (codex built-in image gen is copied here). */
  outDir: string
}

export interface RunResult {
  ok: boolean
  stopped: boolean
  text: string
  sessionId: string | null
  model: string | null
  error: string | null
  rateLimited: boolean
}

export interface RunHandle {
  done: Promise<RunResult>
  kill: () => void
}

const RATE_LIMIT_RE = /rate[ _-]?limit(ed)?|usage limit|too many requests|quota exceeded|RESOURCE_EXHAUSTED/i
const IMAGE_RE = /\.(png|jpe?g|gif|webp|svg)$/i
const KILL_GRACE_MS = 3000

type Emit = (e: AgentEvent) => void

interface Adapter {
  args: string[]
  /** Prompt fed through stdin (claude, codex) or already in args (agy). */
  stdin: string | null
  onLine: (obj: any, emit: Emit) => void
  /** Called once after exit (e.g. codex image collection). */
  finish?: (emit: Emit) => void
  sessionId: () => string | null
  model: () => string | null
  /** Final result as reported by the CLI's own "done" event; null if it never arrived. */
  result: () => { ok: boolean; error: string | null } | null
}

const full = (s: RunSpec): string => (s.system ? `${s.system}\n\n---\n\n${s.prompt}` : s.prompt)

// ---- payload helpers -----------------------------------------------------------------------

const MAX_OUT = 8 * 1024
const MAX_IN = 4 * 1024
const MAX_OTHER = 4 * 1024

/** Keeps head and tail of long text (command output is most useful at both ends). */
export function capText(v: unknown, max = MAX_OUT): string {
  const s = typeof v === 'string' ? v : v === undefined || v === null ? '' : JSON.stringify(v, null, 2)
  if (s.length <= max) return s
  const half = Math.floor(max / 2)
  return `${s.slice(0, half)}\n${t('main.omitted', { n: s.length - max })}\n${s.slice(-half)}`
}

export const capJson = (v: unknown, max = MAX_IN): string => capText(typeof v === 'string' ? v : JSON.stringify(v, null, 2), max)

const other = (kind: string, payload: unknown): AgentEvent => ({ t: 'other_event', kind, payload: capText(payload, MAX_OTHER) })

/** Text of an Anthropic tool_result content (string or content blocks). */
export function resultText(c: unknown): string {
  if (typeof c === 'string') return c
  if (Array.isArray(c)) return c.map((b: any) => (b?.type === 'text' ? b.text : b?.type === 'image' ? t('main.image') : JSON.stringify(b))).join('\n')
  return c === undefined || c === null ? '' : JSON.stringify(c)
}

/** Claude's structuredPatch hunks → unified diff text. */
function patchText(file: string, hunks: any[]): string {
  const out = [`--- a/${file}`, `+++ b/${file}`]
  for (const h of hunks) {
    out.push(`@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`)
    for (const l of h.lines ?? []) out.push(String(l))
  }
  return capText(out.join('\n') + '\n', 16 * 1024)
}

/** Whole-file "created" diff. */
export function createdDiff(file: string, content: string): string {
  const lines = content.replace(/\n$/, '').split('\n')
  return capText([`--- /dev/null`, `+++ b/${file}`, `@@ -0,0 +1,${lines.length} @@`, ...lines.map((l) => '+' + l)].join('\n') + '\n', 16 * 1024)
}

/** `/bin/zsh -lc "cmd"` → `cmd` (codex wraps every command in a login shell). */
export function unwrapShell(cmd: string): string {
  const m = /^\/bin\/(?:ba|z)?sh -lc (?:(["'])([\s\S]*)\1|([^"'\s][\s\S]*))$/.exec(cmd.trim())
  if (!m) return cmd
  if (m[3] !== undefined) return m[3]
  return m[1] === '"' ? m[2].replace(/\\(["\\$`])/g, '$1') : m[2]
}

// ---- permissions: follow the CLI's own settings ----------------------------------------------

const readJson = (p: string): any => {
  try {
    return JSON.parse(readFileSync(p, 'utf8'))
  } catch {
    return null
  }
}
const CLAUDE_MODES = new Set(['acceptEdits', 'auto', 'bypassPermissions', 'dontAsk', 'plan'])
/** permissions.defaultMode as the terminal would see it (project local > project > user); 'auto' otherwise.
 *  'default' / 'manual' would only deny every prompt in -p mode, so they also map to auto. */
function claudeCliMode(cfg: ProfileConfig, cwd: string): string {
  const home = expandHome(cfg.configDir)
  const userDir = cfg.configDir === '~' || home === expandHome('~') ? expandHome('~/.claude') : home
  for (const f of [join(cwd, '.claude', 'settings.local.json'), join(cwd, '.claude', 'settings.json'), join(userDir, 'settings.json')]) {
    const m = readJson(f)?.permissions?.defaultMode
    if (typeof m === 'string' && m) return CLAUDE_MODES.has(m) ? m : 'auto'
  }
  return 'auto'
}
/** Top-level keys set in codex config.toml (user's own sandbox / approval choices win). */
function codexTopKeys(codexHome: string): Set<string> {
  const out = new Set<string>()
  try {
    for (const line of readFileSync(join(codexHome, 'config.toml'), 'utf8').split('\n')) {
      const l = line.trim()
      if (l.startsWith('[')) break
      const m = /^([\w-]+)\s*=/.exec(l)
      if (m) out.add(m[1])
    }
  } catch {
    /* no config */
  }
  return out
}

// ---- claude --------------------------------------------------------------------------------

function claudeAdapter(s: RunSpec): Adapter {
  let session: string | null = null
  let model: string | null = s.model
  let result: { ok: boolean; error: string | null } | null = null
  let textSoFar = ''
  let sawDelta = false
  let sawThinkingDelta = false
  /** Context size of the latest API request (result.usage sums all requests of the turn). */
  let lastContext = 0
  const tools = new Map<string, { name: string; input: Record<string, any>; activity: Extract<AgentEvent, { t: 'activity' }> | null }>()
  const args = [
    '-p',
    '--output-format',
    'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--permission-mode',
    s.cfg.autoApprove === 'full' ? 'bypassPermissions' : s.cfg.autoApprove === 'edits' ? 'acceptEdits' : claudeCliMode(s.cfg, s.cwd)
  ]
  const spec = splitSpec(s.model)
  if (spec.model) args.push('--model', spec.model)
  if (spec.effort) args.push('--effort', spec.effort)
  if (s.resume) args.push('--resume', s.resume)
  if (s.system) args.push('--append-system-prompt', s.system)
  const text = (delta: string, emit: Emit) => {
    textSoFar += delta
    emit({ t: 'text', delta })
  }
  // stream frames that only carry protocol structure (their content arrives elsewhere)
  const FRAMES = new Set(['message_start', 'message_delta', 'message_stop', 'content_block_stop', 'ping'])
  /** Tool call whose JSON arguments are still streaming in. */
  let toolInput: { name: string; bytes: number; sent: number; at: number } | null = null
  return {
    args,
    stdin: s.prompt,
    sessionId: () => session,
    model: () => model,
    result: () => result,
    onLine: (d, emit) => {
      switch (d.type) {
        case 'system':
          if (d.subtype === 'init') {
            session = d.session_id ?? session
            model = d.model ?? model
            emit({ t: 'session', id: session ?? '', model })
          } else if (d.subtype === 'thinking_tokens') {
            emit({ t: 'thinking', delta: '', tokens: Number(d.estimated_tokens) || undefined })
          } else emit(other(`system/${d.subtype ?? '?'}`, d))
          break
        case 'stream_event': {
          const ev = d.event ?? {}
          if (ev.type === 'content_block_stop' && toolInput) {
            toolInput = null
            emit({ t: 'phase', tool: null, bytes: 0 })
          }
          if (FRAMES.has(ev.type)) break
          if (ev.type === 'content_block_start') {
            const t = ev.content_block?.type
            // arguments stream in before the tool call is complete: report it right away
            if (t === 'tool_use' || t === 'server_tool_use') {
              toolInput = { name: String(ev.content_block?.name ?? 'tool'), bytes: 0, sent: 0, at: 0 }
              emit({ t: 'phase', tool: toolInput.name, bytes: 0 })
            }
            if (t === 'text' && textSoFar && !textSoFar.endsWith('\n\n')) text(textSoFar.endsWith('\n') ? '\n' : '\n\n', emit)
            else if (t === 'thinking' || t === 'redacted_thinking') emit({ t: 'thinking', delta: '' })
            else if (t !== 'text' && t !== 'tool_use' && t !== 'server_tool_use') emit(other(`stream/block:${t}`, ev.content_block))
            break
          }
          if (ev.type === 'content_block_delta') {
            const dt = ev.delta?.type
            if (dt === 'text_delta') {
              sawDelta = true
              text(ev.delta.text, emit)
            } else if (dt === 'thinking_delta') {
              sawThinkingDelta = true
              emit({ t: 'thinking', delta: String(ev.delta.thinking ?? ''), tokens: Number(ev.delta.estimated_tokens) || undefined })
            } else if (dt === 'input_json_delta') {
              if (toolInput) {
                toolInput.bytes += Buffer.byteLength(String(ev.delta.partial_json ?? ''))
                // throttled: every 2 KB or 400 ms
                if (toolInput.bytes - toolInput.sent >= 2048 || Date.now() - toolInput.at > 400) {
                  toolInput.sent = toolInput.bytes
                  toolInput.at = Date.now()
                  emit({ t: 'phase', tool: toolInput.name, bytes: toolInput.bytes })
                }
              }
            } else if (dt !== 'signature_delta' && dt !== 'citations_delta') emit(other(`stream/delta:${dt}`, ev.delta))
            break
          }
          emit(other(`stream/${ev.type}`, ev))
          break
        }
        case 'assistant': {
          const mu = d.message?.usage
          if (mu) {
            const n = (Number(mu.input_tokens) || 0) + (Number(mu.cache_read_input_tokens) || 0) + (Number(mu.cache_creation_input_tokens) || 0)
            if (n > 0) lastContext = n + (Number(mu.output_tokens) || 0)
          }
          for (const c of d.message?.content ?? []) {
            if (c.type === 'tool_use' || c.type === 'server_tool_use') {
              const a = claudeTool(c.id, c.name, c.input ?? {})
              tools.set(c.id, { name: c.name, input: c.input ?? {}, activity: a })
              if (a) emit(a)
            } else if (c.type === 'text') {
              if (!sawDelta && c.text) text((textSoFar ? '\n\n' : '') + c.text, emit)
            } else if (c.type === 'thinking') {
              if (!sawThinkingDelta && c.thinking) emit({ t: 'thinking', delta: c.thinking })
            } else if (c.type !== 'redacted_thinking') emit(other(`assistant/${c.type}`, c))
          }
          break
        }
        case 'user':
          for (const c of d.message?.content ?? []) {
            if (c?.type !== 'tool_result') continue
            const t = tools.get(c.tool_use_id)
            if (!t?.activity) continue
            emit(claudeResult(t.name, t.input, t.activity, c, d.tool_use_result))
            if (t.activity.type === 'write' && IMAGE_RE.test(t.activity.target) && !c.is_error) emit({ t: 'output', path: t.activity.target })
          }
          break
        case 'rate_limit_event': {
          const info = d.rate_limit_info ?? {}
          const win = (w: any, minutes: number): QuotaWindow | null =>
            w && typeof w.utilization === 'number' ? { percent: Math.round(w.utilization * 1000) / 10, resetsAt: typeof w.resetsAt === 'number' ? w.resetsAt * 1000 : null, minutes } : null
          const limited = typeof info.status === 'string' && !info.status.startsWith('allowed')
          emit({ t: 'quota', quota: { fiveHour: win(info.unifiedWindows?.five_hour, 300), sevenDay: win(info.unifiedWindows?.seven_day, 10080), limited, plan: null } })
          if (limited) emit({ t: 'rate_limited' })
          break
        }
        case 'result': {
          if (Array.isArray(d.permission_denials) && d.permission_denials.length)
            emit({ t: 'notice', message: deniedText(d.permission_denials.map((x: any) => x?.tool_name ?? 'tool'), s.cfg.autoApprove) })
          const u = d.usage ?? {}
          emit({
            t: 'usage',
            usage: {
              input: u.input_tokens,
              output: u.output_tokens,
              cacheRead: u.cache_read_input_tokens,
              cacheWrite: u.cache_creation_input_tokens,
              reasoning: u.output_tokens_details?.thinking_tokens,
              costUsd: typeof d.total_cost_usd === 'number' ? d.total_cost_usd : undefined,
              context: lastContext || undefined
            }
          })
          session = d.session_id ?? session
          result = d.is_error || d.subtype !== 'success' ? { ok: false, error: String(d.result || d.api_error_status || d.subtype || 'error') } : { ok: true, error: null }
          break
        }
        default:
          emit(other(String(d.type ?? 'unknown'), d))
      }
    }
  }
}

function deniedText(tools: string[], level: AutoApprove): string {
  const names = [...new Set(tools)].join(t('common.listSep'))
  return level === 'full'
    ? t('main.deniedTools', { n: tools.length, names })
    : level === 'cli'
      ? t('main.deniedByCli', { n: tools.length, names })
      : t('main.deniedByEdits', { n: tools.length, names })
}

export function claudeTool(id: string, name: string, input: Record<string, any>): Extract<AgentEvent, { t: 'activity' }> | null {
  const path = String(input.file_path ?? input.notebook_path ?? input.path ?? '')
  const base = { t: 'activity' as const, id, status: 'running' as const }
  switch (name) {
    case 'Read':
      return { ...base, type: 'read', target: path, detail: { tool: name, input: capJson(input) } }
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return { ...base, type: 'write', target: path, detail: { tool: name } }
    case 'Bash':
      return { ...base, type: 'run', target: String(input.command ?? '').slice(0, 300), detail: { tool: name, input: capText(String(input.command ?? ''), MAX_IN) } }
    case 'Grep':
    case 'Glob':
      return { ...base, type: 'search', target: String(input.pattern ?? ''), detail: { tool: name, input: capJson(input) } }
    case 'WebSearch':
    case 'WebFetch':
    case 'web_search':
    case 'web_fetch':
      return { ...base, type: 'search', target: String(input.query ?? input.url ?? ''), detail: { tool: name, input: capJson(input) } }
    case 'TodoWrite':
      return { ...base, type: 'tool', target: t('main.updateTodos'), detail: { tool: name, input: capJson(input) } }
    default:
      return { ...base, type: 'tool', target: name, detail: { tool: name, input: capJson(input) } }
  }
}

export function claudeResult(name: string, input: Record<string, any>, a: Extract<AgentEvent, { t: 'activity' }>, block: any, r: any): Extract<AgentEvent, { t: 'activity' }> {
  const isErr = !!block.is_error
  const raw = resultText(block.content)
  const detail = { ...a.detail }
  if (a.type === 'run' && name === 'Bash') {
    const res = r && typeof r === 'object' ? r : {}
    detail.output = capText(res.stdout ?? raw)
    if (res.stderr) detail.stderr = capText(res.stderr, MAX_IN)
    const code = /exit code[:\s]+(\d+)/i.exec(raw)
    detail.exitCode = isErr ? (code ? Number(code[1]) : 1) : 0
    if (isErr && !res.stdout && !res.stderr) detail.output = capText(raw)
  } else if (a.type === 'write') {
    const file = a.target
    if (r && Array.isArray(r.structuredPatch) && r.structuredPatch.length) detail.diff = patchText(file, r.structuredPatch)
    else if (r && r.type === 'create' && typeof r.content === 'string') detail.diff = createdDiff(file, r.content)
    else if (name === 'Write' && typeof input.content === 'string' && !isErr) detail.diff = createdDiff(file, input.content)
    if (isErr || !detail.diff) detail.output = capText(raw, MAX_IN)
  } else {
    detail.output = capText(raw)
  }
  return { ...a, status: isErr ? 'error' : 'done', detail }
}

// ---- codex ---------------------------------------------------------------------------------

/** The rollout log of a codex session: sessions/YYYY/MM/DD/rollout-…-<id>.jsonl (newest days first). */
function codexRollout(codexHome: string, session: string): string | null {
  const root = join(codexHome, 'sessions')
  const desc = (dir: string) => {
    try {
      return readdirSync(dir).sort().reverse()
    } catch {
      return []
    }
  }
  for (const y of desc(root))
    for (const m of desc(join(root, y)))
      for (const d of desc(join(root, y, m))) {
        const f = desc(join(root, y, m, d)).find((n) => n.endsWith(`${session}.jsonl`))
        if (f) return join(root, y, m, d, f)
      }
  return null
}

/**
 * Context of the session's last request and the model's window, from the last `token_count`
 * event of the rollout log (only its tail is read).
 */
function codexContext(codexHome: string, session: string): { context: number; window: number | undefined } | null {
  const file = codexRollout(codexHome, session)
  if (!file) return null
  let fd: number | null = null
  try {
    const size = statSync(file).size
    const len = Math.min(size, 512 * 1024)
    const buf = Buffer.alloc(len)
    fd = openSync(file, 'r')
    readSync(fd, buf, 0, len, size - len)
    const lines = buf.toString('utf8').split('\n')
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].includes('"token_count"')) continue
      try {
        const info = JSON.parse(lines[i])?.payload?.info
        const last = info?.last_token_usage
        if (!last) continue
        const context = (Number(last.input_tokens) || 0) + (Number(last.output_tokens) || 0)
        const window = Number(info.model_context_window) || undefined
        return context > 0 ? { context, window } : null
      } catch {
        /* a line cut by the tail window */
      }
    }
  } catch {
    /* no log, unreadable */
  } finally {
    if (fd !== null) closeSync(fd)
  }
  return null
}

function codexAdapter(s: RunSpec, codexHome: string, startedAt: number): Adapter {
  let session: string | null = s.resume
  let result: { ok: boolean; error: string | null } | null = null
  let textSoFar = ''
  let thoughtSoFar = ''
  const own = s.cfg.autoApprove === 'cli' ? codexTopKeys(codexHome) : new Set<string>()
  const policy =
    s.cfg.autoApprove === 'full'
      ? ['-c', 'sandbox_mode="danger-full-access"', '-c', 'approval_policy="never"']
      : [...(own.has('sandbox_mode') ? [] : ['-c', 'sandbox_mode="workspace-write"']), ...(own.has('approval_policy') ? [] : ['-c', 'approval_policy="never"'])]
  const spec = splitSpec(s.model)
  const common = [
    '--json',
    '--skip-git-repo-check',
    ...policy,
    ...(spec.model ? ['-m', spec.model] : []),
    ...(spec.effort ? ['-c', `model_reasoning_effort="${spec.effort}"`] : []),
    // reasoning items are only emitted with a summary level set (measured 0.171.0)
    '-c',
    'model_reasoning_summary="detailed"',
    ...s.images.flatMap((p) => ['-i', p])
  ]
  // resume takes no -C/--sandbox: cwd comes from the process, sandbox from -c
  const args = s.resume ? ['exec', 'resume', s.resume, ...common, '-'] : ['exec', '-C', s.cwd, ...common, '-']
  const itemEvent = (phase: 'started' | 'updated' | 'completed', item: any, emit: Emit): void => {
    const done = phase === 'completed'
    switch (item?.type) {
      case 'agent_message':
        if (done && item.text) {
          const delta = (textSoFar ? '\n\n' : '') + item.text
          textSoFar += delta
          emit({ t: 'text', delta })
        }
        return
      case 'reasoning': {
        const t = String(item.text ?? item.summary ?? '').trim()
        if (!done) return emit({ t: 'thinking', delta: '' })
        if (t) {
          const delta = (thoughtSoFar ? '\n\n' : '') + t
          thoughtSoFar += delta
          emit({ t: 'thinking', delta })
        }
        return
      }
      case 'command_execution': {
        const cmd = unwrapShell(String(item.command ?? ''))
        const code = typeof item.exit_code === 'number' ? item.exit_code : null
        const failed = item.status === 'failed' || item.status === 'declined' || (code !== null && code !== 0)
        return emit({
          t: 'activity',
          id: item.id,
          type: 'run',
          target: cmd.slice(0, 300),
          status: done || code !== null ? (failed ? 'error' : 'done') : 'running',
          detail: { tool: 'command_execution', input: capText(cmd, MAX_IN), output: capText(item.aggregated_output ?? ''), exitCode: code }
        })
      }
      case 'file_change':
        for (const c of item.changes ?? []) {
          if (!c?.path) continue
          emit({
            t: 'activity',
            id: `${item.id}:${c.path}`,
            type: 'write',
            target: c.path,
            status: done ? (item.status === 'failed' ? 'error' : 'done') : 'running',
            detail: { tool: `file_change · ${c.kind ?? 'update'}` }
          })
          if (done && IMAGE_RE.test(c.path) && c.kind !== 'delete') emit({ t: 'output', path: c.path })
        }
        return
      case 'web_search':
        return emit({ t: 'activity', id: item.id, type: 'search', target: String(item.query ?? ''), status: done ? 'done' : 'running', detail: { tool: 'web_search', input: capJson(item.query ?? item) } })
      case 'mcp_tool_call':
        return emit({
          t: 'activity',
          id: item.id,
          type: 'tool',
          target: `${item.server ?? 'mcp'}.${item.tool ?? ''}`,
          status: done ? (item.error || item.status === 'failed' ? 'error' : 'done') : 'running',
          detail: {
            tool: 'mcp_tool_call',
            input: capJson(item.arguments ?? {}),
            output: item.result !== undefined || item.error ? capText(item.error ? item.error : item.result) : undefined
          }
        })
      case 'todo_list':
        return emit({
          t: 'activity',
          id: item.id,
          type: 'tool',
          target: t('main.updateTodos'),
          status: 'done',
          detail: { tool: 'todo_list', output: capText((item.items ?? []).map((x: any) => `${x.completed ? '☑' : '☐'} ${x.text}`).join('\n')) }
        })
      case 'error':
        if (done) emit({ t: 'notice', message: String(item.message ?? 'error') })
        return
      default:
        if (done || phase === 'started') emit(other(`item.${phase}:${item?.type ?? '?'}`, item))
    }
  }
  return {
    args,
    stdin: full(s),
    sessionId: () => session,
    model: () => s.model,
    result: () => result,
    onLine: (d, emit) => {
      switch (d.type) {
        case 'thread.started':
          session = d.thread_id ?? session
          emit({ t: 'session', id: session ?? '', model: s.model })
          break
        case 'turn.started':
          break
        case 'item.started':
          itemEvent('started', d.item, emit)
          break
        case 'item.updated':
          itemEvent('updated', d.item, emit)
          break
        case 'item.completed':
          itemEvent('completed', d.item, emit)
          break
        case 'turn.completed': {
          const u = d.usage ?? {}
          const cached = Number(u.cached_input_tokens) || 0
          emit({
            t: 'usage',
            usage: {
              input: typeof u.input_tokens === 'number' ? Math.max(0, u.input_tokens - cached) : undefined,
              output: u.output_tokens,
              cacheRead: cached || undefined,
              cacheWrite: u.cache_write_input_tokens || undefined,
              reasoning: u.reasoning_output_tokens
            }
          })
          result = { ok: true, error: null }
          break
        }
        case 'turn.failed':
          result = { ok: false, error: String(d.error?.message ?? 'turn failed') }
          break
        case 'error':
          if (d.message) result = { ok: false, error: String(d.message) }
          break
        default:
          emit(other(String(d.type ?? 'unknown'), d))
      }
    },
    // Built-in image generation lands in $CODEX_HOME/generated_images/<thread>/: copy new files into the project.
    finish: (emit) => {
      if (!session) return
      // `exec --json` only reports the turn's summed usage; the session log has the last request
      const ctx = codexContext(codexHome, session)
      if (ctx) emit({ t: 'usage', usage: { context: ctx.context, contextWindow: ctx.window } })
      const dir = join(codexHome, 'generated_images', session)
      if (!existsSync(dir)) return
      for (const f of readdirSync(dir)) {
        const src = join(dir, f)
        try {
          if (!IMAGE_RE.test(f) || statSync(src).mtimeMs < startedAt - 1000) continue
          mkdirSync(s.outDir, { recursive: true })
          const dst = join(s.outDir, basename(f))
          copyFileSync(src, dst)
          emit({ t: 'activity', type: 'write', target: dst, status: 'done', detail: { tool: 'image_generation' } })
          emit({ t: 'output', path: dst })
        } catch {
          /* ignore unreadable */
        }
      }
    }
  }
}

// ---- agy -----------------------------------------------------------------------------------

function agyAdapter(s: RunSpec): Adapter {
  let session: string | null = s.resume
  let model: string | null = s.model
  let result: { ok: boolean; error: string | null } | null = null
  let textSoFar = ''
  let lastTextStep = -1
  let thinkingTokens = 0
  /** Context of the latest finished step (result.usage sums the whole turn). */
  let lastContext = 0
  const args = ['--output-format', 'stream-json']
  // cli: agy's own default mode (runs commands in -p, measured 1.5.13)
  if (s.cfg.autoApprove === 'full') args.push('--dangerously-skip-permissions')
  else if (s.cfg.autoApprove === 'edits') args.push('--mode', 'accept-edits')
  const spec = splitSpec(s.model)
  if (spec.model) args.push('--model', agyModelId(s.cfg.id, spec.model, spec.effort))
  if (s.resume) args.push('--conversation', s.resume)
  args.push('-p', full(s)) // last, so it works whether -p takes a value or is a bool + positional prompt
  return {
    args,
    stdin: null,
    sessionId: () => session,
    model: () => model,
    result: () => result,
    onLine: (d, emit) => {
      switch (d.event) {
        case 'init':
          session = d.conversation_id ?? session
          model = d.init?.model ?? model
          emit({ t: 'session', id: session ?? '', model })
          break
        case 'step_update': {
          const u = d.step_update ?? {}
          switch (u.step_type) {
            case 'user_input':
              break
            case 'agent_response': {
              // agy exposes no thinking text (measured 1.5.8); future fields are picked up if they appear
              const th = u.thinking_delta ?? u.thinking
              if (typeof th === 'string' && th) emit({ t: 'thinking', delta: th })
              if (typeof u.text_delta === 'string' && u.text_delta) {
                if (lastTextStep !== u.step_index && textSoFar.trim()) {
                  textSoFar += '\n\n'
                  emit({ t: 'text', delta: '\n\n' })
                }
                lastTextStep = u.step_index
                textSoFar += u.text_delta
                emit({ t: 'text', delta: u.text_delta })
              }
              // each finished step is one request: its input is the context at that point
              const stepCtx = (Number(u.usage?.input_tokens) || 0) + (Number(u.usage?.output_tokens) || 0)
              if (u.state === 'DONE' && stepCtx > 0) lastContext = stepCtx
              const tk = Number(u.usage?.thinking_tokens) || 0
              if (u.state === 'DONE' && tk > 0) {
                thinkingTokens += tk
                emit({ t: 'thinking', delta: '', tokens: thinkingTokens })
              }
              break
            }
            case 'tool': {
              const a = agyTool(u)
              if (a) emit(a)
              break
            }
            default:
              if (u.state !== 'ACTIVE') emit(other(`step:${u.step_type ?? '?'}`, u))
          }
          break
        }
        case 'result': {
          const r = d.result ?? {}
          if (Array.isArray(r.denied_actions) && r.denied_actions.length)
            emit({ t: 'notice', message: deniedText(r.denied_actions.map((x: any) => x?.display_name ?? x?.action ?? 'tool'), s.cfg.autoApprove) })
          const u = r.usage ?? {}
          emit({ t: 'usage', usage: { input: u.input_tokens, output: u.output_tokens, cacheRead: u.cache_read_tokens || undefined, reasoning: u.thinking_tokens, context: lastContext || undefined } })
          session = r.conversation_id ?? session
          result = r.status === 'SUCCESS' ? { ok: true, error: null } : { ok: false, error: String(r.error ?? r.status ?? 'error') }
          break
        }
        default:
          emit(other(String(d.event ?? d.type ?? 'unknown'), d))
      }
    }
  }
}

/**
 * agy tool step: {step_type:'tool', state:'ACTIVE'|'DONE'|'ERROR', tool_name,
 *   tool_info:{name, parameters:{CommandLine|Path|AbsolutePath|Query…}, output?}}
 * run_command output: "…Command exited with code N.\n\nCommand output:\n<text>"
 */
export function agyTool(u: Record<string, any>): Extract<AgentEvent, { t: 'activity' }> | null {
  let info: any = u.tool_info
  if (typeof info === 'string') {
    try {
      info = JSON.parse(info)
    } catch {
      info = {}
    }
  }
  const name = String(u.tool_name ?? info?.name ?? 'tool')
  const p: Record<string, any> = info?.parameters ?? {}
  const pick = (re: RegExp): string | undefined => {
    const k = Object.keys(p).find((x) => re.test(x))
    return k ? String(p[k]) : undefined
  }
  const file = pick(/path|file/i)
  const n = name.toLowerCase()
  const state = String(u.state ?? '')
  const status = state === 'ACTIVE' ? 'running' : /ERROR|FAIL|CANCEL/.test(state) ? 'error' : 'done'
  const id = `agy:${u.step_index}`
  const rawOut = typeof info?.output === 'string' ? info.output.replace(/\r\n/g, '\n') : info?.output !== undefined ? JSON.stringify(info.output, null, 2) : ''
  const base = { t: 'activity' as const, id, status: status as 'running' | 'done' | 'error' }
  if (/command|shell|exec|terminal/.test(n)) {
    const cmd = pick(/command/i) ?? name
    const code = /exited with code (-?\d+)/i.exec(rawOut)
    const body = /Command output:\n([\s\S]*)$/.exec(rawOut)
    const exitCode = code ? Number(code[1]) : status === 'running' ? null : status === 'error' ? 1 : null
    return {
      ...base,
      status: exitCode !== null && exitCode !== 0 ? 'error' : base.status,
      type: 'run',
      target: cmd.slice(0, 300),
      detail: { tool: name, input: capText(cmd, MAX_IN), output: capText(body ? body[1] : rawOut), exitCode }
    }
  }
  const detail = { tool: name, input: capJson(p), output: rawOut ? capText(rawOut) : undefined }
  if (/write|edit|replace|create|patch|delete/.test(n)) return { ...base, type: 'write', target: file ?? name, detail: { tool: name, output: detail.output } }
  if (/search|grep|find|glob|web/.test(n)) return { ...base, type: 'search', target: pick(/query|pattern|url/i) ?? file ?? name, detail }
  if (/read|view|list|open/.test(n)) return { ...base, type: 'read', target: file ?? name, detail }
  return { ...base, type: 'tool', target: name, detail }
}

/** `onLog` receives raw stdout/stderr for the debug drawer. */
export function runAgent(spec: RunSpec, emit: Emit, onLog: (text: string) => void): RunHandle {
  const cfg = getConfig(spec.cfg.id)
  const bin = kindBinaryPath(cfg.kind)
  const { env } = buildSpawnSpec(cfg.id, 'run')
  const startedAt = Date.now()
  const adapter =
    cfg.kind === 'claude' ? claudeAdapter(spec) : cfg.kind === 'codex' ? codexAdapter(spec, expandHome(cfg.configDir), startedAt) : agyAdapter(spec)

  let child: ChildProcess | null = null
  let stopped = false
  let rateLimited = false
  let killTimer: NodeJS.Timeout | null = null
  let others = 0
  const wrapped: Emit = (e) => {
    if (e.t === 'rate_limited') rateLimited = true
    if (e.t === 'other_event' && ++others > 200) {
      if (others === 201) emit({ t: 'other_event', kind: 'agentswitch', payload: t('main.othersCapped') })
      return
    }
    emit(e)
  }

  const done = new Promise<RunResult>((resolve) => {
    const finish = (ok: boolean, error: string | null): void => {
      if (killTimer) clearTimeout(killTimer)
      try {
        adapter.finish?.(wrapped)
      } catch (e) {
        onLog(`[finish] ${String(e)}\n`)
      }
      if (error && cfg.apiKey && isInvalidKeyError(error)) error = `${error}\n${t('apikey.checkKey')}`
      resolve({ ok: ok && !stopped, stopped, text: '', sessionId: adapter.sessionId(), model: adapter.model(), error: stopped ? null : error, rateLimited })
    }
    if (!bin) return finish(false, t('main.cliNotInstalled', { kind: cfg.kind }))

    onLog(`\n── ${cfg.name} · ${spec.model ?? t('wb.defaultModel')} · cwd ${spec.cwd}\n$ ${bin} ${adapter.args.map((a) => (a.length > 80 ? JSON.stringify(a.slice(0, 80) + '…') : JSON.stringify(a))).join(' ')}\n`)
    try {
      // detached: own process group, so stop() can take down the CLI's children too
      child = spawn(bin, adapter.args, { cwd: spec.cwd, env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] })
    } catch (e) {
      return finish(false, e instanceof Error ? e.message : String(e))
    }
    let out = ''
    let errTail = ''
    child.stdout!.setEncoding('utf8')
    child.stderr!.setEncoding('utf8')
    child.stdout!.on('data', (chunk: string) => {
      onLog(chunk)
      out += chunk
      let nl: number
      while ((nl = out.indexOf('\n')) >= 0) {
        const line = out.slice(0, nl).trim()
        out = out.slice(nl + 1)
        if (!line) continue
        if (!line.startsWith('{')) {
          // plain-text stdout (warnings, hints): keep it visible instead of dropping it
          wrapped({ t: 'other_event', kind: 'stdout', payload: capText(line, 4096) })
          continue
        }
        let obj: unknown
        try {
          obj = JSON.parse(line)
        } catch (e) {
          onLog(`[parse] ${String(e)}\n`)
          wrapped({ t: 'other_event', kind: 'unparsed', payload: capText(line, 4096) })
          continue
        }
        try {
          adapter.onLine(obj, wrapped)
        } catch (e) {
          onLog(`[adapter] ${String(e)}\n`)
          wrapped({ t: 'other_event', kind: 'adapter-error', payload: capText(`${String(e)}\n${line}`, 4096) })
        }
      }
    })
    child.stderr!.on('data', (chunk: string) => {
      onLog(chunk)
      // Claude Code warns on stderr about every third-party model id; that's not an error.
      const kept = cfg.apiKey ? chunk.split('\n').filter((l) => !isClaudeModelWarning(l)).join('\n') : chunk
      errTail = (errTail + kept).slice(-4000)
      if (!rateLimited && RATE_LIMIT_RE.test(chunk)) wrapped({ t: 'rate_limited' })
    })
    child.on('error', (e) => finish(false, e.message))
    child.on('close', (code, signal) => {
      onLog(`── exited (code ${code}${signal ? `, ${signal}` : ''})\n`)
      const r = adapter.result()
      if (r) return finish(r.ok, r.error)
      const lastErr = errTail.trim().split('\n').filter(Boolean).pop() ?? null
      finish(code === 0, code === 0 ? null : lastErr ?? t('main.exitCode', { code: String(code) }))
    })
    child.stdin!.on('error', () => {})
    if (adapter.stdin !== null) child.stdin!.end(adapter.stdin)
    else child.stdin!.end()
  })

  const kill = (): void => {
    stopped = true
    const c = child as ChildProcess | null
    if (!c?.pid || c.exitCode !== null) return
    try {
      process.kill(-c.pid, 'SIGTERM')
    } catch {
      c.kill('SIGTERM')
    }
    killTimer = setTimeout(() => {
      try {
        process.kill(-c.pid!, 'SIGKILL')
      } catch {
        /* gone */
      }
    }, KILL_GRACE_MS)
  }

  return { done, kill }
}
