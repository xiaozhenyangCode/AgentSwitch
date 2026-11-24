import { randomUUID } from 'node:crypto'
import { constants, realpathSync } from 'node:fs'
import { open } from 'node:fs/promises'
import { dirname, extname, isAbsolute, resolve, sep } from 'node:path'
import { cleanTitle } from '@shared/markers'
import { joinSpec, splitSpec } from '@shared/modelSpec'
import type { AgentEvent, AutoApprove, PermissionEvent, PermissionOption } from '@shared/types'
import { agyTool, capText, full, other, RATE_LIMIT_RE, type RunHandle, type RunResult, type RunSpec } from '../agentRunner'
import { isInvalidKeyError } from '../apiKey'
import { t } from '../i18n'
import { isThreadHistoryToolName } from '../threadHistoryTools'
import { ACP_SETUP_TIMEOUT } from './acpProcess'
import { JsonRpcError } from './jsonrpc'
import { agyOutcomeReader, readAgyConversationTitle } from './agyOutcome'
import { agyAcpPool, type AcpConnection, type AcpFields } from './pool'
import { cancelledPermission, permissions, PERMISSION_TIMEOUT, type PermissionReply } from './permissions'
import { sanitize } from './stderr'

type Emit = (event: AgentEvent) => void
type Log = (text: string) => void
type Activity = Extract<AgentEvent, { t: 'activity' }>
type SessionPath = 'warm' | 'resume' | 'new' | 'resume-fallback-new'

const CANCEL_TIMEOUT = 15_000
const IMAGE_LIMIT = 5 * 1024 * 1024
const MIME_TYPES: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' }
const EDIT_PERMISSIONS = new Set(['edit', 'delete', 'move', 'read', 'search', 'fetch', 'think'])
/** Kinds that change files: under `edits` they must stay inside the project, like agy's own accept-edits. */
const WRITE_KINDS = new Set(['edit', 'delete', 'move'])
const PATH_KEY = /path|file|target|dest|source/i

/** realpath of the nearest existing ancestor, so /var vs /private/var and new files compare correctly. */
function realish(p: string): string {
  let cur = p
  const rest: string[] = []
  for (;;) {
    try {
      return [realpathSync(cur), ...rest].join(sep)
    } catch {
      const up = dirname(cur)
      if (up === cur) return p
      rest.unshift(cur.slice(up.length + (up.endsWith(sep) ? 0 : 1)))
      cur = up
    }
  }
}

/** Every file a tool call names (ACP locations + path-like raw input values). */
export function toolPaths(tool: AcpFields | undefined): string[] {
  const out: string[] = []
  for (const loc of Array.isArray(tool?.locations) ? tool.locations : []) if (typeof loc?.path === 'string' && loc.path) out.push(loc.path)
  const input = tool?.rawInput ?? tool?.args
  if (input && typeof input === 'object') {
    for (const [k, v] of Object.entries(input)) if (PATH_KEY.test(k) && typeof v === 'string' && v) out.push(v)
  }
  return out
}

export function insideProject(paths: string[], cwd: string): boolean {
  if (!paths.length) return false
  const root = realish(resolve(cwd))
  return paths.every((p) => {
    const abs = realish(isAbsolute(p) ? resolve(p) : resolve(cwd, p))
    return abs === root || abs.startsWith(root.endsWith(sep) ? root : root + sep)
  })
}

export class AgyAcpStartupError extends Error {}
const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error)

function isQuestion(tool: AcpFields | undefined): boolean {
  return typeof tool?.toolCallId === 'string' && tool.toolCallId.startsWith('interaction_')
}

function historyToolName(tool: AcpFields | undefined): string | undefined {
  const input = tool?.rawInput ?? tool?.args
  if (tool?.kind === 'execute' || WRITE_KINDS.has(tool?.kind) || typeof input?.CommandLine === 'string') return undefined
  if (input?.ServerName !== undefined) {
    return input.ServerName === 'agentswitch' && isThreadHistoryToolName(input.ToolName) ? input.ToolName : undefined
  }
  // agy can send only a human-readable, namespaced title for MCP calls.
  const titleName = typeof tool?.title === 'string' ? /^Run (mcp_[\w-]+)\??$/.exec(tool.title)?.[1] : undefined
  if (titleName && !isThreadHistoryToolName(titleName)) return undefined
  const name = tool?.name ?? titleName ?? tool?.title
  return isThreadHistoryToolName(name) ? name : undefined
}

