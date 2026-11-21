import { spawn, type ChildProcess } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { AgentEvent, AutoApprove, ProfileConfig } from '@shared/types'
import { splitSpec } from '@shared/modelSpec'
import { buildSpawnSpec, expandHome, getConfig, kindBinaryPath } from './profiles'
import { agyModelId } from './models'

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
const IMAGE_RE = /\.(png|jpe?g|gif|webp)$/i
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

function claudeAdapter(s: RunSpec): Adapter {
  let session: string | null = null
  let model: string | null = s.model
  let result: { ok: boolean; error: string | null } | null = null
  let textSoFar = ''
  let sawDelta = false
  const args = [
    '-p',
    '--output-format',
    'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--permission-mode',
    s.cfg.autoApprove === 'full' ? 'bypassPermissions' : 'acceptEdits'
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
          }
          break
        case 'stream_event': {
          const ev = d.event
          if (ev?.type === 'content_block_start' && ev.content_block?.type === 'text' && textSoFar && !textSoFar.endsWith('\n\n'))
            text(textSoFar.endsWith('\n') ? '\n' : '\n\n', emit)
          if (ev?.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
            sawDelta = true
            text(ev.delta.text, emit)
          }
          break
        }
        case 'assistant':
          for (const c of d.message?.content ?? []) {
            if (c.type === 'tool_use') {
              const a = claudeTool(c.name, c.input ?? {})
              if (a) emit(a)
              if (a?.type === 'write' && IMAGE_RE.test(a.target)) emit({ t: 'output', path: a.target })
            } else if (c.type === 'text' && !sawDelta && c.text) text((textSoFar ? '\n\n' : '') + c.text, emit)
          }
          break
        case 'rate_limit_event':
          if (d.rate_limit_info?.status && d.rate_limit_info.status !== 'allowed') emit({ t: 'rate_limited' })
          break
        case 'result':
          if (Array.isArray(d.permission_denials) && d.permission_denials.length)
            emit({ t: 'notice', message: deniedText(d.permission_denials.map((x: any) => x?.tool_name ?? 'tool'), s.cfg.autoApprove) })
          session = d.session_id ?? session
          result = d.is_error || d.subtype !== 'success' ? { ok: false, error: String(d.result || d.api_error_status || d.subtype || 'error') } : { ok: true, error: null }
          break
      }
    }
  }
}

function deniedText(tools: string[], level: AutoApprove): string {
  const names = [...new Set(tools)].join('、')
  return level === 'full'
    ? `有 ${tools.length} 次工具调用被拒绝（${names}）`
    : `有 ${tools.length} 次工具调用因「仅项目内编辑」授权被自动拒绝（${names}）。需要执行命令时，可在账号设置里切换为「完全放行」。`
}

function claudeTool(name: string, input: Record<string, any>): Extract<AgentEvent, { t: 'activity' }> | null {
  const path = input.file_path ?? input.notebook_path ?? input.path
  switch (name) {
    case 'Read':
      return { t: 'activity', type: 'read', target: String(path ?? '') }
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return { t: 'activity', type: 'write', target: String(path ?? '') }
    case 'Bash':
      return { t: 'activity', type: 'run', target: String(input.command ?? '').slice(0, 300) }
    case 'Grep':
    case 'Glob':
      return { t: 'activity', type: 'search', target: String(input.pattern ?? '') }
    case 'WebSearch':
    case 'WebFetch':
      return { t: 'activity', type: 'search', target: String(input.query ?? input.url ?? '') }
    case 'TodoWrite':
      return null
    default:
      return { t: 'activity', type: 'run', target: name }
  }
}

function codexAdapter(s: RunSpec, codexHome: string, startedAt: number): Adapter {
  let session: string | null = s.resume
  let result: { ok: boolean; error: string | null } | null = null
  let textSoFar = ''
  const policy =
    s.cfg.autoApprove === 'full'
      ? ['-c', 'sandbox_mode="danger-full-access"', '-c', 'approval_policy="never"']
      : ['-c', 'sandbox_mode="workspace-write"', '-c', 'approval_policy="never"']
  const spec = splitSpec(s.model)
  const common = [
    '--json',
    '--skip-git-repo-check',
    ...policy,
    ...(spec.model ? ['-m', spec.model] : []),
    ...(spec.effort ? ['-c', `model_reasoning_effort="${spec.effort}"`] : []),
    ...s.images.flatMap((p) => ['-i', p])
  ]
  // resume takes no -C/--sandbox: cwd comes from the process, sandbox from -c
  const args = s.resume ? ['exec', 'resume', s.resume, ...common, '-'] : ['exec', '-C', s.cwd, ...common, '-']
  return {
    args,
    stdin: full(s),
    sessionId: () => session,
    model: () => s.model,
    result: () => result,
    onLine: (d, emit) => {
      const item = d.item
      switch (d.type) {
        case 'thread.started':
          session = d.thread_id ?? session
          emit({ t: 'session', id: session ?? '', model: s.model })
          break
        case 'item.started':
          if (item?.type === 'command_execution') emit({ t: 'activity', type: 'run', target: String(item.command ?? '').slice(0, 300) })
          break
        case 'item.completed':
          if (item?.type === 'agent_message' && item.text) {
            const delta = (textSoFar ? '\n\n' : '') + item.text
            textSoFar += delta
            emit({ t: 'text', delta })
          } else if (item?.type === 'file_change') {
            for (const c of item.changes ?? []) {
              if (!c?.path) continue
              emit({ t: 'activity', type: 'write', target: c.path })
              if (IMAGE_RE.test(c.path) && c.kind !== 'delete') emit({ t: 'output', path: c.path })
            }
          } else if (item?.type === 'web_search') emit({ t: 'activity', type: 'search', target: String(item.query ?? '') })
          else if (item?.type === 'mcp_tool_call') emit({ t: 'activity', type: 'run', target: `${item.server ?? 'mcp'}.${item.tool ?? ''}` })
          break
        case 'turn.completed':
          result = { ok: true, error: null }
          break
        case 'turn.failed':
          result = { ok: false, error: String(d.error?.message ?? 'turn failed') }
          break
        case 'error':
          if (d.message) result = { ok: false, error: String(d.message) }
          break
      }
    },
    // Built-in image generation lands in $CODEX_HOME/generated_images/<thread>/: copy new files into the project.
    finish: (emit) => {
      if (!session) return
      const dir = join(codexHome, 'generated_images', session)
      if (!existsSync(dir)) return
      for (const f of readdirSync(dir)) {
        const src = join(dir, f)
        try {
          if (!IMAGE_RE.test(f) || statSync(src).mtimeMs < startedAt - 1000) continue
          mkdirSync(s.outDir, { recursive: true })
          const dst = join(s.outDir, basename(f))
          copyFileSync(src, dst)
          emit({ t: 'activity', type: 'write', target: dst })
          emit({ t: 'output', path: dst })
        } catch {
          /* ignore unreadable */
        }
      }
    }
  }
}

