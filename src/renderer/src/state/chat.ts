import { useSyncExternalStore } from 'react'
import { KINDS } from '@shared/types'
import type { ChatEvent, HistoryEntry, HistoryMessage, HistoryStat, HistoryThread, PermissionEvent, PermissionResolution, ProfileId, ProfileKind, RunAttachment } from '@shared/types'
import { CHAT_CLOSE_EVENT, type ChatCloseDecision } from '@shared/chat'
import type { Activity, AgentRef, AssistantMessage, Attachment, ChatState, Message, Thinking, Thread, UserMessage } from '@shared/chat'
import { ChatWrites, openChats, restoreChats } from './chatPersistence'
import { t as tr } from './i18n'
import { readMarks, stripMarks } from '@shared/markers'
import type { TranscriptEntry } from '@shared/transcript'
import { addPermission, isPendingPermission, reconcilePermissions, resolvePermission } from './permissionState'

/**
 * Threads: one unified multi-model conversation each. Module-level store (survives page
 * switches), saved by the main process. Replies come from real CLI runs in the main process
 * (src/main/orchestrator.ts) as ChatEvents.
 */

export type { Activity, AgentRef, AssistantMessage, Attachment, Message, Thinking, Thread, UserMessage } from '@shared/chat'

const uid = () => Math.random().toString(36).slice(2, 10)
const now = () => Date.now()
const endThinking = (t: Thinking | null): Thinking | null => (t && !t.endedAt ? { ...t, endedAt: now() } : t)

type ChatStatus = 'loading' | 'loadFailed' | 'ready' | 'saveFailed'
let status: ChatStatus = 'loading'
let state: ChatState = { threads: [], activeId: null }
const listeners = new Set<() => void>()
const statusListeners = new Set<() => void>()
const writes = new ChatWrites()
let session = 0
let revision = 0
let saving = false
let pendingClose: ((decision: ChatCloseDecision) => void) | null = null
let persistTimer: ReturnType<typeof setTimeout> | null = null
let permissionEventsDuringRestore: Map<string, PermissionResolution | null> | null = new Map()
let eventsDuringLoad: ChatEvent[] | null = []

function setStatus(next: ChatStatus) {
  if (status === next) return
  status = next
  statusListeners.forEach((listener) => listener())
}

export function useChatStatus(): ChatStatus {
  return useSyncExternalStore(subscribeStatus, () => status)
}

function subscribeStatus(listener: () => void) {
  statusListeners.add(listener)
  return () => statusListeners.delete(listener)
}

function schedulePersist(delay = 400) {
  if (persistTimer || saving || !session || !writes.hasChanges) return
  persistTimer = setTimeout(persist, delay)
}

function clearPersistTimer() {
  if (persistTimer) clearTimeout(persistTimer)
  persistTimer = null
}

function persist() {
  clearPersistTimer()
  if (!session || saving) return
  const batch = writes.snapshot()
  if (!batch) return
  const attempt = ++revision
  saving = true
  void window.agentswitch.chat.save(session, attempt, batch.changes).catch(() => false).then((saved) => {
    saving = false
    if (attempt === revision) {
      if (saved) batch.acknowledge()
      setStatus(saved ? 'ready' : 'saveFailed')
    }
    schedulePersist(status === 'saveFailed' ? 1500 : 400)
  })
}

function flushPendingChats(): boolean {
  const batch = writes.snapshot()
  if (!session || !batch) return true
  clearPersistTimer()
  let saved = false
  try {
    saved = window.agentswitch.chat.flush(session, ++revision, batch.changes)
  } catch {
    // Keep the pending changes available if the synchronous IPC fails.
  }
  if (saved) {
    batch.acknowledge()
    setStatus('ready')
    return true
  }
  setStatus('saveFailed')
  schedulePersist(1500)
  return false
}

export function useUnsavedChatClose(): boolean {
  return useSyncExternalStore(subscribeStatus, () => pendingClose !== null)
}

export function resolveUnsavedChatClose(discard: boolean) {
  const resolve = pendingClose
  pendingClose = null
  statusListeners.forEach((listener) => listener())
  resolve?.(discard ? 'discarded' : 'cancelled')
}

window.addEventListener(CHAT_CLOSE_EVENT, (event) => {
  const { detail: resolve } = event as CustomEvent<(decision: ChatCloseDecision) => void>
  if (typeof resolve !== 'function' || flushPendingChats()) return
  event.preventDefault()
  pendingClose = resolve
  statusListeners.forEach((listener) => listener())
})

// Reloads do not pass through the window's close handler.
window.addEventListener('beforeunload', (event) => {
  if (flushPendingChats()) return
  event.preventDefault()
  event.returnValue = ''
})