export function autoDecision(request: AcpFields, level: AutoApprove, cwd: string, mountedHistoryMcp = false): 'allow' | 'ask' {
  const tool = request.toolCall
  if (isQuestion(tool)) return 'ask'
  if (mountedHistoryMcp && historyToolName(tool)) return 'allow'
  if (level === 'full') return 'allow'
  if (level === 'edits' && EDIT_PERMISSIONS.has(tool?.kind)) {
    if (!WRITE_KINDS.has(tool.kind) || insideProject(toolPaths(tool), cwd)) return 'allow'
  }
  return 'ask'
}

const APPROVAL_ROLES = ['allow_once', 'allow_always', 'reject_once', 'reject_always'] as const
const nonblank = (value: unknown): string => typeof value === 'string' ? value.trim() : ''

function permissionOptions(request: AcpFields, question: boolean): PermissionOption[] {
  const options = new Map<string, PermissionOption>()
  for (const option of Array.isArray(request.options) ? request.options : []) {
    const id = option?.optionId
    if (typeof id !== 'string' || !id.trim() || options.has(id)) continue
    if (!question && !APPROVAL_ROLES.includes(option.kind)) continue
    const role = question ? 'answer' : option.kind
    const warning = role === 'allow_always' ? option._meta?.['agy.security.warning'] : undefined
    const warningText = nonblank(warning?.message) || nonblank(warning?.title)
    options.set(id, { id, role, label: (nonblank(option.name) || id).slice(0, 200), ...(warningText && { warning: warningText.slice(0, 512) }) })
  }
  return [...options.values()]
}

function permissionDetail(tool: AcpFields): string | undefined {
  const input = tool.rawInput ?? tool.args
  const command = typeof input === 'string' ? input : Object.entries(input ?? {}).find(([key, value]) =>
    /command|^cmd$/i.test(key) && typeof value === 'string')?.[1]
  const lines = [...new Set([typeof command === 'string' ? command : '', ...toolPaths(tool)].filter(Boolean))]
  return lines.length ? capText(lines.join('\n'), 4096).slice(0, 4096) : undefined
}

function toolOutput(call: AcpFields): unknown {
  const content = Array.isArray(call.content) ? call.content.flatMap((item: AcpFields) => {
    const block = item?.type === 'content' ? item.content : item
    return block?.type === 'text' && typeof block.text === 'string' ? [block.text] : []
  }).join('\n') : ''
  const raw = call.rawOutput
  return content || raw?.output || raw?.stdout || raw
}

function turnEvents(emit: Emit) {
  const tools = new Map<string, { call: AcpFields; activity: Activity }>()
  let used = 0
  let size = 0
  let hasText = false
  let hasTitle = false
  let nextSegment = false
  let messageId: unknown
  return {
    tool: (id: string) => tools.get(id)?.call,
    hasTitle: () => hasTitle,
    update(update: AcpFields): void {
      const kind = update.sessionUpdate
      switch (kind) {
        case 'agent_message_chunk': {
          const { content } = update
          if (content?.type !== 'text' || typeof content.text !== 'string' || !content.text) return
          const id = update.messageId ?? update._meta?.messageId
          if (hasText && (nextSegment || (id != null && messageId != null && id !== messageId))) emit({ t: 'text', delta: '\n\n' })
          emit({ t: 'text', delta: content.text })
          hasText ||= Boolean(content.text.trim())
          nextSegment = false
          if (id != null) messageId = id
          break
        }
        case 'agent_thought_chunk':
          if (update.content?.type === 'text' && typeof update.content.text === 'string' && update.content.text) {
            nextSegment = true
            emit({ t: 'thinking', delta: update.content.text })
          }
          break
        case 'tool_call':
        case 'tool_call_update': {
          const id = update.toolCallId
          if (typeof id !== 'string') return
          const previous = tools.get(id)?.call
          const call = { ...previous, ...Object.fromEntries(Object.entries(update).filter(([, value]) => value != null)) }
          const name = historyToolName(call) ?? call.name ?? call.title
          const params = call.rawInput ?? call.args
          const activity = agyTool({
            step_index: id,
            tool_name: name,
            tool_kind: call.kind,
            state: call.status === 'pending' || call.status === 'in_progress' || !call.status ? 'ACTIVE'
              : call.status === 'failed' || call.status === 'cancelled' ? 'ERROR' : 'DONE',
            tool_info: { name, parameters: typeof params === 'string' && call.kind === 'execute' ? { command: params } : params, output: toolOutput(call) }
          })
          if (!activity) return
          tools.set(id, { call, activity })
          emit(activity)
          nextSegment = true
          break
        }
        case 'usage_update':
          if (typeof update.used === 'number') used = update.used
          if (typeof update.size === 'number' && update.size > 0) size = update.size
          break
        case 'session_info_update': {
          const title = cleanTitle(update.title)
          if (title) {
            hasTitle = true
            emit({ t: 'title', title })
          }
          break
        }
        case 'available_commands_update':
        case 'config_option_update':
          break
        default:
          emit(other(String(kind ?? 'unknown'), update))
      }
    },
    usage(result: AcpFields): void {
      const usage = result.usage ?? {}
      emit({ t: 'usage', usage: {
        input: usage.inputTokens, output: usage.outputTokens, cacheRead: usage.cachedReadTokens || undefined,
        reasoning: usage.thoughtTokens, context: used || undefined, contextWindow: size || undefined
      } })
    },
    finish(): void {
      for (const { call, activity } of tools.values()) {
        if (call.status !== 'in_progress') continue
        const output = activity.detail?.output
        emit({ ...activity, status: 'done', detail: { ...activity.detail, output: capText([output, t('main.acpBackgroundTool')].filter(Boolean).join('\n\n')) } })
      }
    }
  }
}