function agyAdapter(s: RunSpec): Adapter {
  let session: string | null = s.resume
  let model: string | null = s.model
  let result: { ok: boolean; error: string | null } | null = null
  let textSoFar = ''
  let lastTextStep = -1
  const seenSteps = new Set<number>()
  const args = ['--output-format', 'stream-json']
  args.push(...(s.cfg.autoApprove === 'full' ? ['--dangerously-skip-permissions'] : ['--mode', 'accept-edits']))
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
          if (u.step_type === 'agent_response') {
            if (typeof u.text_delta === 'string' && u.text_delta) {
              if (lastTextStep !== u.step_index && textSoFar.trim()) {
                textSoFar += '\n\n'
                emit({ t: 'text', delta: '\n\n' })
              }
              lastTextStep = u.step_index
              textSoFar += u.text_delta
              emit({ t: 'text', delta: u.text_delta })
            }
          } else if (u.step_type === 'tool' && !seenSteps.has(u.step_index)) {
            seenSteps.add(u.step_index)
            const a = agyTool(u)
            if (a) emit(a)
          }
          break
        }
        case 'result': {
          const r = d.result ?? {}
          if (Array.isArray(r.denied_actions) && r.denied_actions.length)
            emit({ t: 'notice', message: deniedText(r.denied_actions.map((x: any) => x?.display_name ?? x?.action ?? 'tool'), s.cfg.autoApprove) })
          session = r.conversation_id ?? session
          result = r.status === 'SUCCESS' ? { ok: true, error: null } : { ok: false, error: String(r.error ?? r.status ?? 'error') }
          break
        }
      }
    }
  }
}

/** agy tool step: {step_type:'tool', tool_name, tool_info:{name, parameters:{CommandLine|AbsolutePath|TargetFile|Query…}}} */
function agyTool(u: Record<string, any>): Extract<AgentEvent, { t: 'activity' }> | null {
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
  if (/command|shell|exec|terminal/.test(n)) return { t: 'activity', type: 'run', target: (pick(/command/i) ?? name).slice(0, 300) }
  if (/write|edit|replace|create|patch|delete/.test(n)) return { t: 'activity', type: 'write', target: file ?? name }
  if (/search|grep|find|glob/.test(n)) return { t: 'activity', type: 'search', target: pick(/query|pattern/i) ?? file ?? name }
  if (/read|view|list|open/.test(n)) return { t: 'activity', type: 'read', target: file ?? name }
  return { t: 'activity', type: 'run', target: name }
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
  const wrapped: Emit = (e) => {
    if (e.t === 'rate_limited') rateLimited = true
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
      resolve({ ok: ok && !stopped, stopped, text: '', sessionId: adapter.sessionId(), model: adapter.model(), error: stopped ? null : error, rateLimited })
    }
    if (!bin) return finish(false, `${cfg.kind} CLI 未安装`)

    onLog(`\n── ${cfg.name} · ${spec.model ?? '默认模型'} · cwd ${spec.cwd}\n$ ${bin} ${adapter.args.map((a) => (a.length > 80 ? JSON.stringify(a.slice(0, 80) + '…') : JSON.stringify(a))).join(' ')}\n`)
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
        if (!line.startsWith('{')) continue
        try {
          adapter.onLine(JSON.parse(line), wrapped)
        } catch (e) {
          onLog(`[parse] ${String(e)}\n`)
        }
      }
    })
    child.stderr!.on('data', (chunk: string) => {
      onLog(chunk)
      errTail = (errTail + chunk).slice(-4000)
      if (!rateLimited && RATE_LIMIT_RE.test(chunk)) wrapped({ t: 'rate_limited' })
    })
    child.on('error', (e) => finish(false, e.message))
    child.on('close', (code, signal) => {
      onLog(`── exited (code ${code}${signal ? `, ${signal}` : ''})\n`)
      const r = adapter.result()
      if (r) return finish(r.ok, r.error)
      const lastErr = errTail.trim().split('\n').filter(Boolean).pop() ?? null
      finish(code === 0, code === 0 ? null : lastErr ?? `进程退出码 ${code}`)
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
