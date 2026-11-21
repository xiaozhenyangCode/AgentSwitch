/** Dynamic account id, e.g. `claude-a1b2c3`. */
export type ProfileId = string
export type ProfileKind = 'claude' | 'gemini' | 'codex'
export type ProfileStatus = 'uninstalled' | 'not_logged_in' | 'idle' | 'running' | 'rate_limited'

export const KINDS: ProfileKind[] = ['claude', 'gemini', 'codex']

/**
 * install: real HOME, login shell (`zsh -ilc`), so CLIs land in the global PATH.
 * login / run / test: isolated profile env, `zsh -fc <cmd>`.
 * shell: isolated profile env, interactive `zsh -i`.
 */
export type PtyMode = 'install' | 'login' | 'run' | 'test' | 'shell'

/** pty session key: one per account, plus one silent install session per CLI kind. */
export type SessionId = string
export const installSessionId = (k: ProfileKind): SessionId => `install:${k}`
export const kindOfInstallSession = (s: SessionId): ProfileKind | null => {
  const k = s.startsWith('install:') ? s.slice('install:'.length) : ''
  return (KINDS as string[]).includes(k) ? (k as ProfileKind) : null
}

/** Per-CLI settings (shared by all accounts of that kind). */
export interface KindConfig {
  kind: ProfileKind
  /** Executable name looked up in PATH to decide "installed". */
  binary: string
  installCommand: string
  /** Used by 「更新」 once installed; falls back to installCommand when empty. */
  updateCommand: string
  /** Sub-model presets offered in pickers (any other name can still be typed). */
  models: string[]
}

export interface KindState extends KindConfig {
  binaryPath: string | null
  installing: boolean
}

/** One account, persisted in userData/config.json. */
export interface ProfileConfig {
  id: ProfileId
  name: string
  kind: ProfileKind
  /**
   * Isolation directory. `~` allowed.
   * claude -> CLAUDE_CONFIG_DIR (omitted when it is the system default ~/.claude)
   * gemini -> HOME
   * codex  -> CODEX_HOME
   */
  configDir: string
  /** Imported from an existing local setup (e.g. ~/.claude) rather than created by AgentMux. */
  imported: boolean
  loginCommand: string
  runCommand: string
  /** Extra env vars injected into login/run/test/shell sessions. */
  extraEnv: Record<string, string>
  /** Default sub-model id passed as `--model <id>`; '' = CLI's own default. */
  defaultModel: string
  /**
   * Auto-approval for chat runs.
   * cli:   the CLI's own permissions, as in the terminal (claude: settings defaultMode, else auto;
   *        codex: config.toml sandbox/approval, else workspace-write; agy: its default mode)
   * edits: edits confined to the project (claude acceptEdits / codex workspace-write / agy accept-edits)
   * full:  bypass all permission prompts and sandboxing
   */
  autoApprove: AutoApprove
  createdAt: number
}

export type AutoApprove = 'cli' | 'edits' | 'full'

// ---- sub-models ------------------------------------------------------------------

export interface ModelOption {
  id: string
  label: string
  /** 'main' = recommended, 'more' = older / niche. */
  group: 'main' | 'more'
  /** Reasoning-effort levels the model accepts (low → high order); absent = no effort control. */
  efforts?: string[]
  /** Level used when the spec carries no effort (agy needs one to build the real id). */
  defaultEffort?: string
}

export interface ModelList {
  profileId: ProfileId
  models: ModelOption[]
  /** catalog: CLI's own local cache file; command: live CLI query; cache: AgentMux cache; static: built-in list. */
  source: 'catalog' | 'command' | 'cache' | 'static'
  fetchedAt: number
  /** Last refresh error, if the list came from a fallback. */
  error?: string
}

// ---- chat runs ---------------------------------------------------------------------

export interface RunAgentRef {
  profileId: ProfileId
  /** null -> account default -> CLI default. */
  model: string | null
}

export interface RunAttachment {
  name: string
  /** Absolute path on disk (dropped files, or staged copies of pasted images). */
  path: string
  isImage: boolean
}

export interface RunRequest {
  threadId: string
  turnId: string
  /** null -> AgentMux creates a private workspace for the thread. */
  projectDir: string | null
  text: string
  attachments: RunAttachment[]
  driver: RunAgentRef
  /** @-mentions in text order (may include the driver). */
  mentions: RunAgentRef[]
  /** Accounts allowed to take part (driver may dispatch to these). */
  participants: ProfileId[]
  /** Plain-text recap of the recent conversation, oldest first. */
  transcript: string
  /** 'handoff': the driver only writes a handoff document (saved to .agentmux/handoffs/). */
  mode?: 'chat' | 'handoff'
  /** Handoff target account (mode 'handoff'). */
  handoffTo?: ProfileId
  /** Handoff document to inject for accounts that have no session in this thread yet. */
  handoffDoc?: string | null
  /** Imported history whose original folder is gone: run in the private workspace instead of failing. */
  allowMissingProject?: boolean
}

export type ActivityType = 'read' | 'write' | 'run' | 'search' | 'tool'