type PromptBlock = { type: 'text'; text: string } | { type: 'image'; mimeType: string; data: string }

async function imageBlock(path: string, enabled: boolean): Promise<PromptBlock | null> {
  const mimeType = MIME_TYPES[extname(path).toLowerCase()]
  if (!enabled || !mimeType) return null
  try {
    const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK)
    try {
      const stat = await file.stat()
      if (!stat.isFile() || stat.size > IMAGE_LIMIT) return null
      const data = Buffer.alloc(stat.size + 1)
      let offset = 0
      while (offset < data.length) {
        const { bytesRead } = await file.read(data, offset, data.length - offset, offset)
        if (!bytesRead) break
        offset += bytesRead
      }
      return offset > 0 && offset <= stat.size ? { type: 'image', mimeType, data: data.subarray(0, offset).toString('base64') } : null
    } finally {
      await file.close()
    }
  } catch {
    return null
  }
}

async function promptBlocks(spec: RunSpec, appendSystem: boolean, imagesEnabled: boolean, stopped: () => boolean): Promise<PromptBlock[]> {
  const blocks: PromptBlock[] = []
  const paths: string[] = []
  let text = appendSystem ? spec.prompt : full(spec)
  for (const path of spec.images) {
    if (stopped()) break
    const block = await imageBlock(path, imagesEnabled)
    if (block) blocks.push(block)
    else if (!text.split('\n').includes(`- ${path}`)) paths.push(`- ${path}`)
  }
  if (paths.length) text += `\n\n${t('main.acpAttachmentPaths')}\n${paths.join('\n')}`
  return [{ type: 'text', text }, ...blocks]
}

function optionValues(option: AcpFields | undefined): string[] {
  if (!Array.isArray(option?.options)) return []
  return option.options.flatMap((entry) => Array.isArray(entry?.options) ? entry.options : [entry])
    .flatMap((entry) => typeof entry?.value === 'string' ? [entry.value] : [])
}

function modelOf(options: AcpFields[], fallback: string | null): string | null {
  const model = options.find((option) => option?.id === 'model')?.currentValue
  const effort = options.find((option) => option?.category === 'thought_level')?.currentValue
  return typeof model === 'string' ? joinSpec(model, typeof effort === 'string' ? effort : null) : fallback
}

function retainedOptions(config: AcpFields): AcpFields[] {
  return Array.isArray(config?.configOptions) ? config.configOptions : []
}

