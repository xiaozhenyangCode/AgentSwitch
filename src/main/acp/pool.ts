import { app } from 'electron'
import { isDeepStrictEqual } from 'node:util'
import type { ProfileId } from '@shared/types'
import { t } from '../i18n'
import { buildSpawnSpec, kindBinaryPath } from '../profiles'
import { realHome } from '../shellEnv'
import { startAcpProcess, type AcpProcess } from './acpProcess'
import { JsonRpcError } from './jsonrpc'
import { cancelledPermission, permissions, type PermissionReply } from './permissions'

/** A retired process loses the warm session: the next turn resumes it and agy's prompt cache starts cold. */
export const IDLE_MS = 30 * 60_000
const MAX_IDLE_DEFERRAL = 90 * 60_000
const MAX_START_FAILURES = 3

export type AcpFields = Record<string, any>

type Log = (text: string) => void
interface Listener {
  update: (update: AcpFields) => void
  permission: (request: AcpFields) => PermissionReply | Promise<PermissionReply>
}

interface SessionState {
  active: boolean
  system: string | null
  hasThreadHistory: boolean
  threadHistoryPath?: string
  options: AcpFields[]
  revision: number
  turns: number
  lastPromptAt?: number
}

export class AcpConnection {
  private readonly sessions = new Map<string, SessionState>()
  private readonly listeners = new Map<string, Listener>()
  private readonly turns = new Map<string, Promise<void>>()
  private readonly commands = new Map<string, Map<string, boolean>>()

  constructor(readonly process: AcpProcess, readonly home: string) {}

  session(id: string): SessionState {
    let session = this.sessions.get(id)
    if (!session) {
      session = { active: false, system: null, hasThreadHistory: false, options: [], revision: 0, turns: 0 }
      this.sessions.set(id, session)
    }
    return session
  }

  inOrder<T>(id: string, run: () => Promise<T>): Promise<T> {
    const result = (this.turns.get(id) ?? Promise.resolve()).then(run)
    const tail = result.then(() => {}, () => {})
    this.turns.set(id, tail)
    void tail.then(() => {
      if (this.turns.get(id) === tail) this.turns.delete(id)
    })
    return result
  }

  watch(id: string, listener: Listener): () => void {
    this.listeners.set(id, listener)
    return () => { this.listeners.delete(id) }
  }

  update(id: string, update: AcpFields): void {
    if (update.sessionUpdate === 'config_option_update' && Array.isArray(update.configOptions)) {
      const session = this.session(id)
      // agy can echo the previous response while the next option is already being set.
      if (!isDeepStrictEqual(session.options, update.configOptions)) {
        session.options = update.configOptions
        session.revision++
      }
    }
    if (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') {
      this.trackCommand(id, update)
    }
    this.listeners.get(id)?.update(update)
  }

  permission(request: AcpFields): PermissionReply | Promise<PermissionReply> {
    if (!this.process.alive) return cancelledPermission()
    return this.listeners.get(request.sessionId)?.permission(request) ?? cancelledPermission()
  }

  hasRunningCommands(): boolean {
    return [...this.commands.values()].some((calls) => [...calls.values()].includes(true))
  }

  private trackCommand(id: string, update: AcpFields): void {
    const callId = update.toolCallId
    if (typeof callId !== 'string') return
    let calls = this.commands.get(id)
    if (update.kind !== 'execute' && !calls?.has(callId)) return
    if (['completed', 'failed', 'cancelled'].includes(update.status)) {
      calls?.delete(callId)
      if (calls?.size === 0) this.commands.delete(id)
      return
    }
    if (!calls) {
      calls = new Map()
      this.commands.set(id, calls)
    }
    if (update.status === 'in_progress' || update.status === 'pending' || !calls.has(callId)) {
      calls.set(callId, update.status === 'in_progress')
    }
  }
}

interface Entry {
  starting: Promise<AcpConnection>
  connection?: AcpConnection
  abort: AbortController
  active: number
  log: Log
  timer?: NodeJS.Timeout
  /** Account settings changed while a turn was running: restart once the process is idle. */
  stale?: boolean
}

export interface AcpLease {
  connection: AcpConnection
  release: () => void
}

