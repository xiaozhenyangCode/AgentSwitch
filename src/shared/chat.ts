import type { ActivityDetail, ActivityType, PermissionEvent, PermissionResolution, ProfileId, ProfileKind, Usage } from './types'

export const CHAT_CLOSE_EVENT = 'agentswitch:close-chats'
export type ChatCloseDecision = 'saved' | 'cancelled' | 'discarded'

export type PendingPermission = PermissionEvent & { resolved?: PermissionResolution; expired?: true }

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
  /** When it started running (live progress line). */
  startedAt?: number
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
  /** Live only: tool-call arguments still being generated (e.g. a whole file for Write). */
  phase?: { tool: string; bytes: number; since: number } | null
  /** Live only: what the latest event was (drives the progress line at the bottom). */
  tail?: 'text' | 'tool' | 'thinking'
  /** Markdown. */
  content: string
  activity: Activity[]
  permissions?: PendingPermission[]
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
  /** Folder runs actually use (projectDir, or AgentSwitch's private workspace). */
  workdir: string | null
  /** Accounts allowed to take part in this thread. */
  participants: ProfileId[]
  driver: { profileId: ProfileId | null; model: string | null }
  messages: Message[]
  /** Keeps a portable import separate from any native sessions previously bound to this ID. */
  sessionScope?: string
  /** History copied when starting a fresh native session in a new chat. */
  carriedMessageCount?: number
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
  /** Renamed by the user: the model's title marker no longer replaces it. */
  titleLocked?: boolean
  /** Turn whose title marker may replace the placeholder title (the first one). */
  titleTurn?: string | null
  /** Next input the model suggested at the end of its last reply (ghost text in the composer). */
  suggestedInput?: string | null
  /** User turn count when the user dismissed the long-context warning. */
  contextWarnDismissedAt?: number
  /** Unread completion badge for turns that finished in the background (or while unfocused). */
  unread?: 'done' | 'error' | 'paused' | null
  /** Kept at the top of its project group in the sidebar. */
  pinned?: boolean
}

export interface ChatState {
  threads: Thread[]
  activeId: string | null
}

export type StoredThread = Omit<Thread, 'history' | 'historyState'>

export interface ChatIndex {
  activeId: string | null
  order: string[]
}

export interface ChatChanges {
  upserts: StoredThread[]
  deletes: string[]
  index?: ChatIndex
}

export interface OpenChats extends ChatState {
  session: number
  hasBackup: boolean
  migrationComplete: boolean
}

export function storedThread({ history: _history, historyState: _historyState, ...thread }: Thread): StoredThread {
  return thread
}
