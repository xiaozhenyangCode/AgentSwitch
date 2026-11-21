import { useSyncExternalStore } from 'react'
import type { ProfileId, ProfileKind } from '@shared/types'
import { mockReply } from '../lib/mockReply'

/**
 * Multi-model conversation: one timeline, each turn addressed to any account.
 * Module-level so it survives page switches. Replies are SIMULATED (streamed mock
 * markdown) until the real CLI streaming is wired in.
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

export interface Agent {
  profileId: ProfileId
  name: string
  kind: ProfileKind
}

/** A previous reply carried into the next turn ("转交给其他模型"). */
export interface Handoff {
  messageId: string
  from: Agent
  excerpt: string
}

export interface UserMessage {
  role: 'user'
  id: string
  text: string
  attachments: Attachment[]
  to: Agent
  handoff: Handoff | null
  createdAt: number
}

export interface Activity {
  type: 'read' | 'write' | 'run' | 'search'
  target: string
}

export interface AssistantMessage {
  role: 'assistant'
  id: string
  agent: Agent
  status: 'streaming' | 'done' | 'stopped' | 'error'
  /** Markdown. */
  content: string
  activity: Activity[]
  startedAt: number
  endedAt: number | null
}

export type Message = UserMessage | AssistantMessage

interface ChatState {
  messages: Message[]
}

const LS_KEY = 'agentmux.chat.v2'
const uid = () => Math.random().toString(36).slice(2, 10)
const now = () => Date.now()

function load(): ChatState {
  try {
    const v = JSON.parse(localStorage.getItem(LS_KEY) ?? '') as ChatState
    for (const m of v.messages)
      if (m.role === 'assistant' && m.status === 'streaming') {
        m.status = 'stopped'
        m.endedAt = m.endedAt ?? now()
      }
    return v
  } catch {
    return { messages: [] }
  }
}

let state: ChatState = load()
const listeners = new Set<() => void>()
let persistTimer: ReturnType<typeof setTimeout> | null = null
let streamTimer: ReturnType<typeof setTimeout> | null = null
let streamingId: string | null = null

function set(next: ChatState) {
  state = next
  listeners.forEach((l) => l())
  // streaming updates are frequent; persist at most every 400ms
  if (persistTimer) return
  persistTimer = setTimeout(() => {
    persistTimer = null
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(state))
    } catch {
      /* quota exceeded: keep in memory only */
    }
  }, 400)
}

function patch(id: string, fn: (m: AssistantMessage) => AssistantMessage) {
  set({ messages: state.messages.map((m) => (m.role === 'assistant' && m.id === id ? fn(m) : m)) })
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

export const isBusy = (s: ChatState) => s.messages.some((m) => m.role === 'assistant' && m.status === 'streaming')

export function send(input: { text: string; attachments: Attachment[]; to: Agent; handoff: Handoff | null }) {
  const user: UserMessage = { role: 'user', id: uid(), createdAt: now(), ...input }
  const reply: AssistantMessage = {
    role: 'assistant',
    id: uid(),
    agent: input.to,
    status: 'streaming',
    content: '',
    activity: [],
    startedAt: now(),
    endedAt: null
  }
  const history = state.messages
  set({ messages: [...history, user, reply] })
  simulate(reply.id, user, history)
}

/** Stand-in for CLI streaming: activity first, then markdown in small chunks. */
function simulate(id: string, user: UserMessage, history: Message[]) {
  const { activity, markdown } = mockReply(user, history)
  streamingId = id
  let i = 0
  const step = () => {
    if (i < activity.length) {
      const a = activity[i++]
      patch(id, (m) => ({ ...m, activity: [...m.activity, a] }))
      streamTimer = setTimeout(step, 350 + Math.random() * 300)
      return
    }
    const pos = i - activity.length
    if (pos >= markdown.length) {
      patch(id, (m) => ({ ...m, status: 'done', endedAt: now() }))
      streamingId = streamTimer = null
      return
    }
    const n = 6 + Math.floor(Math.random() * 18)
    const chunk = markdown.slice(pos, pos + n)
    i += chunk.length
    patch(id, (m) => ({ ...m, content: m.content + chunk }))
    streamTimer = setTimeout(step, 22 + Math.random() * 30)
  }
  streamTimer = setTimeout(step, 450)
}

export function stop() {
  if (streamTimer) clearTimeout(streamTimer)
  if (streamingId) patch(streamingId, (m) => ({ ...m, status: 'stopped', endedAt: now() }))
  streamTimer = null
  streamingId = null
}

export function newConversation() {
  stop()
  set({ messages: [] })
}

// ---- attachments -------------------------------------------------------------------

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

/** One-line plain-text preview of markdown (quotes, handoff chips). */
export const plainExcerpt = (md: string): string =>
  md
    .replace(/```[\s\S]*?(```|$)/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s*\|?[\s:-]+\|[\s|:-]*$/gm, ' ')
    .replace(/[#>*`|_~]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