class AcpPool {
  private readonly entries = new Map<ProfileId, Entry>()
  private readonly failures = new Map<ProfileId, number>()
  private shuttingDown = false

  disabled(id: ProfileId): boolean {
    return (this.failures.get(id) ?? 0) >= MAX_START_FAILURES
  }

  async acquire(id: ProfileId, onLog: Log): Promise<AcpLease> {
    if (this.shuttingDown) throw new Error('ACP pool is shutting down')
    let entry = this.entries.get(id)
    if (entry?.connection && !entry.connection.process.alive) {
      this.retire(id)
      entry = undefined
    }
    if (!entry) {
      if (this.disabled(id)) throw new Error('ACP startup disabled for this account')
      entry = this.start(id, onLog)
    }
    entry.log = onLog
    clearTimeout(entry.timer)
    entry.active++
    const connection = await entry.starting
    const acquired = entry
    let released = false
    return {
      connection,
      release: () => {
        if (released) return
        released = true
        if (--acquired.active > 0) return
        if (acquired.stale) this.retire(id, acquired.connection)
        else this.scheduleIdle(id, acquired, 0)
      }
    }
  }

  retire(id: ProfileId, expected?: AcpConnection): void {
    const entry = this.entries.get(id)
    if (!entry || (expected && entry.connection !== expected)) return
    this.entries.delete(id)
    clearTimeout(entry.timer)
    if (entry.connection) permissions.cancelAll((request) => request.connection === entry.connection)
    entry.abort.abort()
    entry.connection?.process.terminate()
  }

  /** Like retire(), but never interrupts a running turn: an active process is restarted after it goes idle. */
  retireWhenIdle(id: ProfileId): void {
    const entry = this.entries.get(id)
    if (!entry) return
    if (entry.active > 0) entry.stale = true
    else this.retire(id)
  }

  shutdownAll(): void {
    this.shuttingDown = true
    for (const id of this.entries.keys()) this.retire(id)
  }

  private start(id: ProfileId, log: Log): Entry {
    const abort = new AbortController()
    // Defer startup until the entry is installed, including synchronous spawn-spec failures.
    const starting = Promise.resolve().then(async () => {
      abort.signal.throwIfAborted()
      const bin = kindBinaryPath('gemini')
      if (!bin) throw new Error(t('main.cliNotInstalled', { kind: 'gemini' }))
      const { env } = buildSpawnSpec(id, 'run')
      const process = await startAcpProcess({
        bin, args: ['acp'], env, cwd: realHome, version: app.getVersion(), signal: abort.signal,
        onLog: (text) => entry.log(text),
        onNotification: (method, params) => {
          const p = params as AcpFields | null
          if (method === 'session/update' && typeof p?.sessionId === 'string' && p.update && typeof p.update === 'object') {
            entry.connection?.update(p.sessionId, p.update)
          }
        },
        onRequest: (method, params) => {
          if (method !== 'session/request_permission') throw new JsonRpcError(-32601, 'Method not found')
          const p = params as AcpFields | null
          if (typeof p?.sessionId !== 'string') return cancelledPermission()
          return entry.connection?.permission(p) ?? cancelledPermission()
        }
      })
      abort.signal.throwIfAborted()
      const connection = new AcpConnection(process, env.HOME ?? realHome)
      entry.connection = connection
      this.failures.delete(id)
      void process.exited.then(() => this.retire(id, connection))
      return connection
    }).catch((error: unknown) => {
      if (this.entries.get(id) === entry) {
        this.entries.delete(id)
        if (!abort.signal.aborted) this.failures.set(id, (this.failures.get(id) ?? 0) + 1)
      }
      throw error
    })
    const entry: Entry = { starting, abort, active: 0, log }
    this.entries.set(id, entry)
    return entry
  }

  private scheduleIdle(id: ProfileId, entry: Entry, deferred: number): void {
    if (this.entries.get(id) !== entry) return
    entry.timer = setTimeout(() => {
      if (entry.active > 0 || this.entries.get(id) !== entry) return
      if (deferred < MAX_IDLE_DEFERRAL && entry.connection?.hasRunningCommands()) {
        this.scheduleIdle(id, entry, deferred + IDLE_MS)
      } else {
        this.retire(id)
      }
    }, IDLE_MS).unref()
  }
}

export const agyAcpPool = new AcpPool()