function set(next: ChatState) {
  if (!session) return
  // A history preview only lives while it is on screen.
  if (next.threads.some((t) => t.preview && t.id !== next.activeId)) next = { ...next, threads: next.threads.filter((t) => !t.preview || t.id === next.activeId) }
  writes.track(state, next)
  state = next
  schedulePersist()
  listeners.forEach((l) => l())
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
const msgAt = (m: Message): number => (m.role === 'user' ? m.createdAt : (m.startedAt ?? 0))

/**
 * History (imported) + AgentSwitch messages, oldest first. Turns someone continued in the CLI
 * itself interleave with AgentSwitch's own turns by time; each list keeps its own order.
 */
export const threadMessages = (t: Thread | null): Message[] => {
  if (!t) return []
  const h = t.history ?? []
  if (!h.length) return t.messages
  if (!t.messages.length) return h
  const out: Message[] = []
  let i = 0
  let j = 0
  while (i < h.length || j < t.messages.length) {
    if (j >= t.messages.length || (i < h.length && msgAt(h[i]) <= msgAt(t.messages[j]))) {
      out.push(h[i++])
      continue
    }
    // one AgentSwitch turn at a time (its steps stay together)
    const turn = t.messages[j].turnId
    while (j < t.messages.length && t.messages[j].turnId === turn) out.push(t.messages[j++])
  }
  return out
}

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

export function newThread(init: Pick<Thread, 'projectDir' | 'participants' | 'driver'> & { handoff?: Thread['handoff'] }): string {
  const t: Thread = { id: uid(), title: tr('chat.newThread'), workdir: init.projectDir, messages: [], activeTurn: null, pause: null, createdAt: now(), updatedAt: now(), ...init }
  set({ threads: [t, ...state.threads], activeId: t.id })
  return t.id
}

export const selectThread = (id: string) => {
  const hasUnread = state.threads.some((t) => t.id === id && t.unread)
  set({
    ...state,
    activeId: id,
    ...(hasUnread ? { threads: state.threads.map((t) => (t.id === id ? { ...t, unread: null } : t)) } : {})
  })
  void syncExternal(id)
}

export type TurnFinishedInfo = { threadId: string; title: string; outcome: 'done' | 'error' | 'paused'; background: boolean }
const turnFinishedListeners = new Set<(info: TurnFinishedInfo) => void>()
export function onTurnFinished(fn: (info: TurnFinishedInfo) => void): () => void {
  turnFinishedListeners.add(fn)
  return () => void turnFinishedListeners.delete(fn)
}
const notifyTurnDone = (info: TurnFinishedInfo) => {
  for (const fn of turnFinishedListeners) fn(info)
}

export const clearUnread = (id: string) => {
  if (state.threads.some((t) => t.id === id && t.unread)) patchThread(id, (t) => ({ ...t, unread: null }))
}
export const togglePin = (id: string) => patchThread(id, (t) => ({ ...t, pinned: !t.pinned }))

/** The visible conversation as Markdown (hidden markers stripped, handoff notes skipped). */
export function chatMarkdown(t: Thread): string {
  const out = [`# ${t.title}`]
  for (const m of threadMessages(t)) {
    if (m.role === 'user') {
      if (m.kind === 'handoff') continue
      const files = m.attachments.map((a) => `- ${a.path ?? a.name}`)
      out.push('', `## ${tr('chat.mdYou')}`, '', m.text, ...(files.length ? ['', ...files] : []))
    } else {
      const body = stripMarks(m.content).trim()
      if (!body) continue
      out.push('', `## ${m.agent.name}${m.agent.model ? ` · ${m.agent.model}` : ''}`, '', body)
    }
  }
  return out.join('\n').trim() + '\n'
}
export const patchThreadState = (id: string, patch: Partial<Thread>) => patchThread(id, (t) => ({ ...t, ...patch }))
export const renameThread = (id: string, title: string) => title.trim() && patchThread(id, (t) => ({ ...t, title: title.trim(), titleLocked: true, titleTurn: null }))

/** Drops the composer's suggested next input for a thread. */
export const clearSuggestion = (id: string) => state.threads.find((t) => t.id === id)?.suggestedInput && patchThread(id, (t) => ({ ...t, suggestedInput: null }))
export const updateThread = (id: string, patch: Partial<Pick<Thread, 'projectDir' | 'participants' | 'driver'>>) =>
  patchThread(id, (t) => ({ ...t, ...patch, workdir: patch.projectDir !== undefined ? patch.projectDir : t.workdir }))

/**
 * Removes the chat and AgentSwitch's files for it (session map, run artefacts). With purgeCli the
 * CLI's own session files go to the Trash as well. Usage statistics are kept.
 */
// ---- composer drafts -------------------------------------------------------------------------

/** Draft key of the not-yet-created conversation (no thread selected). */
export const NEW_DRAFT = '__new__'
/** Unsent input per conversation (in memory only): switching chats never carries text over. */
const drafts = new Map<string, { text: string; atts: Attachment[] }>()
const deletedDrafts = new Set<string>()

export const composerDraft = (key: string) => drafts.get(key) ?? null
export function saveComposerDraft(key: string, text: string, atts: Attachment[]) {
  if (deletedDrafts.has(key)) return
  if (text || atts.length) drafts.set(key, { text, atts })
  else drafts.delete(key)
}
export const clearComposerDraft = (key: string) => void drafts.delete(key)

export async function deleteThread(id: string, purgeCli = false) {
  const t = state.threads.find((x) => x.id === id)
  if (!t) return null
  drafts.delete(id)
  deletedDrafts.add(id)
  if (t.activeTurn) await window.agentswitch.chat.stop(id)
  const threads = state.threads.filter((x) => x.id !== id)
  set({ threads, activeId: state.activeId === id ? (threads[0]?.id ?? null) : state.activeId })
  const turnIds = [...new Set(t.messages.map((m) => m.turnId).filter(Boolean))]
  return window.agentswitch.chat.deleteThread({ threadId: id, projectDir: t.workdir ?? t.projectDir, turnIds, purgeCli })
}

// ---- sending ---------------------------------------------------------------------------------

const TRANSCRIPT_MSGS = 10
const TRANSCRIPT_EACH = 800

function transcriptOf(t: Thread): TranscriptEntry[] {
  return threadMessages(t)
    .filter((m) => !(m.role === 'user' && m.kind === 'handoff'))
    .slice(-TRANSCRIPT_MSGS)
    .map((m): TranscriptEntry | null => {
      if (m.role === 'user') return { profileId: null, text: `用户：${m.text}${m.attachments.length ? `（附件 ${m.attachments.map((a) => a.name).join('、')}）` : ''}` }
      if (!m.content.trim()) return null
      const body = plainExcerpt(stripMarks(m.content))
      return { profileId: m.agent.profileId, text: `${m.agent.name}：${body.length > TRANSCRIPT_EACH ? body.slice(0, TRANSCRIPT_EACH) + '…' : body}` }
    })
    .filter((e): e is TranscriptEntry => !!e)
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

type SendInput = {
  text: string
  attachments: Attachment[]
  driver: AgentRef
  mentions: AgentRef[]
  participants: ProfileId[]
  projectDir: string | null
  handoffTo?: AgentRef
  /** When true, once the handoff document is ready, open a fresh thread carrying it. */
  newThreadOnHandoff?: boolean
}
const gating = new Set<string>()
const handoffToNewThread = new Set<string>()

/**
 * Sends a message. A chat bound to a CLI session first catches up with turns written elsewhere,
 * so the screen matches what --resume will see; when the session file is being written right
 * now, `confirmBusy` decides whether to go ahead. Resolves false only when the user declined
 * there (the composer gives the draft back); a duplicate submit is dropped and resolves true.
 */
export async function send(threadId: string, input: SendInput, confirmBusy?: () => Promise<boolean>): Promise<boolean> {
  const thread = state.threads.find((t) => t.id === threadId)
  if (!thread || thread.activeTurn || gating.has(threadId)) return true
  if (thread.imported) {
    gating.add(threadId)
    try {
      const r = await syncExternal(threadId)
      if (r.writing && confirmBusy && !(await confirmBusy())) return false
    } finally {
      gating.delete(threadId)
    }
  }
  sendNow(threadId, input)
  return true
}

function sendNow(threadId: string, input: SendInput): void {
  const thread = state.threads.find((t) => t.id === threadId)
  if (!thread || thread.activeTurn) return
  const turnId = uid() + uid()
  const mode = input.handoffTo ? 'handoff' : 'chat'
  if (input.handoffTo && input.newThreadOnHandoff) handoffToNewThread.add(threadId)
  else if (input.handoffTo) handoffToNewThread.delete(threadId)
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
    ...(doc ? { note: tr('chat.handoffSynced', { name: [input.driver, ...input.mentions].find((a) => a.profileId === doc.to)?.name ?? '' }) } : {})
  }
  const firstTurn = !threadMessages(thread).some((m) => m.role === 'user')
  const wantTitle = firstTurn && mode === 'chat' && !thread.titleLocked && !thread.imported
  const transcript = transcriptOf(thread)
  // first message in a history preview: it becomes a real chat continuing that CLI session
  const promote = thread.preview && thread.imported
  const ready = promote ? window.agentswitch.history.import(threadId, thread.imported!.profileId, thread.imported!.nativeId) : Promise.resolve()
  patchThread(threadId, (t) => ({
    ...t,
    ...(promote ? { preview: false, imported: { ...t.imported!, importedAt: now() } } : {}),
    title: firstTurn && !t.titleLocked ? titleFrom(input.text) : t.title,
    titleTurn: wantTitle ? turnId : null,
    suggestedInput: null,
    messages: [...t.messages, user],
    activeTurn: turnId,
    pause: null,
    unread: null,
    handoff: doc ? null : t.handoff,
    handoffFailed: mode === 'handoff' ? null : t.handoffFailed,
    ...(mode === 'chat' ? { handoffSkip: [] } : {}),
    updatedAt: now()
  }))
  const attachments: RunAttachment[] = input.attachments.filter((a) => a.path).map((a) => ({ name: a.name, path: a.path!, isImage: a.isImage }))
  ready
    .then(() =>
      window.agentswitch.chat.send({
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
        allowMissingProject: !!thread.imported,
        wantTitle
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
  void window.agentswitch.chat.stop(threadId)
}

export async function replyPermission(requestId: string, optionId: string | null): Promise<void> {
  if (await window.agentswitch.chat.permissionReply(requestId, optionId)) return
  for (const thread of state.threads) {
    const msg = thread.messages.find((m): m is AssistantMessage =>
      m.role === 'assistant' && !!m.permissions?.some((p) => p.requestId === requestId && isPendingPermission(p)))
    if (!msg) continue
    patchMsg(thread.id, msg.id, (m) => ({
      ...m,
      permissions: m.permissions?.map((p) => p.requestId === requestId ? { ...p, expired: true } : p)
    }))
    persist()
    break
  }
}

export function resolvePause(threadId: string, action: 'retry' | 'skip' | 'stop') {
  const t = state.threads.find((x) => x.id === threadId)
  if (!t?.pause) return
  const turnId = t.pause.turnId
  patchThread(threadId, (x) => ({ ...x, pause: null }))
  void window.agentswitch.chat.resume(threadId, turnId, action)
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
      if (ev.t === 'permission' && !permissionEventsDuringRestore?.has(ev.requestId)) permissionEventsDuringRestore?.set(ev.requestId, null)
      if (ev.t === 'permission_resolved') {
        const { t: _type, requestId, ...resolution } = ev
        permissionEventsDuringRestore?.set(requestId, resolution)
      }
      patchMsg(e.threadId, e.stepId, (m) => {
        switch (ev.t) {
          case 'permission':
            return { ...m, permissions: addPermission(m.permissions, ev), thinking: endThinking(m.thinking), phase: null }
          case 'permission_resolved': {
            const { t: _type, requestId, ...resolution } = ev
            return { ...m, permissions: resolvePermission(m.permissions, requestId, resolution) }
          }
          case 'text':
            return { ...m, content: m.content + ev.delta, thinking: endThinking(m.thinking), phase: null, tail: 'text' }
          case 'phase':
            return { ...m, phase: ev.tool ? { tool: ev.tool, bytes: ev.bytes, since: m.phase?.tool === ev.tool ? m.phase.since : now() } : null, thinking: endThinking(m.thinking), tail: 'tool' }
          case 'thinking': {
            const live = m.thinking && !m.thinking.endedAt
            // token count reported after the fact (agy totals, late claude estimates): update, don't reopen
            if (!ev.delta && ev.tokens !== undefined && !live) {
              const base = m.thinking ?? { text: '', tokens: null, startedAt: now(), endedAt: now(), timed: false }
              return { ...m, thinking: { ...base, tokens: ev.tokens } }
            }
            if (m.tail !== 'thinking') m = { ...m, tail: 'thinking' }
            const th: Thinking = live
              ? m.thinking!
              : { text: m.thinking?.text ? m.thinking.text + '\n\n' : '', tokens: m.thinking?.tokens ?? null, startedAt: m.thinking?.startedAt ?? now(), endedAt: null, timed: true }
            return { ...m, thinking: { ...th, text: th.text + ev.delta, tokens: ev.tokens ?? th.tokens, timed: true } }
          }
          case 'activity': {
            const a: Activity = { id: ev.id, type: ev.type, target: ev.target, status: ev.status, detail: ev.detail }
            const i = ev.id ? m.activity.findIndex((x) => x.id === ev.id) : -1
            const activity = i < 0 ? [...m.activity, { ...a, startedAt: now() }] : m.activity.map((x, j) => (j === i ? { ...x, ...a, detail: { ...x.detail, ...a.detail } } : x))
            return { ...m, activity, thinking: endThinking(m.thinking), phase: null, tail: 'tool' }
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
            return { ...m, error: m.error ?? tr('chat.rateLimited') }
          default:
            return m // e.g. quota: consumed by the main process
        }
      })
      // Reloads can happen before the normal streaming persistence interval has elapsed.
      if (ev.t === 'permission' || ev.t === 'permission_resolved') persist()
      return
    }
    case 'step-end': {
      // hidden title / next-step markers: strip them, then apply to the thread
      const raw = state.threads.find((t) => t.id === e.threadId)?.messages.find((m) => m.id === e.stepId)
      const marks = raw?.role === 'assistant' ? readMarks(raw.content) : { title: null, next: null }
      patchMsg(e.threadId, e.stepId, (m) => ({ ...m, content: stripMarks(m.content), phase: null, status: e.status, endedAt: now(), verdict: e.verdict ?? null, thinking: endThinking(m.thinking) }))
      if (marks.title || marks.next)
        patchThread(e.threadId, (t) => ({
          ...t,
          ...(marks.title && !t.titleLocked && t.titleTurn === e.turnId ? { title: marks.title, titleTurn: null } : {}),
          ...(marks.next ? { suggestedInput: marks.next } : {})
        }))
      return
    }
    case 'handoff': {
      const toNew = handoffToNewThread.delete(e.threadId)
      if (e.ok && toNew) {
        const src = state.threads.find((t) => t.id === e.threadId)
        if (src) {
          patchThread(e.threadId, (t) => ({ ...t, handoffFailed: null }))
          newThread({
            projectDir: src.projectDir,
            participants: src.participants,
            driver: { profileId: e.to, model: src.driver.profileId === e.to ? src.driver.model : null },
            handoff: { to: e.to, path: e.path, from: lastSpeaker(src)?.name ?? src.title }
          })
          return
        }
      }
      return patchThread(e.threadId, (t) =>
        e.ok ? { ...t, handoff: { to: e.to, path: e.path, from: lastSpeaker(t)?.name ?? '' }, handoffFailed: null } : { ...t, handoffFailed: { to: e.to, error: e.error ?? tr('chat.genFailed') } }
      )
    }
    case 'paused': {
      const th = state.threads.find((t) => t.id === e.threadId)
      const bg = state.activeId !== e.threadId
      const unfocused = typeof document !== 'undefined' && !document.hasFocus()
      patchThread(e.threadId, (t) => ({
        ...t,
        pause: { turnId: e.turnId, reason: e.reason },
        ...(bg || unfocused ? { unread: 'paused' as const } : {})
      }))
      if (th) notifyTurnDone({ threadId: e.threadId, title: th.title, outcome: 'paused', background: bg })
      return
    }
    case 'turn-end': {
      const prev = state.threads.find((t) => t.id === e.threadId)
      const turnSteps = prev ? prev.messages.filter((m): m is AssistantMessage => m.role === 'assistant' && m.turnId === e.turnId) : []
      const hadError = turnSteps.some((m) => m.status === 'error' || !!m.error)
      const hadDone = turnSteps.some((m) => m.status === 'done')
      const outcome: 'done' | 'error' | null = hadError ? 'error' : hadDone ? 'done' : null
      const bg = state.activeId !== e.threadId
      const unfocused = typeof document !== 'undefined' && !document.hasFocus()
      patchThread(e.threadId, (t) => ({
        ...t,
        activeTurn: t.activeTurn === e.turnId ? null : t.activeTurn,
        pause: t.pause?.turnId === e.turnId ? null : t.pause,
        updatedAt: now(),
        ...(outcome && (bg || unfocused) ? { unread: outcome } : {}),
        messages: t.messages.map((m) =>
          m.role === 'assistant' && m.turnId === e.turnId && (m.status === 'queued' || m.status === 'streaming') ? { ...m, status: 'stopped', endedAt: m.startedAt ? now() : null } : m
        )
      }))
      if (prev && outcome) notifyTurnDone({ threadId: e.threadId, title: prev.title, outcome, background: bg })
      return
    }
  }
}

window.agentswitch.chat.onEvent((event) => {
  if (eventsDuringLoad) eventsDuringLoad.push(event)
  else onEvent(event)
})

/**
 * A window reload (incl. dev hot reload) loses the event stream but not the runs in the main
 * process. Re-attach to the turns still running — the composer keeps its stop button and the
 * live reply keeps streaming — and settle only what really ended meanwhile.
 */
async function reattach() {
  const loaded = new Map(state.threads.filter((t) => t.activeTurn).map((t) => [t.id, t.activeTurn!]))
  const inflight = (m: Message) => m.role === 'assistant' && (m.status === 'streaming' || m.status === 'queued')
  const recoverTurns = loaded.size > 0 || state.threads.some((t) => t.messages.some(inflight))
  if (!recoverTurns && !state.threads.length) {
    permissionEventsDuringRestore = null
    return
  }
  const [live, pending] = await Promise.all([
    recoverTurns ? window.agentswitch.chat.active().catch(() => []) : Promise.resolve([]),
    window.agentswitch.chat.pendingPermissions().catch(() => [])
  ])
  const observed = permissionEventsDuringRestore ?? new Map()
  permissionEventsDuringRestore = null
  if (!recoverTurns && !pending.length && !observed.size) return
  const byThread = new Map(live.map((x) => [x.threadId, x]))
  const pendingByStep = new Map<string, PermissionEvent[]>()
  const stepKey = (threadId: string, turnId: string, stepId: string) => JSON.stringify([threadId, turnId, stepId])
  for (const { threadId, turnId, stepId, event } of pending) {
    const key = stepKey(threadId, turnId, stepId)
    const events = pendingByStep.get(key) ?? []
    events.push(event)
    pendingByStep.set(key, events)
  }
  set({
    ...state,
    threads: state.threads.map((t) => {
      const run = byThread.get(t.id)
      const turnId = run && (!t.activeTurn || t.activeTurn === run.turnId) ? run.turnId : null
      // a turn started after this window loaded is not ours to settle
      if (t.activeTurn && t.activeTurn !== loaded.get(t.id) && t.activeTurn !== turnId) return t
      if (!turnId && !t.activeTurn && !t.messages.some((m) => inflight(m) || (m.role === 'assistant' && m.permissions?.some(isPendingPermission)))) return t
      return {
        ...t,
        activeTurn: turnId,
        messages: t.messages.map((m) => {
          if (m.role !== 'assistant') return m
          const snapshot = pendingByStep.get(stepKey(t.id, m.turnId, m.id)) ?? []
          const running = turnId === m.turnId && inflight(m) && !!run?.running.includes(m.id)
          const permissions = reconcilePermissions(m.permissions, snapshot, running, observed)
          const message = permissions === m.permissions ? m : { ...m, permissions }
          if (running && m.status === 'queued' && permissions?.length) return { ...message, status: 'streaming' as const }
          if (!inflight(m) || running || (turnId === m.turnId && m.status === 'queued')) return message
          return { ...message, status: 'stopped' as const, endedAt: m.endedAt ?? (m.startedAt ? now() : null), thinking: endThinking(m.thinking) }
        })
      }
    })
  })
}

const titleFrom = (text: string) => {
  const t = text
    .replace(/(然后|最后|接着|并且|再)?(让|由|请)?\s*@\S+(\s*账号\s*\d+)?(\([^)]*\))?\s*/g, '')
    .replace(/^[，,、\s]+/, '')
    .replace(/\s+/g, ' ')
    .trim()
  return (t.length > 22 ? t.slice(0, 22) + '…' : t) || tr('chat.newThread')
}

// ---- helpers -----------------------------------------------------------------------------

/** One-line plain-text preview of markdown. */
export const plainExcerpt = (md: string): string =>
  md
    .replace(/```agentswitch:dispatch[\s\S]*?(```|$)/g, ' ')
    .replace(/```[\s\S]*?(```|$)/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s*\|?[\s:-]+\|[\s|:-]*$/gm, ' ')
    .replace(/[#>*`|_~]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

const IMAGE_RE = /\.(png|jpe?g|gif|webp|bmp|heic|svg)$/i

/** Edge of the stored square thumbnail: 2× the largest tile it fills (96px bubble), so Retina stays sharp. */
const THUMB = 240

/**
 * Thumbnail as a data: URL (CSP allows img-src data: but not blob:). Every place shows it as an
 * object-cover square, so it is the centre square crop at THUMB px: a wide screenshot keeps its
 * full resolution on the short side instead of being shrunk by its long side and blown up again.
 */
function thumbnail(file: File): Promise<string | null> {
  return new Promise((resolve) => {
    const reader = new FileReader()
    reader.onerror = () => resolve(null)
    reader.onload = () => {
      const img = new Image()
      img.onload = () => {
        const side = Math.min(img.width, img.height)
        if (!side) return resolve(null)
        const out = Math.max(1, Math.min(THUMB, side))
        const c = document.createElement('canvas')
        c.width = c.height = out
        const g = c.getContext('2d')!
        g.fillStyle = '#fff' // transparent PNGs: JPEG would otherwise turn them black
        g.fillRect(0, 0, out, out)
        g.imageSmoothingQuality = 'high'
        g.drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, out, out)
        resolve(c.toDataURL('image/jpeg', 0.9))
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
  let path = window.agentswitch.sys.pathForFile(file) || null
  // pasted images live only in memory: stage a real file so the CLIs can read it
  if (!path) path = await window.agentswitch.attach.stage(name, await file.arrayBuffer()).catch(() => null)
  return { id: uid(), name, path, size: file.size, isImage, thumb: isImage ? await thumbnail(file) : null }
}

// ---- handoff ---------------------------------------------------------------------------------

/** Fallback when the source account can't write one: the recent conversation, as a document. */
export async function exportHandoff(threadId: string, to: AgentRef, toNewThread = false): Promise<void> {
  const t = state.threads.find((x) => x.id === threadId)
  if (!t) return
  const lines: string[] = [`# 交接文档（AgentSwitch 从最近对话导出）`, '', `> 原模型暂不可用，以下是这个对话最近的记录，交给 ${to.name} 继续。`, '']
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
  const path = await window.agentswitch.chat.exportHandoff(threadId, uid() + uid(), t.projectDir, lines.join('\n'))
  if (toNewThread) {
    patchThread(threadId, (x) => ({ ...x, handoffFailed: null }))
    newThread({
      projectDir: t.projectDir,
      participants: t.participants,
      driver: { profileId: to.profileId, model: t.driver.profileId === to.profileId ? t.driver.model : null },
      handoff: { to: to.profileId, path, from: tr('chat.exportedFrom') }
    })
    return
  }
  patchThread(threadId, (x) => ({ ...x, handoff: { to: to.profileId, path, from: tr('chat.exportedFrom') }, handoffFailed: null }))
}

export const skipHandoff = (threadId: string, to: ProfileId) => patchThread(threadId, (t) => ({ ...t, handoffSkip: [...new Set([...(t.handoffSkip ?? []), to])], handoffFailed: null }))

export const dismissContextWarn = (threadId: string, turns: number) => patchThread(threadId, (t) => ({ ...t, contextWarnDismissedAt: turns }))

// ---- cross-machine thread export / import -----------------------------------------------------

export interface ExportedThread {
  thread: Thread
  /** Folder basename (e.g. "AgentMux"), null for threads without a project. */
  projectName: string | null
  /** Original projectDir on the exporting machine (informational only). */
  sourceProjectDir: string | null
  /** Driver CLI kind for automatic account mapping on another machine. */
  driverKind: ProfileKind | null
}

export interface ThreadBundle {
  format: 'agentswitch-threads'
  version: 1
  exportedAt: number
  threads: ExportedThread[]
}

const folderBase = (p: string | null | undefined): string | null => {
  if (!p) return null
  const name = p.replace(/\/+$/, '').split('/').filter(Boolean).pop()
  return name || null
}

/** Builds a portable JSON bundle for the selected thread IDs. */
export function buildThreadBundle(ids: Set<string>, profiles: { id: ProfileId; kind: ProfileKind }[]): ThreadBundle {
  const kindOf = new Map(profiles.map((p) => [p.id, p.kind]))
  const threads: ExportedThread[] = []
  for (const th of state.threads) {
    if (th.preview || !ids.has(th.id)) continue
    // Bake imported history messages into `messages` so nothing is lost on another machine.
    const merged = threadMessages(th)
    const driverKind: ProfileKind | null =
      (th.driver.profileId ? kindOf.get(th.driver.profileId) : undefined) ??
      th.imported?.kind ??
      [...merged].reverse().find((m) => m.role === 'assistant')?.agent.kind ??
      null
    const cleaned: Thread = {
      id: th.id,
      title: th.title,
      projectDir: th.projectDir,
      workdir: null,
      participants: th.participants,
      driver: th.driver,
      messages: merged,
      activeTurn: null,
      pause: null,
      createdAt: th.createdAt,
      updatedAt: th.updatedAt,
      ...(th.titleLocked ? { titleLocked: true } : {}),
      ...(th.suggestedInput ? { suggestedInput: th.suggestedInput } : {}),
      ...(th.pinned ? { pinned: true } : {})
    }
    threads.push({
      thread: cleaned,
      projectName: folderBase(th.projectDir),
      sourceProjectDir: th.projectDir,
      driverKind
    })
  }
  return { format: 'agentswitch-threads', version: 1, exportedAt: Date.now(), threads }
}

/** Parses and validates a thread bundle JSON string; throws on invalid format. */
export function parseThreadBundle(raw: string): ThreadBundle {
  const j = JSON.parse(raw) as Partial<ThreadBundle>
  if (!j || j.format !== 'agentswitch-threads' || j.version !== 1 || !Array.isArray(j.threads)) {
    throw new Error('invalid bundle')
  }
  const threads: ExportedThread[] = []
  for (const item of j.threads) {
    if (!item || typeof item !== 'object' || !item.thread || typeof item.thread.id !== 'string' || !Array.isArray(item.thread.messages)) continue
    threads.push({
      thread: item.thread,
      projectName: typeof item.projectName === 'string' && item.projectName ? item.projectName : folderBase(item.thread.projectDir),
      sourceProjectDir: typeof item.sourceProjectDir === 'string' ? item.sourceProjectDir : item.thread.projectDir ?? null,
      driverKind: item.driverKind && KINDS.includes(item.driverKind) ? item.driverKind : null
    })
  }
  return { format: 'agentswitch-threads', version: 1, exportedAt: Number(j.exportedAt) || Date.now(), threads }
}

/** Map of known local project directories keyed by folder basename (most recently updated wins). */
export function localProjectsByName(): Record<string, string> {
  const map: Record<string, string> = {}
  const sorted = [...state.threads].sort((a, b) => b.updatedAt - a.updatedAt)
  for (const th of sorted) {
    const name = folderBase(th.projectDir)
    if (name && th.projectDir && !(name in map)) map[name] = th.projectDir
  }
  return map
}

export type ImportConflictMode = 'replace' | 'duplicate'

/**
 * Applies selected imported threads into the local store:
 *  - Remaps projectDir via `projectMap[projectName]` (so different local pwds work seamlessly).
 *  - Remaps driver & participants to accounts available on this machine.
 *  - Respects `conflictMode` ('replace' updates matching id; 'duplicate' keeps both with a new id).
 */
export function applyThreadImport(
  items: ExportedThread[],
  projectMap: Record<string, string | null>,
  profiles: { id: ProfileId; kind: ProfileKind; status: string }[],
  conflictMode: ImportConflictMode
): { added: number; replaced: number } {
  const ready = profiles.filter((p) => p.status === 'logged_in' || p.status === 'rate_limited')
  const readyIds = ready.map((p) => p.id)
  const validIds = new Set(profiles.map((p) => p.id))
  const pickAccount = (origId: ProfileId | null, kind: ProfileKind | null): ProfileId | null => {
    if (origId && validIds.has(origId)) return origId
    if (kind) {
      const sameReady = ready.find((p) => p.kind === kind) ?? profiles.find((p) => p.kind === kind)
      if (sameReady) return sameReady.id
    }
    return ready[0]?.id ?? profiles[0]?.id ?? null
  }

  let threads = [...state.threads]
  const byIdMap = new Map(threads.map((t, i) => [t.id, i]))
  let added = 0
  let replaced = 0

  for (const item of items) {
    const src = item.thread
    const mappedDir = item.projectName ? (projectMap[item.projectName] ?? null) : null
    const mappedDriverId = pickAccount(src.driver?.profileId ?? null, item.driverKind)
    const mappedParticipants = readyIds.length ? readyIds : profiles.map((p) => p.id)
    const existingIdx = byIdMap.get(src.id)
    const makeCopy = existingIdx !== undefined && conflictMode === 'duplicate'
    const id = makeCopy ? `${src.id}-${uid().slice(0, 4)}` : src.id

    const nextThread: Thread = {
      ...src,
      id,
      projectDir: mappedDir,
      workdir: null,
      driver: { profileId: mappedDriverId, model: src.driver?.model ?? null },
      participants: mappedParticipants,
      activeTurn: null,
      pause: null,
      handoff: null,
      handoffFailed: null,
      unread: null,
      preview: false,
      imported: undefined
    }

    if (existingIdx !== undefined && !makeCopy) {
      threads[existingIdx] = nextThread
      replaced++
    } else {
      threads = [nextThread, ...threads]
      // rebuild index map for subsequent items
      byIdMap.clear()
      threads.forEach((t, i) => byIdMap.set(t.id, i))
      added++
    }
  }

  set({ ...state, threads })
  return { added, replaced }
}

// ---- imported CLI history ----------------------------------------------------------------------

function fromHistory(h: { messages: HistoryMessage[] }, agent: AgentRef): Message[] {
  const seen = new Map<string, number>()
  return h.messages.map((m: HistoryMessage, i): Message => {
    // keyed by time, not position: ids stay put when external turns are merged in
    const base = `h${m.role[0]}${m.at}`
    const n = seen.get(base) ?? 0
    seen.set(base, n + 1)
    const id = n ? `${base}-${n}` : base
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
  const stat = await window.agentswitch.history.stat(entry.key).catch(() => null)
  const h = await window.agentswitch.history.open(entry.key)
  const id = uid()
  syncBase.set(id, { stat, agent })
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
      notice: [h.notice, entry.cwd && !h.cwdExists ? tr('chat.cwdMissing', { dir: entry.cwd }) : null].filter(Boolean).join(' ') || null
    },
    history: fromHistory(h, agent),
    preview: true
  }
  set({ threads: [t, ...state.threads], activeId: id })
  return id
}

/**
 * Time windows of AgentSwitch's own runs on the imported session: the CLI records those turns in
 * the same file, but they are already in t.messages. Anything outside them came from elsewhere.
 */
function ownWindows(t: Thread): [number, number][] {
  const pid = t.imported?.profileId
  const asked = new Map<string, number>()
  for (const m of t.messages) if (m.role === 'user') asked.set(m.turnId, m.createdAt)
  const out: [number, number][] = []
  for (const m of t.messages) {
    if (m.role !== 'assistant' || m.agent.profileId !== pid || !m.startedAt) continue
    const from = Math.min(asked.get(m.turnId) ?? m.startedAt, m.startedAt) - 1500
    const to = m.endedAt ?? (t.activeTurn === m.turnId ? Infinity : m.startedAt + 10 * 60_000)
    out.push([from, to + 5000])
  }
  return out
}

/** CLI turns that are not AgentSwitch's own (from before the import, or continued elsewhere). */
const foreignTurns = (t: Thread, messages: HistoryMessage[]): HistoryMessage[] => {
  const wins = ownWindows(t)
  return wins.length ? messages.filter((m) => !wins.some(([a, b]) => m.at >= a && m.at <= b)) : messages
}

/** What the thread's history was last parsed from (not persisted: a restart re-reads anyway). */
const syncBase = new Map<string, { stat: HistoryStat | null; agent: AgentRef }>()

/** Re-reads an imported thread's history (after app restart): every CLI turn except AgentSwitch's own. */
export async function loadHistory(threadId: string, agent: AgentRef): Promise<void> {
  const t = state.threads.find((x) => x.id === threadId)
  if (!t?.imported || t.historyState === 'loading') return
  patchThread(threadId, (x) => ({ ...x, historyState: 'loading' }))
  try {
    const stat = await window.agentswitch.history.stat(t.imported.key).catch(() => null)
    const h = await window.agentswitch.history.open(t.imported.key)
    const cur = state.threads.find((x) => x.id === threadId) ?? t
    syncBase.set(threadId, { stat, agent })
    patchThread(threadId, (x) => ({ ...x, history: fromHistory({ messages: foreignTurns(cur, h.messages) }, agent), historyState: undefined }))
  } catch {
    patchThread(threadId, (x) => ({ ...x, history: [], historyState: 'error' }))
  }
}

// ---- external changes: the same CLI session continued in a terminal or another app -------------

export interface ExternalSync {
  threadId: string
  /** New messages merged into the thread. */
  added: number
  /** The session file was written moments ago by something other than AgentSwitch. */
  writing: boolean
}

/** Writes this recent (and not from our own run) suggest a reply is being generated elsewhere. */
const BUSY_MS = 2000
const syncing = new Map<string, Promise<ExternalSync>>()
const syncSubs = new Set<(e: ExternalSync) => void>()
/** Merged-in external turns (for the lightweight notice). */
export const onExternalSync = (cb: (e: ExternalSync) => void) => (syncSubs.add(cb), () => void syncSubs.delete(cb))

/**
 * Stats the session's files (cheap); when they changed since the last parse, re-reads them and
 * merges the new turns. AgentSwitch's own state (its turns, handoff cards, usage) is untouched.
 */
export function syncExternal(threadId: string): Promise<ExternalSync> {
  const running = syncing.get(threadId)
  if (running) return running
  const none: ExternalSync = { threadId, added: 0, writing: false }
  const p = (async (): Promise<ExternalSync> => {
    const t = state.threads.find((x) => x.id === threadId)
    const base = syncBase.get(threadId)
    // our own run is writing the file, or the history is not loaded yet (loadHistory reads it fresh)
    if (!t?.imported || t.activeTurn || !t.history || t.historyState || !base) return none
    const stat = await window.agentswitch.history.stat(t.imported.key).catch(() => null)
    if (!stat) return none
    const lastOwn = Math.max(0, ...t.messages.map((m) => (m.role === 'assistant' && m.agent.profileId === t.imported!.profileId ? (m.endedAt ?? 0) : 0)))
    const writing = Date.now() - stat.mtimeMs < BUSY_MS && stat.mtimeMs > lastOwn + 1500
    if (base.stat && base.stat.mtimeMs === stat.mtimeMs && base.stat.size === stat.size) return { ...none, writing }
    const h = await window.agentswitch.history.open(t.imported.key).catch(() => null)
    const cur = state.threads.find((x) => x.id === threadId)
    if (!h || !cur?.history || cur.activeTurn) return { ...none, writing }
    syncBase.set(threadId, { ...base, stat })
    const next = fromHistory({ messages: foreignTurns(cur, h.messages) }, base.agent)
    const prev = cur.history
    const same = next.length === prev.length && next.every((m, i) => m.id === prev[i].id && (m.role === 'user' ? m.text : m.content) === (prev[i].role === 'user' ? (prev[i] as UserMessage).text : (prev[i] as AssistantMessage).content))
    if (same) return { ...none, writing }
    const known = new Set(prev.map((m) => m.id))
    const added = next.filter((m) => !known.has(m.id)).length
    const lastAt = Math.max(0, ...next.map(msgAt))
    patchThread(threadId, (x) => ({ ...x, history: next, updatedAt: Math.max(x.updatedAt, lastAt) }))
    const e = { threadId, added, writing }
    if (added) for (const cb of syncSubs) cb(e)
    return e
  })().finally(() => syncing.delete(threadId))
  syncing.set(threadId, p)
  return p
}

// the window coming back to the front: someone may have continued the open chat elsewhere
window.addEventListener('focus', () => {
  if (state.activeId) void syncExternal(state.activeId)
})

async function initializeChats() {
  try {
    const api = window.agentswitch.chat
    const loaded = await openChats(localStorage, api.open)
    const { state: restored, viewedOnly } = restoreChats(loaded)

    state = { threads: loaded.threads, activeId: loaded.activeId }
    session = loaded.session
    set(restored)
    for (const thread of viewedOnly) {
      void api.deleteThread({ threadId: thread.id, projectDir: null, turnIds: [], purgeCli: false }).catch(() => {})
    }
    const queued = eventsDuringLoad ?? []
    eventsDuringLoad = null
    for (const event of queued) onEvent(event)
    setStatus('ready')
    void reattach()
  } catch {
    eventsDuringLoad = null
    setStatus('loadFailed')
  }
}

void initializeChats()
