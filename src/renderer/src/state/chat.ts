import { useSyncExternalStore } from 'react'
import type { ActivityDetail, ActivityType, ChatEvent, HistoryEntry, HistoryMessage, HistoryThread, ProfileId, ProfileKind, RunAttachment, Usage } from '@shared/types'

/**
 * Threads: one unified multi-model conversation each. Module-level store (survives page
 * switches), persisted to localStorage. Replies come from real CLI runs in the main process
 * (src/main/orchestrator.ts) as ChatEvents.
 */

export interface Attachment {
  id: string
  name: string
  /** Absolute path on disk (dropped files, or staged copies of pasted images). */
  path: string | null
  size: number
  isImage: boolean
  /** Small JPEG data URL for images (≈160px). */
  thumb: string | null
}

/** Who speaks: account + sub-model (null = account/CLI default). */
export interface AgentRef {
  profileId: ProfileId
  name: string
  kind: ProfileKind
  model: string | null
}

export interface UserMessage {
  role: 'user'
  id: string
  turnId: string
  text: string
  attachments: Attachment[]
  /** Driver account chosen in the composer. */
  driver: AgentRef
  /** @-mentioned accounts, in order of appearance. */
  mentions: AgentRef[]
  createdAt: number
  /** 'handoff': the request that made the driver write a handoff document. */
  kind?: 'handoff'
  /** Small system line under the bubble (e.g. handoff synced). */
  note?: string
}

export interface Activity {
  id?: string
  type: ActivityType
  target: string
  status?: 'running' | 'done' | 'error'
  detail?: ActivityDetail
}

export interface Thinking {
  text: string
  /** Latest token estimate (claude live estimate, agy/codex totals). */
  tokens: number | null
  startedAt: number
  /** Set when the answer (text or a tool call) starts. */
  endedAt: number | null
  /** false: only a token total was reported afterwards, so the duration is unknown. */
  timed?: boolean
}

export interface AssistantMessage {
  role: 'assistant'
  id: string
  turnId: string
  agent: AgentRef
  /** Model the CLI reported it actually used. */
  actualModel: string | null
  /** Set when this reply was dispatched by the driver rather than asked directly. */
  dispatchedBy: AgentRef | null
  status: 'queued' | 'streaming' | 'done' | 'stopped' | 'error'
  /** Markdown. */
  content: string
  activity: Activity[]
  thinking: Thinking | null
  usage: Usage | null
  /** Structured CLI events no adapter rule handles (kept visible, never dropped). */
  others: { kind: string; payload: string }[]
  /** Absolute paths of files this step produced. */
  outputs: string[]
  error: string | null
  /** Non-fatal warnings (e.g. auto-denied tool calls). */
  notices: string[]
  review: boolean
  retry: number
  verdict: { status: 'PASS' | 'REJECT'; reason: string } | null
  startedAt: number | null
  endedAt: number | null
}

export type Message = UserMessage | AssistantMessage

export interface Thread {
  id: string
  title: string
  projectDir: string | null
  /** Folder runs actually use (projectDir, or AgentMux's private workspace). */
  workdir: string | null
  /** Accounts allowed to take part in this thread. */
  participants: ProfileId[]
  driver: { profileId: ProfileId | null; model: string | null }
  messages: Message[]
  /** Running turn, if any. */
  activeTurn: string | null
  /** Review gave up after max retries; waiting for the user. */
  pause: { turnId: string; reason: string } | null
  createdAt: number
  updatedAt: number
  /** Imported from a local CLI session (read-only source; the same account resumes it). */
  imported?: { key: string; profileId: ProfileId; kind: ProfileKind; nativeId: string; importedAt: number; notice: string | null }
  /** Just viewing a CLI history entry: not listed or persisted; becomes a real thread on first send. */
  preview?: boolean
  /** Messages parsed from the CLI history (never persisted: re-read on demand). */
  history?: Message[]
  historyState?: 'loading' | 'error'
  /** Handoff document waiting to be injected into the target account's first message. */
  handoff?: { to: ProfileId; path: string; from: string } | null
  /** Handoff generation failed for this target (offer the export fallback). */
  handoffFailed?: { to: ProfileId; error: string } | null
  /** Accounts the user chose to switch to without a handoff. */
  handoffSkip?: ProfileId[]
}