/** Full process data for one tool call (all strings already size-capped by the main process). */
export interface ActivityDetail {
  /** Tool name as the CLI reported it (Bash, run_command, mcp server.tool …). */
  tool?: string
  /** Input summary (command line, query, JSON params). */
  input?: string
  /** stdout / tool result text. */
  output?: string
  stderr?: string
  exitCode?: number | null
  /** Unified diff for file changes. */
  diff?: string
}

// ---- usage & quota ---------------------------------------------------------------------------

export interface QuotaWindow {
  /** 0–100 */
  percent: number
  /** ms epoch; null if unknown */
  resetsAt: number | null
  minutes: number
}

export interface QuotaReport {
  fiveHour: QuotaWindow | null
  sevenDay: QuotaWindow | null
  /** The CLI says requests are currently rejected. */
  limited: boolean
  plan: string | null
}

/** agy: models are grouped; each group has its own 5h / weekly buckets. */
export interface QuotaGroup {
  /** Bucket id prefix: 'gemini' | '3p' | 'gemini-argon-wtu' … */
  key: string
  name: string
  /** Model display names in this group (from the group description). */
  models: string[]
  fiveHour: QuotaWindow | null
  sevenDay: QuotaWindow | null
}

export interface AccountQuota extends QuotaReport {
  /** When the data was produced (event time), ms. */
  fetchedAt: number
  source: 'claude-stream' | 'codex-rollout' | 'agy-usage'
  /** agy only; fiveHour/sevenDay above mirror the default (Gemini) group. */
  groups?: QuotaGroup[]
}

export interface UsageTotals {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  reasoning: number
  /** Only from AgentMux's own runs (CLI-reported total_cost_usd). */
  costUsd: number
  /** AgentMux runs counted. */
  runs: number
}

export interface AccountUsage {
  today: UsageTotals
  week: UsageTotals
  total: UsageTotals
  quota: AccountQuota | null
  /** Last time a run hit a rate limit (ms). */
  limitedAt: number | null
}

export interface UsageSnapshot {
  accounts: Record<ProfileId, AccountUsage>
  backfill: 'idle' | 'running' | 'done'
  /** Days covered by the Claude history backfill. */
  claudeDays: number
  updatedAt: number
}

export interface Usage {
  /** Uncached input tokens. */
  input?: number
  output?: number
  cacheRead?: number
  cacheWrite?: number
  /** Thinking / reasoning tokens (part of output). */
  reasoning?: number
  costUsd?: number
}

/** Normalised event from any CLI adapter. */
export type AgentEvent =
  | { t: 'session'; id: string; model: string | null }
  | { t: 'text'; delta: string }
  /** Thinking/reasoning text (may be '' when the provider hides it) and/or a running token estimate. */
  | { t: 'thinking'; delta: string; tokens?: number }
  /**
   * Tool call. Events with the same `id` update one entry (running → done/error, output
   * arriving later). Without an id each event is its own entry.
   */
  | { t: 'activity'; id?: string; type: ActivityType; target: string; status?: 'running' | 'done' | 'error'; detail?: ActivityDetail }
  | { t: 'usage'; usage: Usage }
  /** Account quota windows reported by the CLI (claude rate_limit_event). Consumed by the main process. */
  | { t: 'quota'; quota: QuotaReport }
  /** Structured CLI event no adapter rule handles yet: forwarded instead of dropped. */
  | { t: 'other_event'; kind: string; payload: string }
  | { t: 'output'; path: string }
  | { t: 'rate_limited' }
  /** Non-fatal: e.g. tool calls auto-denied by the permission level. */
  | { t: 'notice'; message: string }
  | { t: 'error'; message: string }

// ---- local CLI history ---------------------------------------------------------------

/** One past CLI session found on disk (read-only). */
export interface HistoryEntry {
  /** `${profileId}:${nativeId}` */
  key: string
  profileId: ProfileId
  kind: ProfileKind
  /** claude sessionId / codex thread id / agy conversation id (what --resume takes). */
  nativeId: string
  title: string
  /** Project folder the session ran in (null if unknown). */
  cwd: string | null
  createdAt: number
  updatedAt: number
}

export interface HistoryActivity {
  id?: string
  type: ActivityType
  target: string
  status?: 'running' | 'done' | 'error'
  detail?: ActivityDetail
}

export type HistoryMessage =
  | { role: 'user'; text: string; at: number }
  | { role: 'assistant'; text: string; thinking: string; activity: HistoryActivity[]; outputs: string[]; model: string | null; at: number; endAt: number }

export interface HistoryThread {
  entry: HistoryEntry
  messages: HistoryMessage[]
  /** Set when the session could only be partly read (shown as a notice, never an error). */
  notice: string | null
}

export type StepStatus = 'done' | 'error' | 'stopped'

