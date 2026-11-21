import { useSyncExternalStore } from 'react'
import type { ChatEvent, ProfileId, ProfileKind, RunAttachment } from '@shared/types'

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
}

export interface Activity {
  type: 'read' | 'write' | 'run' | 'search'
  target: string
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
}

interface ChatState {
  threads: Thread[]
  activeId: string | null
}

const LS_KEY = 'agentmux.threads.v2'
const uid = () => Math.random().toString(36).slice(2, 10)
const now = () => Date.now()

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
    return v
  } catch {
    return { threads: [], activeId: null }
  }
}

let state: ChatState = load()
const listeners = new Set<() => void>()
let persistTimer: ReturnType<typeof setTimeout> | null = null

function set(next: ChatState) {
  state = next
  listeners.forEach((l) => l())
  if (persistTimer) return // streaming updates are frequent; persist at most every 400ms
  persistTimer = setTimeout(() => {
    persistTimer = null
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(state))
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

// ---- thread management -----------------------------------------------------------------

export function newThread(init: Pick<Thread, 'projectDir' | 'participants' | 'driver'>): string {
  const t: Thread = { id: uid(), title: '新对话', workdir: init.projectDir, messages: [], activeTurn: null, pause: null, createdAt: now(), updatedAt: now(), ...init }
  set({ threads: [t, ...state.threads], activeId: t.id })
  return t.id
}

export const selectThread = (id: string) => set({ ...state, activeId: id })
export const renameThread = (id: string, title: string) => title.trim() && patchThread(id, (t) => ({ ...t, title: title.trim() }))
export const updateThread = (id: string, patch: Partial<Pick<Thread, 'projectDir' | 'participants' | 'driver'>>) =>
  patchThread(id, (t) => ({ ...t, ...patch, workdir: patch.projectDir !== undefined ? patch.projectDir : t.workdir }))

export function deleteThread(id: string) {
  const t = state.threads.find((x) => x.id === id)
  if (t?.activeTurn) void window.agentmux.chat.stop(id)
  const threads = state.threads.filter((x) => x.id !== id)
  set({ threads, activeId: state.activeId === id ? (threads[0]?.id ?? null) : state.activeId })
}

// ---- sending ---------------------------------------------------------------------------------

const TRANSCRIPT_MSGS = 10
const TRANSCRIPT_EACH = 800

function transcriptOf(t: Thread): string {
  return t.messages
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
  input: { text: string; attachments: Attachment[]; driver: AgentRef; mentions: AgentRef[]; participants: ProfileId[]; projectDir: string | null }
): void {
  const thread = state.threads.find((t) => t.id === threadId)
  if (!thread || thread.activeTurn) return
  const turnId = uid() + uid()
  const user: UserMessage = {
    role: 'user',
    id: uid(),
    turnId,
    text: input.text,
    attachments: input.attachments,
    driver: input.driver,
    mentions: input.mentions,
    createdAt: now()
  }
  const firstTurn = !thread.messages.some((m) => m.role === 'user')
  const transcript = transcriptOf(thread)
  patchThread(threadId, (t) => ({
    ...t,
    title: firstTurn ? titleFrom(input.text) : t.title,
    messages: [...t.messages, user],
    activeTurn: turnId,
    pause: null,
    updatedAt: now()
  }))
  const attachments: RunAttachment[] = input.attachments.filter((a) => a.path).map((a) => ({ name: a.name, path: a.path!, isImage: a.isImage }))
  window.agentmux.chat
    .send({
      threadId,
      turnId,
      projectDir: input.projectDir,
      text: input.text,
      attachments,
      driver: { profileId: input.driver.profileId, model: input.driver.model },
      mentions: input.mentions.map((m) => ({ profileId: m.profileId, model: m.model })),
      participants: input.participants,
      transcript
    })
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
            return { ...m, content: m.content + ev.delta }
          case 'activity':
            return { ...m, activity: [...m.activity, { type: ev.type, target: ev.target }] }
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
        }
      })
    }
    case 'step-end':
      return patchMsg(e.threadId, e.stepId, (m) => ({ ...m, status: e.status, endedAt: now(), verdict: e.verdict ?? null }))
    case 'paused':
      return patchThread(e.threadId, (t) => ({ ...t, pause: { turnId: e.turnId, reason: e.reason } }))
    case 'turn-end':
      return patchThread(e.threadId, (t) => ({
        ...t,
        activeTurn: t.activeTurn === e.turnId ? null : t.activeTurn,
        pause: t.pause?.turnId === e.turnId ? null : t.pause,
        updatedAt: now(),
        messages: t.messages.map((m) =>
          m.role === 'assistant' && m.turnId === e.turnId && (m.status === 'queued' || m.status === 'streaming')
            ? { ...m, status: 'stopped', endedAt: m.startedAt ? now() : null }
            : m
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