interface ChatState {
  threads: Thread[]
  activeId: string | null
}

const LS_KEY = 'agentmux.threads.v2'
const uid = () => Math.random().toString(36).slice(2, 10)
const now = () => Date.now()
const endThinking = (t: Thinking | null): Thinking | null => (t && !t.endedAt ? { ...t, endedAt: now() } : t)

function load(): ChatState {
  try {
    const v = JSON.parse(localStorage.getItem(LS_KEY) ?? '') as ChatState
    // a reload loses the live event stream: settle anything that was in flight
    for (const t of v.threads) {
      t.activeTurn = null
      t.pause = null
      for (const m of t.messages)
        if (m.role === 'assistant' && (m.status === 'streaming' || m.status === 'queued')) {
          m.status = 'stopped'
          m.endedAt = m.endedAt ?? (m.startedAt ? now() : null)
        }
    }
    // earlier versions turned every viewed history entry into a chat: drop the ones never written to
    const viewedOnly = v.threads.filter((t) => t.imported && t.messages.length === 0)
    if (viewedOnly.length) {
      v.threads = v.threads.filter((t) => !viewedOnly.includes(t))
      if (v.activeId && viewedOnly.some((t) => t.id === v.activeId)) v.activeId = v.threads[0]?.id ?? null
      setTimeout(() => {
        for (const t of viewedOnly) void window.agentmux.chat.deleteThread({ threadId: t.id, projectDir: null, turnIds: [], purgeCli: false }).catch(() => {})
      })
    }
    return v
  } catch {
    return { threads: [], activeId: null }
  }
}

let state: ChatState = load()
const listeners = new Set<() => void>()
let persistTimer: ReturnType<typeof setTimeout> | null = null

function set(next: ChatState) {
  // a history preview only lives while it is on screen
  if (next.threads.some((t) => t.preview && t.id !== next.activeId)) next = { ...next, threads: next.threads.filter((t) => !t.preview || t.id === next.activeId) }
  state = next
  listeners.forEach((l) => l())
  if (persistTimer) return // streaming updates are frequent; persist at most every 400ms
  persistTimer = setTimeout(() => {
    persistTimer = null
    try {
      // imported history is re-read from the CLI files; keep localStorage small
      const threads = state.threads.filter((t) => !t.preview).map(({ history: _h, historyState: _s, ...t }) => t)
      localStorage.setItem(LS_KEY, JSON.stringify({ ...state, threads, activeId: threads.some((t) => t.id === state.activeId) ? state.activeId : (threads[0]?.id ?? null) }))
    } catch {
      /* quota exceeded: keep in memory only */
    }
  }, 400)
}

const patchThread = (id: string, fn: (t: Thread) => Thread) => set({ ...state, threads: state.threads.map((t) => (t.id === id ? fn(t) : t)) })

function patchMsg(threadId: string, msgId: string, fn: (m: AssistantMessage) => AssistantMessage) {
  patchThread(threadId, (t) => ({ ...t, messages: t.messages.map((m) => (m.role === 'assistant' && m.id === msgId ? fn(m) : m)) }))
}

export function useChat(): ChatState {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    () => state
  )
}

export const activeThread = (s: ChatState): Thread | null => s.threads.find((t) => t.id === s.activeId) ?? null
export const isThreadBusy = (t: Thread | null) => !!t?.activeTurn
/** History (imported) + AgentMux messages, oldest first. */
export const threadMessages = (t: Thread | null): Message[] => (t ? (t.history?.length ? [...t.history, ...t.messages] : t.messages) : [])

