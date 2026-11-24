import { createHash, randomUUID } from 'node:crypto'
import { lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { storedThread, type ChatChanges, type ChatIndex, type ChatState, type Message, type OpenChats, type QueuedMessage, type StoredThread } from '@shared/chat'

const INDEX = 'index.json'
const BACKUP = 'legacy-localstorage-backup.json'

function threadFile(id: string): string {
  // Use a distinct namespace for imported IDs that may collide on a case-insensitive filesystem.
  if (/^[a-z0-9_-]{1,160}$/.test(id) && !/^(index|legacy-localstorage-backup|con|prn|aux|nul|com[0-9]|lpt[0-9])$/.test(id)) {
    return id + '.json'
  }
  return '~' + createHash('sha256').update(JSON.stringify(id)).digest('hex') + '.json'
}

function atomicWrite(path: string, data: string): void {
  const tmp = path + '.' + randomUUID() + '.tmp'
  try {
    writeFileSync(tmp, data, { encoding: 'utf8', flag: 'wx', mode: 0o600, flush: true })
    renameSync(tmp, path)
  } catch (error) {
    try { rmSync(tmp, { force: true }) } catch { /* Preserve the original write error. */ }
    throw error
  }
}

function hasChatFields(value: unknown): value is Pick<StoredThread, 'id' | 'title' | 'messages'> {
  const t = value as Partial<StoredThread> | null
  return typeof t?.id === 'string' && typeof t.title === 'string' && Array.isArray(t.messages)
}

function isChatChanges(value: unknown): value is ChatChanges {
  const changes = value as Partial<ChatChanges> | null
  if (!Array.isArray(changes?.upserts) || !changes.upserts.every(hasChatFields) ||
      !Array.isArray(changes.deletes) || !changes.deletes.every((id) => typeof id === 'string')) return false
  const index = changes.index
  return index === undefined || (!!index && (index.activeId === null || typeof index.activeId === 'string') &&
    Array.isArray(index.order) && index.order.every((id) => typeof id === 'string'))
}

function parseMessage(message: Message | null): Message {
  if (message?.role === 'user' && typeof message.text === 'string' && message.driver) {
    return {
      ...message,
      attachments: Array.isArray(message.attachments) ? message.attachments : [],
      mentions: Array.isArray(message.mentions) ? message.mentions : []
    }
  }
  if (message?.role === 'assistant' && typeof message.content === 'string' && message.agent) {
    return {
      ...message,
      activity: Array.isArray(message.activity) ? message.activity : [],
      outputs: Array.isArray(message.outputs) ? message.outputs : [],
      permissions: Array.isArray(message.permissions) ? message.permissions.filter(Boolean) : undefined
    }
  }
  if (message?.role === 'system' && message.kind === 'compact' && typeof message.id === 'string') {
    return {
      role: 'system',
      id: message.id,
      turnId: typeof message.turnId === 'string' ? message.turnId : '',
      kind: 'compact',
      ...(Array.isArray(message.profileIds) ? { profileIds: message.profileIds.filter((id): id is string => typeof id === 'string') } : {}),
      createdAt: Number.isFinite(message.createdAt) ? message.createdAt : 0
    }
  }
  throw new Error('Invalid chat message')
}

function isQueuedMessage(message: QueuedMessage | null): message is QueuedMessage {
  return typeof message?.id === 'string' && typeof message.text === 'string' &&
    typeof message.driver?.profileId === 'string' && Array.isArray(message.mentions) &&
    message.mentions.every((mention) => typeof mention?.profileId === 'string') &&
    Array.isArray(message.participants) && (message.projectDir === null || typeof message.projectDir === 'string') &&
    Array.isArray(message.attachments) && message.attachments.every((attachment) => typeof attachment?.name === 'string')
}

export function parseThread(value: unknown): StoredThread {
  if (!hasChatFields(value)) throw new Error('Invalid chat')
  const t = value as StoredThread
  return storedThread({
    ...t,
    messages: t.messages.map(parseMessage),
    ...(t.queuedMessages === undefined ? {} : {
      queuedMessages: Array.isArray(t.queuedMessages) ? t.queuedMessages.filter(isQueuedMessage) : []
    }),
    ...(t.queueHold === undefined || t.queueHold === 'manual' || t.queueHold === 'external' ? {} : { queueHold: undefined }),
    projectDir: typeof t.projectDir === 'string' ? t.projectDir : null,
    workdir: typeof t.workdir === 'string' ? t.workdir : null,
    participants: Array.isArray(t.participants) ? t.participants : [],
    driver: t.driver ?? { profileId: null, model: null },
    activeTurn: t.activeTurn ?? null,
    pause: t.pause ?? null,
    createdAt: Number.isFinite(t.createdAt) ? t.createdAt : 0,
    updatedAt: Number.isFinite(t.updatedAt) ? t.updatedAt : 0
  })
}

function readThread(path: string, name: string): StoredThread {
  const thread = parseThread(JSON.parse(readFileSync(path, 'utf8')))
  if (threadFile(thread.id) !== name) throw new Error('Chat ID does not match its file')
  return thread
}

type DiskIndex = ChatIndex & { legacyDeleted?: string[] }
type ChatFault = { code?: string; name?: string }
const missing = (error: unknown) => (error as ChatFault | null)?.code === 'ENOENT'

function fileExists(path: string): boolean {
  try {
    if (!lstatSync(path).isFile()) throw new Error('Expected a regular file')
    return true
  } catch (error) {
    if (missing(error)) return false
    throw error
  }
}

function readIndex(path: string): DiskIndex | null {
  let raw
  try {
    raw = readFileSync(path, 'utf8')
  } catch (error) {
    if (missing(error)) return null
    throw error
  }
  try {
    const index = JSON.parse(raw) as DiskIndex | null
    if (index && (index.activeId === null || typeof index.activeId === 'string') &&
        Array.isArray(index.order) && index.order.every((id) => typeof id === 'string')) {
      const { legacyDeleted, ...selection } = index
      return {
        ...selection,
        ...(Array.isArray(legacyDeleted) && legacyDeleted.every((id) => typeof id === 'string') ? { legacyDeleted } : {})
      }
    }
  } catch {
    // Chat files can still restore the list if the index is damaged.
  }
  console.warn('[chatStore] ignoring a damaged chat index')
  return null
}

export class ChatStore {
  private readonly dir: string
  private session = 0
  private revision = 0
  private migrationPending = false
  private legacyDeleted = new Set<string>()

  constructor(userData: string) {
    this.dir = join(userData, 'chats')
  }

  load(): ChatState {
    return this.readChats().state
  }

  private readChats(): { state: ChatState; index: DiskIndex | null } {
    let files
    try {
      files = readdirSync(this.dir, { withFileTypes: true })
    } catch (error) {
      if (missing(error)) return { state: { threads: [], activeId: null }, index: null }
      throw error
    }
    const threads = new Map<string, StoredThread>()
    for (const entry of files) {
      const name = entry.name
      if (!entry.isFile() || !name.endsWith('.json') || name === INDEX || name === BACKUP) continue
      try {
        const thread = readThread(join(this.dir, name), name)
        if (!thread.preview) threads.set(thread.id, thread)
      } catch {
        console.warn('[chatStore] skipping unreadable chat file', name)
      }
    }

    let index: DiskIndex | null = null
    try {
      index = readIndex(join(this.dir, INDEX))
    } catch {
      console.warn('[chatStore] ignoring an unreadable chat index')
    }
    const ordered: StoredThread[] = []
    for (const id of index?.order ?? []) {
      const thread = threads.get(id)
      if (thread) ordered.push(thread)
      threads.delete(id)
    }
    // A crash can leave a newly written chat without an index entry.
    const unindexed = [...threads.values()].sort((a, b) => b.createdAt - a.createdAt)
    const all = [...unindexed, ...ordered]
    const activeId = index?.activeId
    const selected = activeId != null && all.some((t) => t.id === activeId) ? activeId : (all[0]?.id ?? null)
    return { state: { threads: all, activeId: selected }, index }
  }

  open(legacy: string | null, aliasOnly: boolean): OpenChats {
    const backup = join(this.dir, BACKUP)
    let hasBackup = false
    let migrationComplete = false
    try {
      hasBackup = fileExists(backup)
      if (legacy !== null && (!aliasOnly || !hasBackup)) {
        migrationComplete = this.migrate(legacy)
        hasBackup ||= migrationComplete
      }
    } catch (error) {
      console.warn('[chatStore] could not complete legacy migration', (error as ChatFault).code ?? (error as ChatFault).name)
    }

    const { state: loaded, index } = this.readChats()
    this.legacyDeleted = new Set(index?.legacyDeleted)
    this.migrationPending = legacy !== null && !migrationComplete && !(aliasOnly && hasBackup)
    this.revision = 0
    return { ...loaded, hasBackup, migrationComplete, session: ++this.session }
  }

  save(session: unknown, revision: unknown, changes: unknown): boolean {
    if (session !== this.session || !session || typeof revision !== 'number' ||
        !Number.isSafeInteger(revision) || revision <= 0 || !isChatChanges(changes)) return false
    // The final synchronous flush can arrive before an older queued IPC write.
    if (revision <= this.revision) return true
    this.revision = revision
    try {
      mkdirSync(this.dir, { recursive: true })
      for (const thread of changes.upserts) {
        if (thread.preview) continue
        atomicWrite(join(this.dir, threadFile(thread.id)), JSON.stringify(storedThread(thread)))
      }
      const indexPath = join(this.dir, INDEX)
      if (this.migrationPending && changes.deletes.some((id) => !this.legacyDeleted.has(id))) {
        // Remember deletions before unlinking so a later migration attempt cannot restore them.
        const index = readIndex(indexPath) ?? { activeId: null, order: [] }
        const deleted = new Set([...this.legacyDeleted, ...changes.deletes])
        atomicWrite(indexPath, JSON.stringify({ ...index, legacyDeleted: [...deleted] }))
        this.legacyDeleted = deleted
      }
      for (const id of changes.deletes) rmSync(join(this.dir, threadFile(id)), { force: true })
      if (changes.index) {
        const index: DiskIndex = { ...changes.index }
        if (this.legacyDeleted.size) index.legacyDeleted = [...this.legacyDeleted]
        atomicWrite(indexPath, JSON.stringify(index))
      }
      return true
    } catch (error) {
      console.error('[chatStore] chat save failed', (error as ChatFault).code ?? (error as ChatFault).name)
      return false
    }
  }

  private migrate(raw: string): boolean {
    const legacy = JSON.parse(raw) as Partial<ChatState> | null
    if (!Array.isArray(legacy?.threads)) throw new Error('Invalid legacy chats')
    const indexPath = join(this.dir, INDEX)
    const priorIndex = readIndex(indexPath)
    const prior = this.load()
    const deleted = new Set(priorIndex?.legacyDeleted)
    mkdirSync(this.dir, { recursive: true })

    let complete = true
    const legacyIds: string[] = []
    for (const [position, value] of legacy.threads.entries()) {
      try {
        if (hasChatFields(value) && deleted.has(value.id)) continue
        const thread = parseThread(value)
        if (thread.preview) continue
        const name = threadFile(thread.id)
        const path = join(this.dir, name)
        if (fileExists(path)) {
          readThread(path, name)
        } else {
          const data = JSON.stringify(thread)
          atomicWrite(path, data)
          if (readFileSync(path, 'utf8') !== data) throw new Error('Chat read-back failed')
        }
        legacyIds.push(thread.id)
      } catch (error) {
        complete = false
        console.warn('[chatStore] skipping legacy chat', position + 1, (error as ChatFault).code ?? (error as ChatFault).name)
      }
    }

    const priorIds = prior.threads.map((t) => t.id)
    const available = new Set([...legacyIds, ...priorIds])
    const order = [...new Set([...(priorIndex?.order ?? []).filter((id) => available.has(id)), ...legacyIds, ...priorIds])]
    const activeId = [priorIndex?.activeId, legacy.activeId].find((id) => typeof id === 'string' && available.has(id))
    const index: DiskIndex = { activeId: activeId ?? order[0] ?? null, order }
    if (deleted.size) index.legacyDeleted = [...deleted]
    const data = JSON.stringify(index)
    if (JSON.stringify(priorIndex) !== data && (order.length || complete)) {
      atomicWrite(indexPath, data)
      if (readFileSync(indexPath, 'utf8') !== data) throw new Error('Chat index read-back failed')
    }

    if (!complete) return false
    const backup = join(this.dir, BACKUP)
    if (!fileExists(backup)) atomicWrite(backup, raw)
    return true
  }
}
