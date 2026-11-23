import { spawn } from 'node:child_process'
import { JsonRpc, type RpcNotificationHandler, type RpcRequestHandler } from './jsonrpc'
import { sanitize, StderrTail } from './stderr'

export const ACP_SETUP_TIMEOUT = 90_000

interface InitializeResult {
  protocolVersion?: number
  agentInfo?: { version?: string }
  agentCapabilities?: {
    promptCapabilities?: { image?: boolean }
    _meta?: Record<string, unknown>
  }
}

interface StartOptions {
  bin: string
  args: string[]
  env: NodeJS.ProcessEnv
  cwd: string
  version: string
  signal?: AbortSignal
  onLog: (text: string) => void
  onRequest?: RpcRequestHandler
  onNotification?: RpcNotificationHandler
}

export interface AcpProcess {
  rpc: JsonRpc
  initializeResult: InitializeResult
  exited: Promise<string>
  terminate: () => void
  readonly alive: boolean
}

export async function startAcpProcess(opts: StartOptions): Promise<AcpProcess> {
  opts.signal?.throwIfAborted()
  const child = spawn(opts.bin, opts.args, { env: opts.env, cwd: opts.cwd, detached: true, stdio: ['pipe', 'pipe', 'pipe'] })
  const log = (text: string) => opts.onLog(sanitize(text, opts.env.HOME))
  const stderr = new StderrTail(opts.env.HOME, opts.onLog)
  const rpc = new JsonRpc(child.stdin, child.stdout, log, opts.onRequest, opts.onNotification)

  let alive = true
  let terminating = false
  let finished = false
  let exitReason = ''
  let drainTimer: NodeJS.Timeout | undefined
  let resolveExit!: (reason: string) => void
  const exited = new Promise<string>((resolve) => { resolveExit = resolve })

  const terminate = (): void => {
    if (terminating) return
    terminating = true
    alive = false
    const pid = child.pid
    if (!pid) return
    try {
      process.kill(-pid, 'SIGTERM')
    } catch {
      return
    }
    setTimeout(() => {
      try {
        process.kill(-pid, 'SIGKILL')
      } catch {
        /* Group has exited. */
      }
    }, 1000).unref()
  }

  const finish = (): void => {
    if (finished) return
    finished = true
    clearTimeout(drainTimer)
    stderr.end()
    const tail = stderr.tail.trim()
    const reason = sanitize(exitReason, opts.env.HOME) + (tail ? `\n${tail}` : '')
    log(`── ${exitReason}\n`)
    rpc.close(new Error(reason))
    resolveExit(reason)
    opts.signal?.removeEventListener('abort', terminate)
  }

  const exit = (reason: string): void => {
    if (exitReason) return
    exitReason = reason
    terminate()
    drainTimer = setTimeout(finish, 250)
  }

  child.stderr.on('data', (chunk: Buffer) => { if (!finished) stderr.push(chunk) })
  child.stderr.on('error', (error) => log(`[ACP stderr] ${error.message}\n`))
  child.stdin.on('error', (error) => exit(error.message))
  child.stdout.on('error', (error) => exit(error.message))
  child.on('error', (error) => exit(error.message))
  child.on('exit', (code, signal) => exit(`ACP exited (code ${code}${signal ? `, ${signal}` : ''})`))
  child.on('close', (code, signal) => {
    exit(`ACP exited (code ${code}${signal ? `, ${signal}` : ''})`)
    finish()
  })
  opts.signal?.addEventListener('abort', terminate, { once: true })

  try {
    const initializeResult = await rpc.request<InitializeResult>('initialize', {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: 'agentswitch', version: opts.version }
    }, ACP_SETUP_TIMEOUT)
    opts.signal?.throwIfAborted()
    if (!alive) throw new Error(await exited)
    if (initializeResult?.protocolVersion !== 1) throw new Error('ACP agent did not negotiate protocol version 1')
    log(`[ACP] agent ${initializeResult.agentInfo?.version ?? '?'} capabilities ${JSON.stringify(initializeResult.agentCapabilities ?? {})}\n`)
    return { rpc, initializeResult, exited, terminate, get alive() { return alive } }
  } catch (e) {
    terminate()
    throw e
  }
}