/** Accounts that already hold a CLI session in this thread (they need no handoff). */
export function sessionAccounts(t: Thread): Set<ProfileId> {
  const out = new Set<ProfileId>()
  if (t.imported) out.add(t.imported.profileId)
  for (const m of t.messages) if (m.role === 'assistant' && m.status !== 'queued' && m.startedAt) out.add(m.agent.profileId)
  return out
}

/** Last account that answered (the one that knows the context best). */
export function lastSpeaker(t: Thread): AgentRef | null {
  const all = threadMessages(t)
  for (let i = all.length - 1; i >= 0; i--) {
    const m = all[i]
    if (m.role === 'assistant' && (m.content || m.activity.length)) return m.agent
  }
  return null
}

// ---- thread management -----------------------------------------------------------------

export function newThread(init: Pick<Thread, 'projectDir' | 'participants' | 'driver'>): string {
  const t: Thread = { id: uid(), title: '新对话', workdir: init.projectDir, messages: [], activeTurn: null, pause: null, createdAt: now(), updatedAt: now(), ...init }
  set({ threads: [t, ...state.threads], activeId: t.id })
  return t.id
}

export const selectThread = (id: string) => set({ ...state, activeId: id })
export const patchThreadState = (id: string, patch: Partial<Thread>) => patchThread(id, (t) => ({ ...t, ...patch }))
export const renameThread = (id: string, title: string) => title.trim() && patchThread(id, (t) => ({ ...t, title: title.trim() }))
export const updateThread = (id: string, patch: Partial<Pick<Thread, 'projectDir' | 'participants' | 'driver'>>) =>
  patchThread(id, (t) => ({ ...t, ...patch, workdir: patch.projectDir !== undefined ? patch.projectDir : t.workdir }))

/**
 * Removes the chat and AgentMux's files for it (session map, run artefacts). With purgeCli the
 * CLI's own session files go to the Trash as well. Usage statistics are kept.
 */
export async function deleteThread(id: string, purgeCli = false) {
  const t = state.threads.find((x) => x.id === id)
  if (!t) return null
  if (t.activeTurn) await window.agentmux.chat.stop(id)
  const threads = state.threads.filter((x) => x.id !== id)
  set({ threads, activeId: state.activeId === id ? (threads[0]?.id ?? null) : state.activeId })
  const turnIds = [...new Set(t.messages.map((m) => m.turnId).filter(Boolean))]
  return window.agentmux.chat.deleteThread({ threadId: id, projectDir: t.workdir ?? t.projectDir, turnIds, purgeCli })
}

// ---- sending ---------------------------------------------------------------------------------

const TRANSCRIPT_MSGS = 10
const TRANSCRIPT_EACH = 800

function transcriptOf(t: Thread): string {
  return threadMessages(t)
    .filter((m) => !(m.role === 'user' && m.kind === 'handoff'))
    .slice(-TRANSCRIPT_MSGS)
    .map((m) => {
      if (m.role === 'user') return `用户：${m.text}${m.attachments.length ? `（附件 ${m.attachments.map((a) => a.name).join('、')}）` : ''}`
      if (!m.content.trim()) return null
      const body = plainExcerpt(m.content)
      return `${m.agent.name}：${body.length > TRANSCRIPT_EACH ? body.slice(0, TRANSCRIPT_EACH) + '…' : body}`
    })
    .filter(Boolean)
    .join('\n')
}

const errorMessage = (turnId: string, agent: AgentRef, error: string): AssistantMessage => ({
  role: 'assistant',
  id: uid(),
  turnId,
  agent,
  actualModel: null,
  dispatchedBy: null,
  status: 'error',
  content: '',
  activity: [],
  thinking: null,
  usage: null,
  others: [],
  outputs: [],
  error,
  notices: [],
  review: false,
  retry: 0,
  verdict: null,
  startedAt: now(),
  endedAt: now()
})