export type ChatEvent =
  | { kind: 'turn-start'; threadId: string; turnId: string; cwd: string }
  | { kind: 'step-add'; threadId: string; turnId: string; stepId: string; profileId: ProfileId; name: string; profileKind: ProfileKind; model: string | null; dispatchedBy: { profileId: ProfileId; name: string; profileKind: ProfileKind } | null; retry: number; review: boolean; after: string | null }
  | { kind: 'step-start'; threadId: string; turnId: string; stepId: string }
  | { kind: 'agent'; threadId: string; turnId: string; stepId: string; event: AgentEvent }
  | { kind: 'step-end'; threadId: string; turnId: string; stepId: string; status: StepStatus; verdict?: { status: 'PASS' | 'REJECT'; reason: string } }
  | { kind: 'paused'; threadId: string; turnId: string; reason: string }
  /** Handoff document written (mode 'handoff', or exported from the transcript). */
  | { kind: 'handoff'; threadId: string; turnId: string; path: string; to: ProfileId; ok: boolean; error?: string }
  | { kind: 'turn-end'; threadId: string; turnId: string; status: 'done' | 'stopped' | 'error' }

export interface ProfileState extends ProfileConfig {
  status: ProfileStatus
  binaryPath: string | null
  loggedIn: boolean
  /** configDir with `~` expanded. */
  resolvedConfigDir: string
  /** Mode of the live pty session, if any. */
  sessionMode: PtyMode | null
  /** A silent install of this account's CLI kind is running. */
  installing: boolean
}

export interface Snapshot {
  kinds: KindState[]
  profiles: ProfileState[]
}

export interface SessionInfo {
  sessionId: SessionId
  /** Mode of the live process, or of the last one if it exited. */
  mode: PtyMode | null
  alive: boolean
  /** Human label: account name or "安装 Claude". */
  label: string
}

export interface StartPtyRequest {
  profileId: ProfileId
  mode: Exclude<PtyMode, 'install'>
  /** Overrides the profile's command for this mode (required for `test`). */
  command?: string
  cols: number
  rows: number
}

export interface PtyDataEvent {
  sessionId: SessionId
  data: string
  /** Total chars emitted in this session up to and including this chunk. */
  seq: number
}

/** Scrollback replay; `seq` matches PtyDataEvent.seq of the last chunk included. */
export interface PtyBuffer {
  data: string
  seq: number
}

export interface PtyExitEvent {
  sessionId: SessionId
  mode: PtyMode
  exitCode: number
  signal?: number
}

export interface PtyUrlEvent {
  sessionId: SessionId
  url: string
  /** Heuristic: looks like an OAuth/login URL. */
  isAuth: boolean
  at: number
}

export interface LoginSuccessEvent {
  profileId: ProfileId
}

export interface EnvPreview {
  /** Vars that differ from / are added to the base login env. */
  injected: Record<string, string>
  /** Vars removed from the inherited env. */
  removed: string[]
  shell: string
  args: string[]
  cwd: string
}

export const IPC = {
  stateGet: 'state:get',
  stateChanged: 'state:changed',
  profilesAdd: 'profiles:add',
  profilesUpdate: 'profiles:update',
  profilesRemove: 'profiles:remove',
  profilesReset: 'profiles:reset',
  profilesEnvPreview: 'profiles:envPreview',
  kindsUpdate: 'kinds:update',
  kindsReset: 'kinds:reset',
  cliInstall: 'cli:install',
  cliVersion: 'cli:version',
  ptyStart: 'pty:start',
  ptyWrite: 'pty:write',
  ptyResize: 'pty:resize',
  ptyKill: 'pty:kill',
  ptyBuffer: 'pty:buffer',
  ptySessions: 'pty:sessions',
  ptyData: 'pty:data',
  ptyExit: 'pty:exit',
  ptyUrl: 'pty:url',
  loginSuccess: 'login:success',
  clipboardWrite: 'clipboard:write',
  openExternal: 'shell:openExternal',
  openPath: 'shell:openPath',
  pickDirectory: 'dialog:pickDirectory',
  pickProject: 'dialog:pickProject',
  showInFolder: 'shell:showInFolder',
  modelsList: 'models:list',
  attachStage: 'attach:stage',
  chatSend: 'chat:send',
  chatStop: 'chat:stop',
  chatResume: 'chat:resume',
  chatEvent: 'chat:event',
  chatExportHandoff: 'chat:exportHandoff',
  chatDeleteThread: 'chat:deleteThread',
  historyList: 'history:list',
  usageGet: 'usage:get',
  usageRefresh: 'usage:refresh',
  usageChanged: 'usage:changed',
  historyOpen: 'history:open',
  historyImport: 'history:import',
  appInfo: 'app:info'
} as const

export interface AppInfo {
  userData: string
  realHome: string
  shellEnvSource: 'login' | 'cache' | 'fallback'
  shellEnvError: string | null
  path: string
  electron: string
  node: string
}

/** Really delete a chat: AgentMux's data always; the CLI's own session files only with purgeCli. */
export interface DeleteThreadRequest {
  threadId: string
  projectDir: string | null
  turnIds: string[]
  /** Move the native CLI session files (~/.claude, ~/.codex, ~/.gemini) to the Trash. */
  purgeCli: boolean
}
export interface DeleteThreadResult {
  /** AgentMux files / folders removed. */
  removed: number
  /** Native CLI files moved to the Trash. */
  trashed: string[]
  failed: string[]
}
