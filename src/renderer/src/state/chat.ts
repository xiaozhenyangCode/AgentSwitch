import { useSyncExternalStore } from 'react'
import type { ProfileId, ProfileKind } from '@shared/types'
import { mockConversation } from '../lib/mockReply'

/**
 * Threads of one unified multi-model conversation each. Module-level store so it
 * survives page switches; persisted to localStorage. Replies are SIMULATED (streamed
 * mock markdown) until the real CLI engine lands in Phase 2.
 */

export interface Attachment {
  id: string
  name: string
  /** Absolute path on disk (via webUtils), null for pasted images. */
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
  agent: AgentRef
  /** Set when this reply was dispatched by the driver rather than asked directly. */
  dispatchedBy: AgentRef | null
  status: 'queued' | 'streaming' | 'done' | 'stopped' | 'error'
  /** Markdown. */
  content: string
  activity: Activity[]
  startedAt: number | null
  endedAt: number | null
}

export type Message = UserMessage | AssistantMessage

export interface Thread {
  id: string
  title: string
  projectDir: string | null
  /** Accounts allowed to take part in this thread. */
  participants: ProfileId[]
  driver: { profileId: ProfileId | null; model: string | null }
  messages: Message[]
  createdAt: number
  updatedAt: number
}

interface ChatState {
  threads: Thread[]
  activeId: string | null
}

const LS_KEY = 'agentmux.threads.v1'
const uid = () => Math.random().toString(36).slice(2, 10)
const now = () => Date.now()

function load(): ChatState {
  try {
    const v = JSON.parse(localStorage.getItem(LS_KEY) ?? '') as ChatState
    for (const t of v.threads)
      for (const m of t.messages)
        if (m.role === 'assistant' && (m.status === 'streaming' || m.status === 'queued')) {
          m.status = 'stopped'
          m.endedAt = m.endedAt ?? now()
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
export const isThreadBusy = (t: Thread | null) =>
  !!t && t.messages.some((m) => m.role === 'assistant' && (m.status === 'streaming' || m.status === 'queued'))

// ---- thread management -----------------------------------------------------------------

export function newThread(init: Pick<Thread, 'projectDir' | 'participants' | 'driver'>): string {
  const t: Thread = { id: uid(), title: '新对话', messages: [], createdAt: now(), updatedAt: now(), ...init }
  set({ threads: [t, ...state.threads], activeId: t.id })
  return t.id
}

export const selectThread = (id: string) => set({ ...state, activeId: id })
export const renameThread = (id: string, title: string) => title.trim() && patchThread(id, (t) => ({ ...t, title: title.trim() }))
export const updateThread = (id: string, patch: Partial<Pick<Thread, 'projectDir' | 'participants' | 'driver'>>) =>
  patchThread(id, (t) => ({ ...t, ...patch }))

export function deleteThread(id: string) {
  if (runs.get(id)) stop(id)
  const threads = state.threads.filter((t) => t.id !== id)
  set({ threads, activeId: state.activeId === id ? (threads[0]?.id ?? null) : state.activeId })
}

// ---- sending (simulated orchestration) ------------------------------------------------------

/** Pending timers per thread so a thread's run can be stopped independently. */
const runs = new Map<string, { timer: ReturnType<typeof setTimeout> | null; cancelled: boolean }>()

export function send(threadId: string, input: { text: string; attachments: Attachment[]; driver: AgentRef; mentions: AgentRef[] }) {
  const thread = state.threads.find((t) => t.id === threadId)
  if (!thread) return
  const user: UserMessage = { role: 'user', id: uid(), createdAt: now(), ...input }
  const plan = mockConversation(user, thread.messages)
  const replies: AssistantMessage[] = plan.map((p) => ({
    role: 'assistant',
    id: uid(),
    agent: p.agent,
    dispatchedBy: p.dispatchedBy,
    status: 'queued',
    content: '',
    activity: [],
    startedAt: null,
    endedAt: null
  }))
  const firstTurn = !thread.messages.some((m) => m.role === 'user')
  patchThread(threadId, (t) => ({
    ...t,
    title: firstTurn ? titleFrom(input.text) : t.title,
    messages: [...t.messages, user, ...replies],
    updatedAt: now()
  }))

  // stream replies one after another, like speakers in a group chat
  const run = { timer: null as ReturnType<typeof setTimeout> | null, cancelled: false }
  runs.set(threadId, run)
  let r = 0
  let a = 0
  let pos = 0
  const tick = () => {
    if (run.cancelled) return
    if (r >= replies.length) {
      runs.delete(threadId)
      patchThread(threadId, (t) => ({ ...t, updatedAt: now() }))
      return
    }
    const id = replies[r].id
    const { activity, markdown } = plan[r]
    if (a === 0 && pos === 0) patchMsg(threadId, id, (m) => ({ ...m, status: 'streaming', startedAt: now() }))
    if (a < activity.length) {
      const item = activity[a++]
      patchMsg(threadId, id, (m) => ({ ...m, activity: [...m.activity, item] }))
      run.timer = setTimeout(tick, 320 + Math.random() * 280)
      return
    }
    if (pos < markdown.length) {
      const chunk = markdown.slice(pos, pos + 6 + Math.floor(Math.random() * 18))
      pos += chunk.length
      patchMsg(threadId, id, (m) => ({ ...m, content: m.content + chunk }))
      run.timer = setTimeout(tick, 18 + Math.random() * 26)
      return
    }
    patchMsg(threadId, id, (m) => ({ ...m, status: 'done', endedAt: now() }))
    r++
    a = pos = 0
    run.timer = setTimeout(tick, 500)
  }
  run.timer = setTimeout(tick, 400)
}

export function stop(threadId: string) {
  const run = runs.get(threadId)
  if (run) {
    run.cancelled = true
    if (run.timer) clearTimeout(run.timer)
    runs.delete(threadId)
  }
  patchThread(threadId, (t) => ({
    ...t,
    messages: t.messages.map((m) =>
      m.role === 'assistant' && (m.status === 'streaming' || m.status === 'queued') ? { ...m, status: 'stopped', endedAt: m.startedAt ? now() : null } : m
    )
  }))
}

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
  return {
    id: uid(),
    name: file.name || 'image.png',
    path: window.agentmux.sys.pathForFile(file) || null,
    size: file.size,
    isImage,
    thumb: isImage ? await thumbnail(file) : null
  }
}