export function send(
  threadId: string,
  input: { text: string; attachments: Attachment[]; driver: AgentRef; mentions: AgentRef[]; participants: ProfileId[]; projectDir: string | null; handoffTo?: AgentRef }
): void {
  const thread = state.threads.find((t) => t.id === threadId)
  if (!thread || thread.activeTurn) return
  const turnId = uid() + uid()
  const mode = input.handoffTo ? 'handoff' : 'chat'
  // a pending handoff document goes to the first message of its target account
  const doc = mode === 'chat' && thread.handoff && [input.driver, ...input.mentions].some((a) => a.profileId === thread.handoff!.to) ? thread.handoff : null
  const user: UserMessage = {
    role: 'user',
    id: uid(),
    turnId,
    text: input.text,
    attachments: input.attachments,
    driver: input.driver,
    mentions: input.mentions,
    createdAt: now(),
    ...(mode === 'handoff' ? { kind: 'handoff' as const } : {}),
    ...(doc ? { note: `已向 ${[input.driver, ...input.mentions].find((a) => a.profileId === doc.to)?.name ?? ''} 同步交接文档` } : {})
  }
  const firstTurn = !threadMessages(thread).some((m) => m.role === 'user')
  const transcript = transcriptOf(thread)
  // first message in a history preview: it becomes a real chat continuing that CLI session
  const promote = thread.preview && thread.imported
  const ready = promote ? window.agentmux.history.import(threadId, thread.imported!.profileId, thread.imported!.nativeId) : Promise.resolve()
  patchThread(threadId, (t) => ({
    ...t,
    ...(promote ? { preview: false, imported: { ...t.imported!, importedAt: now() } } : {}),
    title: firstTurn ? titleFrom(input.text) : t.title,
    messages: [...t.messages, user],
    activeTurn: turnId,
    pause: null,
    handoff: doc ? null : t.handoff,
    handoffFailed: mode === 'handoff' ? null : t.handoffFailed,
    updatedAt: now()
  }))
  const attachments: RunAttachment[] = input.attachments.filter((a) => a.path).map((a) => ({ name: a.name, path: a.path!, isImage: a.isImage }))
  ready
    .then(() =>
      window.agentmux.chat.send({
        threadId,
        turnId,
        projectDir: input.projectDir,
        text: input.text,
        attachments,
        driver: { profileId: input.driver.profileId, model: input.driver.model },
        mentions: input.mentions.map((m) => ({ profileId: m.profileId, model: m.model })),
        participants: input.participants,
        transcript,
        mode,
        handoffTo: input.handoffTo?.profileId,
        handoffDoc: doc?.path ?? null,
        allowMissingProject: !!thread.imported
      })
    )
    .catch((e: unknown) => {
      const msg = String(e instanceof Error ? e.message : e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
      patchThread(threadId, (t) => ({
        ...t,
        messages: [...t.messages, errorMessage(turnId, input.driver, msg)],
        activeTurn: t.activeTurn === turnId ? null : t.activeTurn
      }))
    })
}

export function stop(threadId: string) {
  void window.agentmux.chat.stop(threadId)
}

export function resolvePause(threadId: string, action: 'retry' | 'skip' | 'stop') {
  const t = state.threads.find((x) => x.id === threadId)
  if (!t?.pause) return
  const turnId = t.pause.turnId
  patchThread(threadId, (x) => ({ ...x, pause: null }))
  void window.agentmux.chat.resume(threadId, turnId, action)
}

// ---- events from the main process ------------------------------------------------------------

function onEvent(e: ChatEvent) {
  if (!state.threads.some((t) => t.id === e.threadId)) return
  switch (e.kind) {
    case 'turn-start':
      return patchThread(e.threadId, (t) => ({ ...t, workdir: e.cwd }))
    case 'step-add': {
      const msg: AssistantMessage = {
        role: 'assistant',
        id: e.stepId,
        turnId: e.turnId,
        agent: { profileId: e.profileId, name: e.name, kind: e.profileKind, model: e.model },
        actualModel: null,
        dispatchedBy: e.dispatchedBy ? { profileId: e.dispatchedBy.profileId, name: e.dispatchedBy.name, kind: e.dispatchedBy.profileKind, model: null } : null,
        status: 'queued',
        content: '',
        activity: [],
        thinking: null,
        usage: null,
        others: [],
        outputs: [],
        error: null,
        notices: [],
        review: e.review,
        retry: e.retry,
        verdict: null,
        startedAt: null,
        endedAt: null
      }
      return patchThread(e.threadId, (t) => {
        const at = e.after ? t.messages.findIndex((m) => m.id === e.after) : -1
        const messages = at < 0 ? [...t.messages, msg] : [...t.messages.slice(0, at + 1), msg, ...t.messages.slice(at + 1)]
        return { ...t, messages }
      })
    }
    case 'step-start':
      return patchMsg(e.threadId, e.stepId, (m) => ({ ...m, status: 'streaming', startedAt: now() }))
    case 'agent': {
      const ev = e.event
      return patchMsg(e.threadId, e.stepId, (m) => {
        switch (ev.t) {
          case 'text':
            return { ...m, content: m.content + ev.delta, thinking: endThinking(m.thinking) }
          case 'thinking': {
            const live = m.thinking && !m.thinking.endedAt
            // token count reported after the fact (agy totals, late claude estimates): update, don't reopen
            if (!ev.delta && ev.tokens !== undefined && !live) {
              const base = m.thinking ?? { text: '', tokens: null, startedAt: now(), endedAt: now(), timed: false }
              return { ...m, thinking: { ...base, tokens: ev.tokens } }
            }
            const th: Thinking = live
              ? m.thinking!
              : { text: m.thinking?.text ? m.thinking.text + '\n\n' : '', tokens: m.thinking?.tokens ?? null, startedAt: m.thinking?.startedAt ?? now(), endedAt: null, timed: true }
            return { ...m, thinking: { ...th, text: th.text + ev.delta, tokens: ev.tokens ?? th.tokens, timed: true } }
          }
          case 'activity': {
            const a: Activity = { id: ev.id, type: ev.type, target: ev.target, status: ev.status, detail: ev.detail }
            const i = ev.id ? m.activity.findIndex((x) => x.id === ev.id) : -1
            const activity = i < 0 ? [...m.activity, a] : m.activity.map((x, j) => (j === i ? { ...x, ...a, detail: { ...x.detail, ...a.detail } } : x))
            return { ...m, activity, thinking: endThinking(m.thinking) }
          }
          case 'usage':
            return { ...m, usage: { ...m.usage, ...ev.usage } }
          case 'other_event':
            return m.others && m.others.length >= 100 ? m : { ...m, others: [...(m.others ?? []), { kind: ev.kind, payload: ev.payload }] }
          case 'output':
            return m.outputs.includes(ev.path) ? m : { ...m, outputs: [...m.outputs, ev.path] }
          case 'session':
            return { ...m, actualModel: ev.model }
          case 'error':
            return { ...m, error: ev.message }
          case 'notice':
            return { ...m, notices: [...(m.notices ?? []), ev.message] }
          case 'rate_limited':
            return { ...m, error: m.error ?? '账号触发了用量限制（rate limit）' }
          default:
            return m // e.g. quota: consumed by the main process
        }
      })
    }
    case 'step-end':
      return patchMsg(e.threadId, e.stepId, (m) => ({ ...m, status: e.status, endedAt: now(), verdict: e.verdict ?? null, thinking: endThinking(m.thinking) }))
    case 'handoff':
      return patchThread(e.threadId, (t) =>
        e.ok ? { ...t, handoff: { to: e.to, path: e.path, from: lastSpeaker(t)?.name ?? '' }, handoffFailed: null } : { ...t, handoffFailed: { to: e.to, error: e.error ?? '生成失败' } }
      )
    case 'paused':
      return patchThread(e.threadId, (t) => ({ ...t, pause: { turnId: e.turnId, reason: e.reason } }))
    case 'turn-end':
      return patchThread(e.threadId, (t) => ({
        ...t,
        activeTurn: t.activeTurn === e.turnId ? null : t.activeTurn,
        pause: t.pause?.turnId === e.turnId ? null : t.pause,
        updatedAt: now(),
        messages: t.messages.map((m) =>
          m.role === 'assistant' && m.turnId === e.turnId && (m.status === 'queued' || m.status === 'streaming') ? { ...m, status: 'stopped', endedAt: m.startedAt ? now() : null } : m
        )
      }))
  }
}

window.agentmux.chat.onEvent(onEvent)

const titleFrom = (text: string) => {
  const t = text
    .replace(/(然后|最后|接着|并且|再)?(让|由|请)?\s*@\S+(\s*账号\s*\d+)?(\([^)]*\))?\s*/g, '')
    .replace(/^[，,、\s]+/, '')
    .replace(/\s+/g, ' ')
    .trim()
  return (t.length > 22 ? t.slice(0, 22) + '…' : t) || '新对话'
}

