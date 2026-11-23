import type { Readable, Writable } from 'node:stream'

export type RpcRequestHandler = (method: string, params: unknown) => unknown
export type RpcNotificationHandler = (method: string, params: unknown) => void

export class JsonRpcError extends Error {
  constructor(public readonly code: number, message: string, public readonly data?: unknown) {
    super(message)
  }
}

interface Pending {
  resolve: (result: unknown) => void
  reject: (reason: Error) => void
  onResponse?: () => void
  timer?: NodeJS.Timeout
}

const asError = (e: unknown): Error => e instanceof Error ? e : new Error(String(e))

const LOG_LINE_MAX = 8 * 1024
/** Keeps protocol logs readable: base64 images and long outputs would flood the debug terminal. */
export function clipLogLine(line: string): string {
  if (line.length <= LOG_LINE_MAX) return line
  // Cut at whitespace-free runs too, so a clipped secret never keeps a recognisable tail.
  const head = line.slice(0, 6 * 1024).replace(/[^\s"]+$/, '')
  const tail = line.slice(-1024).replace(/^[^\s"]+/, '')
  return `${head}…[${line.length - head.length - tail.length} chars omitted]…${tail}`
}

export class JsonRpc {
  private nextId = 0
  private buffer = ''
  private pending = new Map<number, Pending>()
  private closed: Error | null = null

  constructor(
    private readonly stdin: Writable,
    stdout: Readable,
    private readonly onLog: (line: string) => void,
    private readonly onRequest?: RpcRequestHandler,
    private readonly onNotification?: RpcNotificationHandler
  ) {
    stdout.setEncoding('utf8')
    stdout.on('data', (chunk: string) => {
      if (this.closed) return
      const lines = (this.buffer + chunk).split('\n')
      this.buffer = lines.pop()!
      for (const line of lines) this.receive(line)
    })
    stdout.on('end', () => {
      if (!this.closed) this.receive(this.buffer)
      this.buffer = ''
    })
    // The process owner closes RPC after collecting its exit status and stderr.
    stdin.on('error', (error) => this.onLog(`[ACP stdin] ${error.message}\n`))
    stdout.on('error', (error) => this.onLog(`[ACP stdout] ${error.message}\n`))
  }

  request<T = unknown>(method: string, params: unknown, timeoutMs?: number, onResponse?: () => void): Promise<T> {
    if (this.closed) return Promise.reject(this.closed)
    const id = ++this.nextId
    return new Promise((resolve, reject) => {
      const timer = timeoutMs === undefined ? undefined : setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`${method} timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      this.pending.set(id, { resolve: (result) => resolve(result as T), reject, onResponse, timer })
      try {
        this.write({ id, method, params })
      } catch (e) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(asError(e))
      }
    })
  }

  notify(method: string, params: unknown): void {
    this.write({ method, params })
  }

  close(reason: Error): void {
    if (this.closed) return
    this.closed = reason
    this.buffer = ''
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer)
      reject(reason)
    }
    this.pending.clear()
  }

  private write(fields: Record<string, unknown>): void {
    if (this.closed) throw this.closed
    const line = JSON.stringify({ jsonrpc: '2.0', ...fields })
    this.stdin.write(line + '\n')
    this.onLog(`[ACP →] ${clipLogLine(line)}\n`)
  }

  private receive(raw: string): void {
    if (this.closed || !raw.trim()) return
    this.onLog(`[ACP ←] ${clipLogLine(raw)}\n`)
    let value: unknown
    try {
      value = JSON.parse(raw)
    } catch {
      return
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) return
    const { id, method, params, result, error } = value as Record<string, unknown>
    if (typeof method === 'string') {
      if (typeof id === 'number' || typeof id === 'string' || id === null) {
        void this.respond(id, method, params)
      } else {
        try {
          this.onNotification?.(method, params)
        } catch (e) {
          this.onLog(`[ACP notification] ${asError(e).message}\n`)
        }
      }
      return
    }
    if (typeof id !== 'number') return
    const call = this.pending.get(id)
    if (!call) return
    this.pending.delete(id)
    clearTimeout(call.timer)
    call.onResponse?.()
    if (error && typeof error === 'object') {
      const rpcError = error as { code?: number; message?: string; data?: unknown }
      call.reject(new JsonRpcError(rpcError.code ?? -32603, rpcError.message ?? 'JSON-RPC error', rpcError.data))
    } else {
      call.resolve(result)
    }
  }

  private async respond(id: string | number | null, method: string, params: unknown): Promise<void> {
    let response: Record<string, unknown>
    try {
      if (!this.onRequest) throw new JsonRpcError(-32601, 'Method not found')
      const handled = this.onRequest(method, params)
      // Synchronous handlers can answer permissions before another stop can intervene.
      const result = handled instanceof Promise ? await handled : handled
      response = { id, result: result ?? null }
    } catch (e) {
      const error = e instanceof JsonRpcError ? e : new JsonRpcError(-32603, asError(e).message)
      response = { id, error: { code: error.code, message: error.message, data: error.data } }
    }
    if (this.closed) return
    try {
      this.write(response)
    } catch (e) {
      this.onLog(`[ACP response] ${asError(e).message}\n`)
    }
  }
}
