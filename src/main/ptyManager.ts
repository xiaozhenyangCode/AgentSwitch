import * as pty from 'node-pty'
import type { IPty } from 'node-pty'
import type { PtyBuffer, PtyDataEvent, PtyExitEvent, PtyMode, PtyUrlEvent, SessionId, SessionInfo } from '@shared/types'
import type { SpawnSpec } from './profiles'

const MAX_BUFFER = 512 * 1024 // raw scrollback kept per session for replay in the debug drawer
const URL_TAIL = 8 * 1024 // stripped text kept for URL matching across chunk boundaries
const URL_SCAN_DEBOUNCE = 150

// CSI / OSC / single-char ESC sequences
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]|[\x00-\x08\x0b-\x1f\x7f]/g
// OSC 8 hyperlinks: ESC ] 8 ; params ; URL (BEL | ST)
// eslint-disable-next-line no-control-regex
const OSC8_RE = /\x1b\]8;[^;\x07\x1b]*;(https?:\/\/[^\x07\x1b]+)(?:\x07|\x1b\\)/g
const URL_RE = /https?:\/\/[^\s"'<>`\]\[{}|\\^]+/g
const AUTH_HINT_RE = /oauth|authorize|auth|login|signin|sign-in|device|client_id|redirect_uri|code_challenge|accounts\.google|console\.anthropic|claude\.ai|auth\.openai|chatgpt\.com/i
/**
 * Menus a CLI shows during login before it prints an auth URL. The login sheet hides the
 * terminal, so nobody would see them: pick the default (first, highlighted) option once.
 * - agy: "Select login method: > 1. Google OAuth  2. Use a Google Cloud project"
 * - claude TUI (custom `claude /login`): theme picker, then "Select login method"
 */
// Matched with whitespace removed: TUIs often place words with cursor moves, not spaces.
const LOGIN_PROMPTS = ['Choosethetextstyle', 'Selectloginmethod']
const RATE_LIMIT_RE = /rate[ _-]?limit(ed)?|usage limit|too many requests|quota exceeded|RESOURCE_EXHAUSTED/i

interface Session {
  id: SessionId
  mode: PtyMode
  proc: IPty
  alive: boolean
}

interface Buffers {
  /** Mode of the most recent process in this session (kept after exit for the log list). */
  lastMode: PtyMode | null
  raw: string
  /** Monotonic count of chars emitted (never reset; raw is truncated). */
  seq: number
  tail: string
  urls: Set<string>
  scanTimer: NodeJS.Timeout | null
  rateLimited: boolean
  cwd: string | null
  /** LOGIN_PROMPTS already answered in the current login process. */
  answered: Set<string>
}

export interface PtyEvents {
  onData(e: PtyDataEvent): void
  onExit(e: PtyExitEvent): void
  onUrl(e: PtyUrlEvent): void
  onStateChange(id: SessionId): void
}

const cleanUrl = (u: string): string => u.replace(/[).,;:!?'"]+$/, '')

export class PtyManager {
  private sessions = new Map<SessionId, Session>()
  private buffers = new Map<SessionId, Buffers>()

  constructor(private events: PtyEvents) {}

  private buf(id: SessionId): Buffers {
    let b = this.buffers.get(id)
    if (!b) {
      b = { lastMode: null, raw: '', seq: 0, tail: '', urls: new Set(), scanTimer: null, rateLimited: false, cwd: null, answered: new Set() }
      this.buffers.set(id, b)
    }
    return b
  }

  sessionMode(id: SessionId): PtyMode | null {
    const s = this.sessions.get(id)
    return s?.alive ? s.mode : null
  }

  /** Sessions that are running or have produced output, in first-seen order. */
  list(label: (id: SessionId) => string): SessionInfo[] {
    return [...this.buffers.entries()]
      .filter(([id, b]) => this.sessions.get(id)?.alive || b.raw.length > 0)
      .map(([id, b]) => ({ sessionId: id, mode: b.lastMode, alive: !!this.sessions.get(id)?.alive, label: label(id), cwd: b.cwd }))
  }

  /** Kill and drop all scrollback for a session (account deleted). */
  forget(id: SessionId): void {
    this.kill(id)
    const b = this.buffers.get(id)
    if (b?.scanTimer) clearTimeout(b.scanTimer)
    this.buffers.delete(id)
    this.events.onStateChange(id)
  }

  /** Appends text to a log-only session (e.g. `run:<account>` for chat runs). */
  log(id: SessionId, text: string): void {
    const b = this.buf(id)
    if (!b.lastMode) b.lastMode = 'run'
    this.emitData(id, text.replace(/\r?\n/g, '\r\n'), false)
  }

  isRateLimited(id: SessionId): boolean {
    return this.buffers.get(id)?.rateLimited ?? false
  }

  getBuffer(id: SessionId): PtyBuffer {
    const b = this.buffers.get(id)
    return { data: b?.raw ?? '', seq: b?.seq ?? 0 }
  }

  start(id: SessionId, mode: PtyMode, spec: SpawnSpec, cols: number, rows: number): void {
    this.kill(id)
    const b = this.buf(id)
    b.rateLimited = false
    b.lastMode = mode
    b.cwd = spec.cwd
    b.tail = ''
    b.urls.clear()
    b.answered.clear()

    if (!id.startsWith('term:')) {
      const banner =
        `\r\n\x1b[38;5;244m── [${id}] ${mode}: ${spec.shell} ${spec.args.map((a) => JSON.stringify(a)).join(' ')}\x1b[0m\r\n` +
        (Object.keys(spec.injected).length
          ? `\x1b[38;5;244m   env: ${Object.entries(spec.injected)
              .map(([k, v]) => `${k}=${v}`)
              .join('  ')}\x1b[0m\r\n`
          : `\x1b[38;5;244m   env: (real HOME, no isolation)\x1b[0m\r\n`) +
        `\x1b[38;5;244m   cwd: ${spec.cwd}\x1b[0m\r\n`
      this.emitData(id, banner, false)
    }

    let proc: IPty
    try {
      proc = pty.spawn(spec.shell, spec.args, {
        name: 'xterm-256color',
        cols: Math.max(cols, 20),
        rows: Math.max(rows, 5),
        cwd: spec.cwd,
        env: spec.env
      })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      this.emitData(id, `\r\n\x1b[31m[spawn failed] ${msg}\x1b[0m\r\n`, false)
      this.events.onExit({ sessionId: id, mode, exitCode: -1 })
      return
    }

    const session: Session = { id, mode, proc, alive: true }
    this.sessions.set(id, session)

    proc.onData((data) => {
      if (this.sessions.get(id) !== session) return
      this.emitData(id, data)
    })
    proc.onExit(({ exitCode, signal }) => {
      session.alive = false
      if (this.sessions.get(id) !== session) return
      this.emitData(
        id,
        `\r\n\x1b[38;5;244m── [${id}] process exited (code ${exitCode}${signal ? `, signal ${signal}` : ''})\x1b[0m\r\n`,
        false
      )
      this.sessions.delete(id)
      this.events.onExit({ sessionId: id, mode, exitCode, signal })
      this.events.onStateChange(id)
    })
    this.events.onStateChange(id)
  }

  write(id: SessionId, data: string): void {
    const s = this.sessions.get(id)
    if (s?.alive) s.proc.write(data)
  }

  resize(id: SessionId, cols: number, rows: number): void {
    const s = this.sessions.get(id)
    if (s?.alive && cols > 0 && rows > 0) {
      try {
        s.proc.resize(cols, rows)
      } catch {
        /* process may have just exited */
      }
    }
  }

  kill(id: SessionId): void {
    const s = this.sessions.get(id)
    if (!s) return
    this.sessions.delete(id)
    if (s.alive) {
      s.alive = false
      try {
        s.proc.kill()
      } catch {
        /* already gone */
      }
      this.emitData(id, `\r\n\x1b[38;5;244m── [${id}] killed\x1b[0m\r\n`, false)
      this.events.onExit({ sessionId: id, mode: s.mode, exitCode: -1, signal: 1 })
    }
    this.events.onStateChange(id)
  }

  killAll(): void {
    for (const id of [...this.sessions.keys()]) this.kill(id)
  }

  /** `scan=false` for AgentSwitch's own status lines (they echo commands that may contain URLs). */
  private emitData(id: SessionId, data: string, scan = true): void {
    const b = this.buf(id)
    b.raw += data
    b.seq += data.length
    if (b.raw.length > MAX_BUFFER) b.raw = b.raw.slice(-MAX_BUFFER)
    if (scan) {
      // OSC 8 hyperlinks carry the URL outside the visible text -> grab before stripping.
      for (const m of data.matchAll(OSC8_RE)) this.reportUrl(id, b, m[1])
      b.tail += data.replace(ANSI_RE, '')
      if (b.tail.length > URL_TAIL) b.tail = b.tail.slice(-URL_TAIL)
      // Debounced so a URL split across chunks is matched once complete.
      if (b.scanTimer) clearTimeout(b.scanTimer)
      b.scanTimer = setTimeout(() => this.scan(id, b), URL_SCAN_DEBOUNCE)
    }
    this.events.onData({ sessionId: id, data, seq: b.seq })
  }

  private scan(id: SessionId, b: Buffers): void {
    b.scanTimer = null
    for (const m of b.tail.matchAll(URL_RE)) this.reportUrl(id, b, m[0])
    this.answerLoginPrompt(id, b)
    if (!b.rateLimited && this.sessions.get(id)?.mode !== 'install' && RATE_LIMIT_RE.test(b.tail)) {
      b.rateLimited = true
      this.events.onStateChange(id)
    }
  }

  private answerLoginPrompt(id: SessionId, b: Buffers): void {
    const s = this.sessions.get(id)
    if (!s?.alive || s.mode !== 'login' || b.urls.size > 0) return
    // Earlier menus stay in the tail after they are answered, so only the newest one counts.
    const text = b.tail.replace(/\s+/g, '')
    let latest = ''
    let at = -1
    for (const p of LOGIN_PROMPTS) {
      const i = text.lastIndexOf(p)
      if (i > at) [latest, at] = [p, i]
    }
    if (!latest || b.answered.has(latest)) return
    b.answered.add(latest)
    s.proc.write('\r')
  }

  private reportUrl(id: SessionId, b: Buffers, raw: string): void {
    const url = cleanUrl(raw)
    if (url.length < 12 || b.urls.has(url)) return
    b.urls.add(url)
    if (b.urls.size > 200) b.urls = new Set([...b.urls].slice(-100))
    this.events.onUrl({ sessionId: id, url, isAuth: AUTH_HINT_RE.test(url), at: Date.now() })
  }
}