// ---- helpers -----------------------------------------------------------------------------

/** One-line plain-text preview of markdown. */
export const plainExcerpt = (md: string): string =>
  md
    .replace(/```agentmux:dispatch[\s\S]*?(```|$)/g, ' ')
    .replace(/```[\s\S]*?(```|$)/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s*\|?[\s:-]+\|[\s|:-]*$/gm, ' ')
    .replace(/[#>*`|_~]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

const IMAGE_RE = /\.(png|jpe?g|gif|webp|bmp|heic|svg)$/i

/** Thumbnail as a data: URL (CSP allows img-src data: but not blob:). */
function thumbnail(file: File): Promise<string | null> {
  return new Promise((resolve) => {
    const reader = new FileReader()
    reader.onerror = () => resolve(null)
    reader.onload = () => {
      const img = new Image()
      img.onload = () => {
        const k = Math.min(1, 160 / Math.max(img.width, img.height))
        const c = document.createElement('canvas')
        c.width = Math.max(1, Math.round(img.width * k))
        c.height = Math.max(1, Math.round(img.height * k))
        c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height)
        resolve(c.toDataURL('image/jpeg', 0.8))
      }
      img.onerror = () => resolve(null)
      img.src = String(reader.result)
    }
    reader.readAsDataURL(file)
  })
}

export async function toAttachment(file: File): Promise<Attachment> {
  const isImage = file.type.startsWith('image/') || IMAGE_RE.test(file.name)
  const ext = (file.type.split('/')[1] || 'png').replace('jpeg', 'jpg')
  const name = file.name || `pasted-${Date.now()}.${ext}`
  let path = window.agentmux.sys.pathForFile(file) || null
  // pasted images live only in memory: stage a real file so the CLIs can read it
  if (!path) path = await window.agentmux.attach.stage(name, await file.arrayBuffer()).catch(() => null)
  return { id: uid(), name, path, size: file.size, isImage, thumb: isImage ? await thumbnail(file) : null }
}

// ---- handoff ---------------------------------------------------------------------------------

/** Fallback when the source account can't write one: the recent conversation, as a document. */
export async function exportHandoff(threadId: string, to: AgentRef): Promise<void> {
  const t = state.threads.find((x) => x.id === threadId)
  if (!t) return
  const lines: string[] = [`# 交接文档（AgentMux 从最近对话导出）`, '', `> 原模型暂不可用，以下是这个对话最近的记录，交给 ${to.name} 继续。`, '']
  if (t.workdir || t.projectDir) lines.push(`项目目录：${t.workdir ?? t.projectDir}`, '')
  lines.push('## 最近对话', '')
  for (const m of threadMessages(t).slice(-30)) {
    if (m.role === 'user') {
      if (m.kind === 'handoff') continue
      lines.push(`### 用户`, m.text, '')
    } else if (m.content.trim() || m.activity.length) {
      lines.push(`### ${m.agent.name}`, m.content.length > 3000 ? m.content.slice(0, 3000) + '\n…（已截断）' : m.content)
      const files = [...new Set(m.activity.filter((a) => a.type === 'write').map((a) => a.target))]
      if (files.length) lines.push('', '改动的文件：', ...files.map((f) => `- ${f}`))
      lines.push('')
    }
  }
  const path = await window.agentmux.chat.exportHandoff(threadId, uid() + uid(), t.projectDir, lines.join('\n'))
  patchThread(threadId, (x) => ({ ...x, handoff: { to: to.profileId, path, from: '最近对话导出' }, handoffFailed: null }))
}

export const skipHandoff = (threadId: string, to: ProfileId) => patchThread(threadId, (t) => ({ ...t, handoffSkip: [...new Set([...(t.handoffSkip ?? []), to])], handoffFailed: null }))

// ---- imported CLI history ----------------------------------------------------------------------

function fromHistory(h: HistoryThread, agent: AgentRef): Message[] {
  return h.messages.map((m: HistoryMessage, i): Message => {
    const id = `h${i}`
    if (m.role === 'user') return { role: 'user', id, turnId: `hist-${i}`, text: m.text, attachments: [], driver: agent, mentions: [], createdAt: m.at }
    return {
      role: 'assistant',
      id,
      turnId: `hist-${i}`,
      agent: { ...agent, model: m.model },
      actualModel: m.model,
      dispatchedBy: null,
      status: 'done',
      content: m.text,
      activity: m.activity,
      thinking: m.thinking ? { text: m.thinking, tokens: null, startedAt: m.at, endedAt: m.endAt, timed: false } : null,
      usage: null,
      others: [],
      outputs: m.outputs,
      error: null,
      notices: [],
      review: false,
      retry: 0,
      verdict: null,
      startedAt: m.at,
      endedAt: m.endAt
    }
  })
}

export const importedThreadOf = (key: string): Thread | null => state.threads.find((t) => t.imported?.key === key) ?? null

/** Shows a CLI history entry (a preview; or selects the chat it was already continued in). */
export async function openHistory(entry: HistoryEntry, agent: AgentRef, participants: ProfileId[]): Promise<string> {
  const existing = importedThreadOf(entry.key)
  if (existing) {
    selectThread(existing.id)
    if (!existing.history) void loadHistory(existing.id, agent)
    return existing.id
  }
  const h = await window.agentmux.history.open(entry.key)
  const id = uid()
  const projectDir = h.cwdExists ? entry.cwd : null
  const t: Thread = {
    id,
    title: entry.title,
    projectDir,
    workdir: projectDir,
    participants: [...new Set([entry.profileId, ...participants])],
    driver: { profileId: entry.profileId, model: null },
    messages: [],
    activeTurn: null,
    pause: null,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    imported: {
      key: entry.key,
      profileId: entry.profileId,
      kind: entry.kind,
      nativeId: entry.nativeId,
      importedAt: Date.now(),
      notice: [h.notice, entry.cwd && !h.cwdExists ? `原项目目录已不存在（${entry.cwd}），新消息会在 AgentMux 私有工作区运行。` : null].filter(Boolean).join(' ') || null
    },
    history: fromHistory(h, agent),
    preview: true
  }
  set({ threads: [t, ...state.threads], activeId: id })
  return id
}

/** Re-reads an imported thread's history (after app restart); only turns from before the import. */
export async function loadHistory(threadId: string, agent: AgentRef): Promise<void> {
  const t = state.threads.find((x) => x.id === threadId)
  if (!t?.imported || t.historyState === 'loading') return
  patchThread(threadId, (x) => ({ ...x, historyState: 'loading' }))
  try {
    const h = await window.agentmux.history.open(t.imported.key)
    const cut = t.imported.importedAt
    // turns the CLI recorded after the import are AgentMux's own messages (already in t.messages)
    const kept = { ...h, messages: h.messages.filter((m) => m.at <= cut) }
    patchThread(threadId, (x) => ({ ...x, history: fromHistory(kept, agent), historyState: undefined }))
  } catch {
    patchThread(threadId, (x) => ({ ...x, history: [], historyState: 'error' }))
  }
}
