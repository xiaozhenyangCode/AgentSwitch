import { storedThread, type ChatChanges, type ChatIndex, type ChatState, type OpenChats, type StoredThread, type Thread } from '@shared/chat'
import { isPendingPermission, reconcilePermissions } from './permissionState'

const LS_KEY = 'agentswitch.threads.v2'

export async function openChats(
  storage: Pick<Storage, 'getItem' | 'removeItem'>,
  open: (legacy: string | null, aliasOnly?: boolean) => Promise<OpenChats>
): Promise<OpenChats> {
  const readLegacy = (key: string) => {
    try {
      return storage.getItem(key)
    } catch {
      return null
    }
  }
  const legacy = readLegacy(LS_KEY)
  const loaded = await open(legacy)
  if (legacy !== null && loaded.migrationComplete) {
    try {
      storage.removeItem(LS_KEY)
    } catch {
      // A later launch can retry removing the key after the verified migration.
    }
  } else if (legacy === null && !loaded.hasBackup) {
    const alias = readLegacy('agentmux.threads.v2')
    if (alias !== null) return open(alias, true)
  }
  return loaded
}

export function restoreChats(loaded: ChatState): { state: ChatState; viewedOnly: Thread[] } {
  const threads: Thread[] = []
  const viewedOnly: Thread[] = []
  for (const thread of loaded.threads) {
    if (thread.imported && !thread.messages.length && !thread.queuedMessages?.length) {
      viewedOnly.push(thread)
      continue
    }
    let changed = thread.pause !== null
    const messages = thread.messages.map((m) => {
      if (m.role !== 'assistant' || m.status === 'streaming' || !m.permissions?.some(isPendingPermission)) return m
      changed = true
      return { ...m, permissions: reconcilePermissions(m.permissions, [], false) }
    })
    const queueHold = thread.queueHold ?? (thread.queuedMessages?.length && (!thread.activeTurn || thread.pause) ? 'manual' : undefined)
    threads.push(changed || queueHold !== thread.queueHold ? { ...thread, ...(queueHold ? { queueHold } : {}), pause: null, messages } : thread)
  }
  const activeId = threads.some((t) => t.id === loaded.activeId) ? loaded.activeId : (threads[0]?.id ?? null)
  return { state: { threads, activeId }, viewedOnly }
}

function equalThread(a: StoredThread, b: StoredThread): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]) as Set<keyof StoredThread>
  for (const key of keys) if (a[key] !== b[key]) return false
  return true
}

function chatIndex(threads: Map<string, Thread>, activeId: string | null): ChatIndex {
  const order = [...threads.keys()]
  return { order, activeId: activeId !== null && threads.has(activeId) ? activeId : (order[0] ?? null) }
}

function persistedThreads(state: ChatState): Map<string, Thread> {
  return new Map(state.threads.filter((t) => !t.preview).map((t) => [t.id, t]))
}

export class ChatWrites {
  private readonly pending = new Map<string, StoredThread | null>()
  private index?: ChatIndex

  track(previous: ChatState, next: ChatState): void {
    const before = persistedThreads(previous)
    const after = persistedThreads(next)
    for (const id of before.keys()) {
      if (!after.has(id)) this.pending.set(id, null)
    }
    for (const [id, thread] of after) {
      const old = before.get(id)
      if (old === thread) continue
      const stored = storedThread(thread)
      if (!old || !equalThread(storedThread(old), stored)) this.pending.set(id, stored)
    }

    const from = chatIndex(before, previous.activeId)
    const to = chatIndex(after, next.activeId)
    if (from.activeId !== to.activeId || from.order.length !== to.order.length ||
        from.order.some((id, i) => id !== to.order[i])) this.index = to
  }

  get hasChanges(): boolean {
    return this.pending.size > 0 || this.index !== undefined
  }

  snapshot(): { changes: ChatChanges; acknowledge: () => void } | null {
    if (!this.hasChanges) return null
    const pending = new Map(this.pending)
    const index = this.index
    const changes: ChatChanges = { upserts: [], deletes: [], index }
    for (const [id, thread] of pending) {
      if (thread) changes.upserts.push(thread)
      else changes.deletes.push(id)
    }
    return {
      changes,
      acknowledge: () => {
        for (const [id, thread] of pending) {
          if (this.pending.get(id) === thread) this.pending.delete(id)
        }
        if (this.index === index) this.index = undefined
      }
    }
  }
}