export function runAgyAcp(spec: RunSpec, emit: Emit, onLog: Log): RunHandle {
  let stopped = false
  let finished = false
  let prompting = false
  let connection: AcpConnection | undefined
  let sessionId = spec.resume
  let model = spec.model
  let cancelTimer: NodeJS.Timeout | undefined
  let cancelPermissions: (() => void) | undefined
  let finishPrompt: (() => void) | undefined
  let resolveStop!: (result: RunResult) => void
  const stop = new Promise<RunResult>((resolve) => { resolveStop = resolve })
  let log = (text: string) => onLog(sanitize(text, spec.cfg.configDir))

  const result = (ok: boolean, error: string | null = null, rateLimited = false): RunResult =>
    ({ ok: ok && !stopped, stopped, text: '', sessionId, model, error: stopped ? null : error, rateLimited })

  const notice = (message: string) => emit({ t: 'notice', message })

  function cancelPrompt(conn: AcpConnection, id: string): void {
    if (cancelTimer) return
    try {
      conn.process.rpc.notify('session/cancel', { sessionId: id })
    } catch (e) {
      log(`[ACP cancel] ${errorText(e)}\n`)
    }
    cancelTimer = setTimeout(() => {
      finishPrompt?.()
      agyAcpPool.retire(spec.cfg.id, conn)
      resolveStop(result(false))
    }, CANCEL_TIMEOUT)
  }

  function fail(error: unknown): RunResult {
    if (stopped) return result(false)
    const message = sanitize(errorText(error), connection?.home ?? spec.cfg.configDir)
    const rateLimited = RATE_LIMIT_RE.test(message)
    if (rateLimited) emit({ t: 'rate_limited' })
    const errorWithHint = spec.cfg.apiKey && isInvalidKeyError(message) ? `${message}\n${t('apikey.checkKey')}` : message
    return result(false, errorWithHint, rateLimited)
  }

  async function configure(conn: AcpConnection, id: string): Promise<string[]> {
    const session = conn.session(id)
    const writes: string[] = []
    const picked = splitSpec(spec.model)
    const modelOption = session.options.find((o) => o?.id === 'model')
    const choices = optionValues(modelOption)
    const wanted = picked.model
    const legacy = wanted && !choices.includes(wanted)
      ? choices.filter((value) => wanted.startsWith(value + '-')).sort((a, b) => b.length - a.length)[0]
      : undefined

    async function setOption(option: AcpFields, value: string): Promise<void> {
      const revision = session.revision
      try {
        const response = await conn.process.rpc.request<AcpFields>('session/set_config_option', { sessionId: id, configId: option.id, value }, ACP_SETUP_TIMEOUT)
        if (session.revision === revision && Array.isArray(response?.configOptions)) session.options = response.configOptions
      } catch (e) {
        if (stopped) return
        if (!conn.process.alive) throw e
        log(`[ACP config] ${errorText(e)}\n`)
        notice(t('main.acpConfigFailed', { value }))
      }
    }

    // Legacy aliases still need a write even if the agent echoes the requested ID.
    if (wanted && modelOption && (legacy || (choices.includes(wanted) && modelOption.currentValue !== wanted))) {
      writes.push('model')
      await setOption(modelOption, wanted)
    }
    if (stopped) return writes
    const effortOption = session.options.find((o) => o?.category === 'thought_level')
    if (picked.effort && effortOption && effortOption.currentValue !== picked.effort && optionValues(effortOption).includes(picked.effort)) {
      writes.push('thought_level')
      await setOption(effortOption, picked.effort)
    }
    model = modelOf(session.options, model)
    return writes
  }

  async function runTurn(conn: AcpConnection, id: string, appendSystem: boolean, path: SessionPath, turnSpec = spec): Promise<RunResult> {
    if (stopped) return result(false)
    if (!conn.process.alive) throw new Error(await conn.process.exited)
    sessionId = id
    emit({ t: 'session', id, model })
    log(`$ agy acp (session ${id})\n`)
    if (stopped) return result(false)

    const events = turnEvents(emit)
    const hasThreadHistory = conn.session(id).hasThreadHistory
    const turn = Symbol('agy turn')
    cancelPermissions = () => permissions.cancelAll((entry) => entry.turn === turn)

    function permission(request: AcpFields): PermissionReply | Promise<PermissionReply> {
      if (stopped || !prompting) return cancelledPermission()
      const tool = request.toolCall ?? {}
      const question = isQuestion(tool)
      const title = (question ? nonblank(tool.title) || t('permission.question') : nonblank(tool.name) || nonblank(tool.title) || t('permission.tool')).slice(0, 4096)
      if (autoDecision(request, spec.cfg.autoApprove, spec.cwd, hasThreadHistory) === 'allow') {
        const allow = permissionOptions(request, false).find((option) => option.role === 'allow_once')
        log(`[ACP permission] ${title} · ${allow ? 'allow_once' : 'cancelled'}\n`)
        return allow && !stopped ? { outcome: { outcome: 'selected', optionId: allow.id } } : cancelledPermission()
      }

      const toolId = !question && typeof tool.toolCallId === 'string' && tool.toolCallId ? tool.toolCallId : undefined
      const existing = toolId ? events.tool(toolId) : undefined
      if (toolId && !existing) events.update({ ...tool, sessionUpdate: 'tool_call', status: 'pending' })
      if (stopped || !prompting) return cancelledPermission()

      const event: PermissionEvent = {
        t: 'permission',
        requestId: randomUUID(),
        kind: question ? 'question' : 'approval',
        activityId: toolId ? `agy:${toolId}` : undefined,
        title,
        detail: question ? undefined : permissionDetail(tool) ?? (existing && permissionDetail(existing)),
        options: permissionOptions(request, question),
        expiresAt: Date.now() + PERMISSION_TIMEOUT
      }
      return new Promise((resolve) => {
        permissions.register({
          ref: spec.ref, connection: conn, turn, event, resolve,
          emit: (resolution) => {
            emit(resolution)
            log(`[ACP permission] ${title} · ${resolution.outcome}\n`)
            if (resolution.outcome === 'timeout') {
              notice(t(question ? 'main.acpQuestionTimeout' : 'main.acpPermissionTimeout', { name: title }))
            }
          }
        })
        emit(event)
      })
    }

    const unwatch = conn.watch(id, {
      update: (update) => { if (prompting) events.update(update) },
      permission
    })
    const cleanup = (): void => {
      if (!finishPrompt) return
      finishPrompt = undefined
      prompting = false
      clearTimeout(cancelTimer)
      cancelPermissions?.()
      cancelPermissions = undefined
      unwatch()
      events.finish()
    }
    finishPrompt = cleanup
    try {
      const writes = await configure(conn, id)
      if (stopped) return result(false)
      log(`[ACP turn] path=${path} system=${appendSystem ? 'append' : 'inline'} config=${writes.join(',') || 'skipped'}\n`)
      const fallback = hasThreadHistory ? undefined : turnSpec.promptWithoutThreadHistory?.()
      const prompt = await promptBlocks(fallback === undefined ? turnSpec : { ...turnSpec, prompt: fallback }, appendSystem, conn.process.initializeResult.agentCapabilities?.promptCapabilities?.image === true, () => stopped)
      if (stopped) return result(false)
      if (!conn.process.alive) throw new Error(await conn.process.exited)

      const reader = agyOutcomeReader(spec.cfg, id, log, conn.home)
      const start = reader.checkpoint()
      if (stopped) return result(false)
      prompting = true
      const response = await conn.process.rpc.request<AcpFields>('session/prompt', { sessionId: id, prompt }, undefined, () => { prompting = false })
      prompting = false
      model = modelOf(conn.session(id).options, model)
      if (stopped || response?.stopReason === 'cancelled') {
        stopped = true
        // a cancelled prompt still reports what it used so far
        if (response?.usage) events.usage(response)
        return result(false)
      }
      events.usage(response ?? {})
      if (response?.stopReason !== 'end_turn') return fail(t('main.acpStopReason', { reason: String(response?.stopReason ?? '?') }))
      if (!events.hasTitle()) {
        const title = readAgyConversationTitle(spec.cfg, id, conn.home)
        if (title) emit({ t: 'title', title })
      }
      const outcome = reader.after(start)
      if (!outcome) return result(true)
      if (outcome.rateLimited) emit({ t: 'rate_limited' })
      return result(false, outcome.error, outcome.rateLimited)
    } finally {
      cleanup()
    }
  }

  async function run(): Promise<RunResult> {
    log(`\n── ${spec.cfg.name} · ${spec.model ?? t('wb.defaultModel')} · cwd ${spec.cwd}\n`)
    if (stopped) return result(false)
    let lease
    try {
      lease = await agyAcpPool.acquire(spec.cfg.id, onLog)
    } catch (e) {
      if (stopped) return result(false)
      throw new AgyAcpStartupError(sanitize(errorText(e), spec.cfg.configDir))
    }
    const conn = lease.connection
    connection = conn
    log = (text) => onLog(sanitize(text, conn.home))
    try {
      if (stopped) return result(false)
      const capabilities = conn.process.initializeResult.agentCapabilities
      const antigravity = capabilities?._meta?.antigravity as AcpFields | undefined
      const appendSystem = antigravity?.systemPrompt?.append === true
      // ACP v1 requires stdio. Older agy builds omit mcpCapabilities entirely.
      let threadHistory = capabilities?.mcpCapabilities?.stdio === false ? undefined : spec.threadHistory
      const params = {
        cwd: spec.cwd,
        additionalDirectories: [],
        ...(appendSystem && spec.system ? { _meta: { antigravity: { systemPrompt: { append: spec.system } } } } : {})
      }

      async function setupSession(method: 'session/new' | 'session/resume', sessionId?: string): Promise<AcpFields> {
        const setup = { ...params, ...(sessionId === undefined ? {} : { sessionId }) }
        const mcpServers = threadHistory ? [{
          name: 'agentswitch', command: threadHistory.command, args: threadHistory.args,
          env: Object.entries(threadHistory.env).map(([name, value]) => ({ name, value }))
        }] : []
        try {
          return await conn.process.rpc.request<AcpFields>(method, { ...setup, mcpServers }, ACP_SETUP_TIMEOUT)
        } catch (error) {
          // Retry only an explicit MCP setup rejection, before any user prompt went over the wire.
          if (stopped || !conn.process.alive || !threadHistory || !(error instanceof JsonRpcError)
            || !/\bmcp(?:Servers|_servers)?\b/i.test(`${error.message} ${JSON.stringify(error.data) ?? ''}`)) throw error
          log(`[ACP history] ${method} rejected the history MCP: ${error.message}\n`)
          threadHistory = undefined
          return conn.process.rpc.request<AcpFields>(method, { ...setup, mcpServers: [] }, ACP_SETUP_TIMEOUT)
        }
      }

      function activate(id: string, response: AcpFields, revision: number): void {
        const session = conn.session(id)
        session.active = true
        session.system = appendSystem ? spec.system : null
        session.hasThreadHistory = !!threadHistory
        session.threadHistoryPath = threadHistory?.args[1]
        if (session.revision === revision) session.options = retainedOptions(response)
      }

      async function create(path: 'new' | 'resume-fallback-new'): Promise<RunResult> {
        const response = await setupSession('session/new')
        const id = response?.sessionId
        if (typeof id !== 'string' || !id) throw new Error('ACP session/new returned no session ID')
        if (path === 'resume-fallback-new' && id === spec.resume) throw new Error('ACP session/new reused the previous session ID')
        activate(id, response, 0)
        if (stopped) return result(false)
        const turnSpec = path === 'resume-fallback-new' && spec.freshPrompt
          ? { ...spec, prompt: spec.freshPrompt(!!threadHistory), promptWithoutThreadHistory: undefined }
          : spec
        return conn.inOrder(id, () => runTurn(conn, id, appendSystem, path, turnSpec))
      }

      const id = spec.resume
      if (!id) return await create('new')
      return await conn.inOrder(id, async () => {
        if (stopped) return result(false)
        if (!conn.process.alive) throw new Error(await conn.process.exited)
        const session = conn.session(id)
        if (session.hasThreadHistory && session.threadHistoryPath !== threadHistory?.args[1]) {
          // A live MCP must never read a stale snapshot or one belonging to another thread.
          log('[ACP history] cannot reuse the mounted snapshot; opening a new session\n')
          return await create('resume-fallback-new')
        }
        const path = session.active ? 'warm' : 'resume'
        if (!session.active) {
          const revision = session.revision
          try {
            const response = await setupSession('session/resume', id)
            if (response?.sessionId && response.sessionId !== id) throw new Error('ACP resumed a different session ID')
            activate(id, response, revision)
          } catch (e) {
            if (stopped) return result(false)
            if (!conn.process.alive) throw e
            log(`[ACP resume] ${errorText(e)}\n`)
            notice(t('main.acpResumeFailed'))
            if (stopped) return result(false)
            return await create('resume-fallback-new')
          }
        }
        // The native append stays as opened. Inline the instructions if the fixed text changed.
        return await runTurn(conn, id, appendSystem && session.system === spec.system, path)
      })
    } catch (e) {
      return fail(e)
    } finally {
      lease.release()
    }
  }

  const done = Promise.race([Promise.resolve().then(run), stop]).finally(() => { finished = true })
  const kill = (): void => {
    if (stopped || finished) return
    stopped = true
    cancelPermissions?.()
    if (prompting && connection && sessionId) {
      const conn = connection
      const id = sessionId
      // Resolving permissions schedules the RPC responses before the cancel notification.
      queueMicrotask(() => { if (prompting && finishPrompt) cancelPrompt(conn, id) })
    } else resolveStop(result(false))
  }
  return { done, kill }
}
