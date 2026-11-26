import type { TranscriptEntry } from './transcript'
import type { ReplyMarks } from './markers'

/** Dynamic account id, e.g. `claude-a1b2c3`. */
export type ProfileId = string
export type ProfileKind = 'claude' | 'gemini' | 'codex' | 'reasonix'

/** How an API-key account reaches its model. deepseek/custom are Claude Code only. */
export type ApiKeyProvider = 'official' | 'deepseek' | 'custom'
/** Non-secret half of an API-key connection; the key itself lives in the main-process secret store. */
export interface ApiKeyConfig {
  provider: ApiKeyProvider
  /** deepseek: preset; custom: required (Anthropic-compatible endpoint); official: unset */
  baseUrl?: string
  /** deepseek: preset; custom: required (first = default); official: unset (CLI's own list) */
  models?: string[]
}
export const REASONIX_MODELS = ['deepseek-flash', 'deepseek-v4-pro'] as const
export type ReasonixModel = (typeof REASONIX_MODELS)[number]
export type ReasonixConnect = { reasonix: 'import' } | { reasonix: 'managed'; key: string; defaultModel: ReasonixModel }
export type ProfileConnect = { apiKey: ApiKeyConfig; key: string } | ReasonixConnect

/** Where users create keys (opened from the add-account dialog). */
const DEEPSEEK_KEY_PAGE = 'https://platform.deepseek.com/api_keys'
export const API_KEY_PAGES: Record<ProfileKind | 'deepseek', string> = {
  claude: 'https://platform.claude.com/settings/keys',
  codex: 'https://platform.openai.com/api-keys',
  gemini: 'https://aistudio.google.com/apikey',
  deepseek: DEEPSEEK_KEY_PAGE,
  reasonix: DEEPSEEK_KEY_PAGE
}
export type ProfileStatus = 'uninstalled' | 'not_logged_in' | 'idle' | 'running' | 'rate_limited'

export const KINDS: ProfileKind[] = ['claude', 'gemini', 'codex', 'reasonix']

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
   * reasonix -> REASONIX_HOME
   */
  configDir: string
  /** Imported from an existing local setup (e.g. ~/.claude) rather than created by AgentSwitch. */
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
  /** Gemini chat transport. Existing accounts use print mode unless opted in. */
  agyTransport?: 'print' | 'acp'
  /** Set when the account connects with an API key instead of the CLI's sign-in; fixed at creation. */
  apiKey?: ApiKeyConfig
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
  defaultModel?: string
  /** catalog: CLI's own local cache file; command: live CLI query; cache: AgentSwitch cache; static: built-in list. */
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
  /** null -> AgentSwitch creates a private workspace for the thread. */
  projectDir: string | null
  text: string
  attachments: RunAttachment[]
  driver: RunAgentRef
  /** @-mentions in text order (may include the driver). */
  mentions: RunAgentRef[]
  /** Accounts allowed to take part (driver may dispatch to these). */
  participants: ProfileId[]
  /** History before the current user message, in display order. */
  transcript: TranscriptEntry[]
  sessionScope?: string
  /** 'handoff': the driver only writes a handoff document (saved to .agentswitch/handoffs/). */
  mode?: 'chat' | 'handoff'
  /** Handoff target account (mode 'handoff'). */
  handoffTo?: ProfileId
  /** Handoff document to inject for accounts that have no session in this thread yet. */
  handoffDoc?: string | null
  /** Imported history whose original folder is gone: run in the private workspace instead of failing. */
  allowMissingProject?: boolean
  /** First turn of a chat the user hasn't renamed: ask the driver for a title marker. */
  wantTitle?: boolean
  /** Optional quoted message snippet attached to this user turn. */
  quote?: { author: string; role: 'user' | 'assistant'; excerpt: string } | null
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
  source: 'claude-stream' | 'claude-oauth' | 'codex-rollout' | 'codex-rpc' | 'agy-usage'
  /** agy only; fiveHour/sevenDay above mirror the default (Gemini) group. */
  groups?: QuotaGroup[]
}

export interface UsageTotals {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  reasoning: number
  /**
   * API-price equivalent (USD) from the price table (built-in + the user's overrides). For a
   * model without a price: what the CLI reported, if anything.
   */
  costUsd: number
  /** AgentSwitch runs counted. */
  runs: number
  /** Tokens of models without a price (not in costUsd). */
  unpriced?: number
}

/** USD per million tokens. Missing cache rates fall back to the input rate. */
export interface PriceRate {
  input: number
  output: number
  cacheRead?: number
  /** Cache write (5-minute TTL). */
  cacheWrite?: number
  /** Cache write with 1-hour TTL (claude). */
  cacheWrite1h?: number
  /** Rates once a request's prompt exceeds `threshold` tokens. */
  long?: { threshold: number; input: number; output?: number; cacheRead?: number; cacheWrite?: number }
}

/** A model seen in the usage data and the price it is billed at. */
export interface ModelPrice {
  /** Price-table key it matched (null: no price). */
  key: string | null
  /**
   * custom: user's manual override · litellm: LiteLLM's public table (t3code's source) ·
   * ccswitch: CC Switch's built-in table · estimate: recorded without a model, priced as the
   * engine's most used model (`key`).
   */
  source: 'custom' | 'litellm' | 'ccswitch' | 'estimate' | null
  rate: PriceRate | null
  /** Official built-in/live rate when overridden by a custom price (for reference / reset preview). */
  defaultRate?: PriceRate | null
}

/** One account's usage of one model on one day (priced). */
export interface DailyUsage extends UsageTotals {
  day: string
  profileId: ProfileId
  /** As the CLI reported it ('?claude' …: recorded before models were). */
  model: string
}

export interface AccountUsage {
  today: UsageTotals
  week: UsageTotals
  total: UsageTotals
  quota: AccountQuota | null
  /** Last quota probe error message, if any (cleared on next successful fetch). */
  quotaError?: string | null
  /** Last time a run hit a rate limit (ms). */
  limitedAt: number | null
}

export interface UsageSnapshot {
  accounts: Record<ProfileId, AccountUsage>
  backfill: 'idle' | 'running' | 'done'
  /** Days covered by the Claude history backfill. */
  claudeDays: number
  /** Per day, account and model (for the period views). */
  daily: DailyUsage[]
  models: Record<string, ModelPrice>
  /** User's custom per-model price overrides (lowercased model key -> USD / 1M tokens). */
  customPrices: Record<string, PriceRate>
  /** Date of the LiteLLM table in use (YYYY-MM-DD); live: fetched (daily), otherwise the built-in snapshot. */
  pricesAt: string
  pricesLive: boolean
  updatedAt: number
}

export interface Usage {
  /** Uncached input tokens. */
  input?: number
  output?: number
  cacheRead?: number
  cacheWrite?: number
  /** Part of cacheWrite with a 1-hour TTL (claude; billed higher). */
  cacheWrite1h?: number
  /** Thinking / reasoning tokens (part of output). */
  reasoning?: number
  costUsd?: number
  costCny?: number
  /**
   * Tokens in the model's context on the turn's last request (prompt incl. cache). The other
   * fields add up every request of the turn (each tool round re-reads the context), so they
   * say nothing about how full the context is.
   */
  context?: number
  /** The model's context window as reported by the CLI (codex); otherwise derived from the model. */
  contextWindow?: number
}

export interface PermissionOption {
  id: string
  label: string
  role: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always' | 'answer'
  warning?: string
}

export interface PermissionEvent {
  t: 'permission'
  requestId: string
  kind: 'approval' | 'question'
  activityId?: string
  title: string
  detail?: string
  options: PermissionOption[]
  expiresAt: number
}

export interface PermissionResolution {
  outcome: 'selected' | 'cancelled' | 'timeout'
  optionId?: string
  label?: string
  by: 'user' | 'auto'
}

export interface StepRef {
  threadId: string
  turnId: string
  stepId: string
}

export type PendingPermissionEntry = StepRef & { event: PermissionEvent }

/** Normalised event from any CLI adapter. */
export type AgentEvent =
  | { t: 'session'; id: string; model: string | null }
  /** Native conversation title reported by the CLI (e.g. agy ACP session_info_update). */
  | { t: 'title'; title: string }
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
  | PermissionEvent
  | ({ t: 'permission_resolved'; requestId: string } & PermissionResolution)
  /** Non-fatal: e.g. tool calls auto-denied by the permission level. */
  | { t: 'notice'; message: string }
  | { t: 'error'; message: string }
  /**
   * The model is still generating a tool call's arguments (e.g. a whole file for Write): shown
   * live instead of a silent pause. `tool: null` ends the phase.
   */
  | { t: 'phase'; tool: string | null; bytes: number }

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

/** Fingerprint of a CLI session's files on disk: a change means someone else continued it. */
export interface HistoryStat {
  mtimeMs: number
  size: number
}

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
  | { kind: 'step-end'; threadId: string; turnId: string; stepId: string; status: StepStatus; marks?: ReplyMarks; verdict?: { status: 'PASS' | 'REJECT'; reason: string } }
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
  /** Canonical key (`${kind}:${realpath(sessionsDir)}`) for detecting accounts that share native CLI sessions. */
  sessionStoreKey: string
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
  /** Working directory of the last process started in it (none for log-only sessions). */
  cwd?: string | null
}

export interface StartPtyRequest {
  profileId: ProfileId
  mode: Exclude<PtyMode, 'install'>
  /** Overrides the profile's command for this mode (required for `test`). */
  command?: string
  /** Working directory (e.g. the chat's project folder); falls back to the real home. */
  cwd?: string | null
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
  themeGetSync: 'theme:getSync',
  themeSet: 'theme:set',
  themeChanged: 'theme:changed',
  i18nGetSync: 'i18n:getSync',
  i18nSet: 'i18n:set',
  i18nChanged: 'i18n:changed',
  menuCommand: 'menu:command',
  stateGet: 'state:get',
  stateChanged: 'state:changed',
  profilesAdd: 'profiles:add',
  reasonixCanImport: 'profiles:reasonixCanImport',
  profilesUpdate: 'profiles:update',
  profilesRemove: 'profiles:remove',
  profilesSetKey: 'profiles:setKey',
  profilesReset: 'profiles:reset',
  profilesEnvPreview: 'profiles:envPreview',
  kindsUpdate: 'kinds:update',
  kindsReset: 'kinds:reset',
  cliInstall: 'cli:install',
  cliVersion: 'cli:version',
  ptyStart: 'pty:start',
  ptyShell: 'pty:shell',
  ptyWrite: 'pty:write',
  ptyResize: 'pty:resize',
  ptyKill: 'pty:kill',
  ptyBuffer: 'pty:buffer',
  ptySessions: 'pty:sessions',
  ptyForget: 'pty:forget',
  filesSearch: 'files:search',
  gitChanges: 'git:changes',
  gitStatus: 'git:status',
  gitLog: 'git:log',
  gitGraph: 'git:graph',
  gitCommitDetail: 'git:commit-detail',
  gitStashes: 'git:stashes',
  gitStashDetail: 'git:stash-detail',
  gitConflictFile: 'git:conflict-file',
  gitTags: 'git:tags',
  gitRemotes: 'git:remotes',
  gitCommandLog: 'git:command-log',
  gitCommandLogClear: 'git:command-log-clear',
  gitMutate: 'git:mutate',
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
  showDataDir: 'shell:showDataDir',
  exportThreadsFile: 'threads:export-file',
  importThreadsFile: 'threads:import-file',
  commitThreadsImport: 'threads:commit-import',
  pathsExist: 'sys:paths-exist',
  extSkills: 'ext:skills',
  extMcp: 'ext:mcp',
  extOverview: 'ext:overview',
  extRead: 'ext:read',
  extReveal: 'ext:reveal',
  extPrepareRule: 'ext:prepare-rule',
  extWriteRule: 'ext:write-rule',
  extPinsGet: 'ext:pins-get',
  extPinsSet: 'ext:pins-set',
  onboardingGet: 'onboarding:get',
  onboardingSet: 'onboarding:set',
  modelsList: 'models:list',
  attachStage: 'attach:stage',
  attachRead: 'attach:read',
  chatStoreOpen: 'chat:storeOpen',
  chatStoreSave: 'chat:storeSave',
  chatStoreFlush: 'chat:storeFlush',
  chatSend: 'chat:send',
  chatStop: 'chat:stop',
  chatActive: 'chat:active',
  chatPermissionReply: 'chat:permissionReply',
  chatPendingPermissions: 'chat:pendingPermissions',
  chatResume: 'chat:resume',
  chatEvent: 'chat:event',
  chatExportHandoff: 'chat:exportHandoff',
  chatDeleteThread: 'chat:deleteThread',
  chatCheckpoints: 'chat:checkpoints',
  chatCheckpointAction: 'chat:checkpointAction',
  chatRewindPlan: 'chat:rewindPlan',
  chatRewind: 'chat:rewind',
  chatCompactSessions: 'chat:compact-sessions',
  historyList: 'history:list',
  usageGet: 'usage:get',
  usageRefresh: 'usage:refresh',
  usageSetPrice: 'usage:setPrice',
  usageChanged: 'usage:changed',
  historyOpen: 'history:open',
  historyImport: 'history:import',
  historyStat: 'history:stat',
  historyTrash: 'history:trash',
  appInfo: 'app:info'
} as const

export interface NodeRuntimeInfo {
  source: 'system' | 'bundled' | 'none'
  version: string | null
  path: string | null
}

export interface AppInfo {
  userData: string
  realHome: string
  shellEnvSource: 'login' | 'cache' | 'fallback'
  shellEnvError: string | null
  path: string
  electron: string
  node: string
  /** Node.js runtime resolved on PATH for CLIs and MCP servers (system or bundled fallback). */
  nodeRuntime: NodeRuntimeInfo
  chrome: string
  /** package.json version. */
  version: string
  arch: string
  /** macOS product version, e.g. 15.5. */
  osVersion: string
  /** Claude config dirs found in the home folder (`~/.claude`, `~/.claude2`, ...). */
  claudeDirs: string[]
}

/** Native menu items the renderer acts on. */
export type MenuCommand = 'about' | 'settings' | 'newThread' | 'search' | 'toggleSidebar'

/** Really delete a chat: AgentSwitch's data always; the CLI's own session files only with purgeCli. */
export interface DeleteThreadRequest {
  threadId: string
  projectDir: string | null
  turnIds: string[]
  /** Move the native CLI session files (~/.claude, ~/.codex, ~/.gemini) to the Trash. */
  purgeCli: boolean
}
export interface DeleteThreadResult {
  /** AgentSwitch files / folders removed. */
  removed: number
  /** Native CLI files moved to the Trash. */
  trashed: string[]
  failed: string[]
}

/** Appearance: follow macOS, or pin light / dark. */
export type ThemeMode = 'system' | 'light' | 'dark'
export interface ThemeState {
  mode: ThemeMode
  /** Effective appearance right now. */
  dark: boolean
}

// ---- skills / MCP (read-only discovery from local config files) -------------------------

/** Where a skill or MCP server comes from. `builtin`: shipped with the CLI itself. */
export type ExtSource = 'project' | 'global' | 'plugin' | 'builtin'

export interface SkillItem {
  /** As the CLI shows it, e.g. `review` or `figma:figma-use` (plugin skills in Claude). */
  name: string
  description: string
  source: ExtSource
  plugin?: string
  kind: 'skill' | 'command'
  /** Token put into the prompt: `/name` (claude, agy) or `$name` (codex). */
  insert: string
  /** SKILL.md / command file (previewable through ext:read). */
  path?: string
}

export interface SkillList {
  items: SkillItem[]
  /** Config files that existed but could not be parsed (skipped). */
  errors: number
}

export type McpTransport = 'stdio' | 'http' | 'sse'
/** on: loaded; off: disabled in config; pending: project server not approved yet (Claude). */
export type McpState = 'on' | 'off' | 'pending'

export interface McpServer {
  name: string
  source: ExtSource
  transport: McpTransport
  state: McpState
  plugin?: string
  /** Claude "local" scope: stored per project in .claude.json, private to this user. */
  local?: boolean
  /** Claude managed (system-wide) config. */
  managed?: boolean
  /** Redacted command + args for stdio transport. */
  command?: string
  /** Redacted endpoint URL for http/sse transport. */
  url?: string
  /** Working directory if configured. */
  cwd?: string
  /** Environment variable names (values omitted for safety). */
  envKeys?: string[]
  /** HTTP header names (values omitted for safety). */
  headerKeys?: string[]
  /** Source config file path (allow-listed for Finder reveal). */
  configPath?: string
}

export interface McpList {
  servers: McpServer[]
  /** The account's config folder that was read (~-relative). */
  configDir: string
  project: string | null
  errors: number
  /** Claude: claude.ai connectors may add servers that exist only remotely. */
  remoteNote: boolean
}

/** A custom subagent definition (Claude agents/*.md, Codex agent roles). */
export interface AgentItem {
  name: string
  description: string
  source: ExtSource
  plugin?: string
  model: string | null
  tools: string | null
  /** Definition file (previewable through ext:read). */
  path: string
}

export type RuleScope = 'managed' | 'global' | 'project' | 'plugin'

/** An instruction file the CLI loads for this account + project (CLAUDE.md, AGENTS.md, rules/*.md...). */
export interface RuleFile {
  /** Absolute path (previewable through ext:read). */
  path: string
  /** ~-relative path for display. */
  display: string
  scope: RuleScope
  plugin?: string
  bytes: number
  lines: number
  /** Pulled in by an `@path` line in this file (Claude). */
  importedBy?: string
  /** Past the CLI's size budget: only part of it is loaded (Codex project_doc_max_bytes). */
  truncated?: boolean
}

/** One lifecycle hook handler that is in effect. */
export interface HookItem {
  event: string
  matcher?: string
  source: ExtSource
  plugin?: string
  /** agy: the named hook it belongs to. */
  name?: string
  /** command, mcp_tool, prompt, http, notify... */
  type: string
  /** What it runs, redacted (no env values or tokens). */
  summary: string
  /** Config file it comes from (~-relative). */
  file: string
  /** Turned off (disableAllHooks, enabled: false). */
  off?: boolean
}

export interface PluginItem {
  name: string
  /** e.g. `figma@claude-plugins-official`, `browser@openai-bundled`. */
  key: string
  version: string | null
  description: string
  enabled: boolean
  source: ExtSource
  marketplace: string | null
  skills: string[]
  agents: string[]
  mcp: string[]
  /** `Event` (or `Event · matcher`) per handler. */
  hooks: string[]
  rules: string[]
  path: string
}

/** Everything the extensions panel shows, for one account + project. */
export interface ExtOverview {
  skills: SkillItem[]
  agents: AgentItem[]
  plugins: PluginItem[]
  mcp: McpServer[]
  rules: RuleFile[]
  hooks: HookItem[]
  configDir: string
  project: string | null
  errors: number
  remoteNote: boolean
  /** agy defines subagents at run time: there are no definition files to list. */
  agentsDynamic: boolean
}

export interface ExtFileText {
  text: string
  bytes: number
  truncated: boolean
}

export interface RuleTarget {
  path: string
  display: string
  exists: boolean
}

/** One changed file in the project (git working tree vs HEAD, untracked included). */
export interface FileChange {
  /** Relative to the project folder (forward slashes). */
  path: string
  abs: string
  /** M modified · A added · D deleted · U untracked · R renamed · C conflicted. */
  status: 'M' | 'A' | 'D' | 'U' | 'R' | 'C'
  conflicted?: boolean
  /** Repo-relative path for conflicts, including paths outside a project's subfolder. */
  conflictPath?: string
  added: number
  removed: number
  staged?: boolean
  unstaged?: boolean
  stagedChange?: FileChangePreview
  unstagedChange?: FileChangePreview
  /** Unified diff (may be cut short); empty for binary files. */
  diff: string
  binary?: boolean
  truncated?: boolean
}

export type FileChangePreview = Pick<FileChange, 'status' | 'added' | 'removed' | 'diff' | 'binary' | 'truncated'>

export interface FileSearchRequest {
  cwd: string
  query: string
  limit?: number
  refresh?: boolean
}

export interface FileSearchItem {
  name: string
  relPath: string
  dir: string
  indexes: number[]
}

export interface FileSearchResponse {
  items: FileSearchItem[]
  truncated: boolean
}

export interface FileChanges {
  /** The folder is inside a git work tree. */
  repo: boolean
  files: FileChange[]
  added: number
  removed: number
  /** More changed files than listed. */
  more?: number
}

export type GitResult<T extends object = object> = ({ ok: true } & T) | { ok: false; error: string; code?: GitErrorCode; conflictFiles?: string[] }

export type GitErrorCode = 'invalidBranch' | 'busy' | 'switchChanges' | 'diverged' | 'noUpstream' | 'auth' | 'pushRejected' | 'indexLocked'
  | 'branchNotMerged' | 'mergeConflict' | 'pullConflict' | 'operationInProgress' | 'unmerged' | 'localChanges'

export type GitPullStrategy = 'ff-only' | 'merge' | 'rebase'
export type GitMergeMode = 'default' | 'no-ff' | 'squash'
export type GitInProgressOp = 'merge' | 'rebase' | 'cherry-pick' | 'revert'
export type GitResetMode = 'soft' | 'mixed' | 'hard'
export type GitConflictChoice = 'current' | 'incoming' | 'both'

export interface GitConflictHunk {
  index: number
  startLine: number
  endLine: number
  currentLabel: string
  incomingLabel: string
  current: string
  base?: string
  incoming: string
}

export interface GitConflictFile {
  path: string
  abs: string
  binary: boolean
  truncated: boolean
  hunks: GitConflictHunk[]
  unresolvedCount: number
  /** Identifies the contents shown in the resolver so stale hunk indices cannot be applied. */
  version?: string
  missing?: boolean
  nonRegular?: boolean
  malformed?: boolean
}

export interface GitTag {
  name: string
  hash: string
  shortHash: string
  annotated: boolean
  message: string
  tagger: string
  timestamp: number
}

export interface GitRemote {
  name: string
  fetchUrl: string
  pushUrl: string
}

export interface GitCommandLogEntry {
  id: number
  timestamp: number
  repoPath: string
  args: string[]
  durationMs: number
  exitCode: number | null
  ok: boolean
  stdout: string
  stderr: string
}

export type GitMutationResult = GitResult<{ outcome?: GitMutationOutcome }>

export type GitMutationOutcome =
  | { kind: 'switch' | 'createBranch'; branch: string }
  | { kind: 'pull'; count: number | null }
  | { kind: 'push'; target: string; count: number | null; published: boolean; forced?: boolean }
  | { kind: 'commit'; sha: string; subject: string }
  | { kind: 'undoLastCommit'; message: string }
  | { kind: 'merge'; squashed: boolean }

export interface GitBranch {
  name: string
  remote: string | null
}

export interface GitHeadCommit {
  hash: string
  shortHash: string
  subject: string
  message: string
  hasParent: boolean
}

export type GitStatus = { repo: false } | {
  repo: true
  repoPath: string
  branch: string | null
  detached: string | null
  upstream: string | null
  ahead: number
  behind: number
  dirty: boolean
  staged: number
  unstaged: number
  untracked: number
  stashCount: number
  remotes: string[]
  headCommit: GitHeadCommit | null
  inProgress: GitInProgressOp | null
  conflicts: number
  atRoot: boolean
  branches: GitBranch[]
}

export interface GitCommit {
  /** Legacy alias for shortHash. */
  sha: string
  shortHash: string
  hash: string
  subject: string
  author: string
  /** Legacy alias for timestamp. */
  authoredAt: number
  /** Author time in milliseconds. */
  timestamp: number
}

export interface GitGraphRef {
  kind: 'head' | 'branch' | 'remote' | 'tag' | 'other'
  name: string
}

export interface GitGraphCommit extends GitCommit {
  parents: string[]
  refs: GitGraphRef[]
}

export interface GitGraphOptions {
  limit?: number
  skip?: number
  query?: string
  /** HEAD, an exact local/remote branch, or null for all public refs. */
  branch?: string | null
}

export interface GitGraphData {
  commits: GitGraphCommit[]
  /** The checked-out commit when it falls outside the first page's window. */
  headCommit?: GitGraphCommit
  hasMore: boolean
  nextSkip: number
  branches: GitBranch[]
  headHash: string | null
  branch: string | null
  dirty: boolean
  uncommittedCount: number
  staged: number
  unstaged: number
}

export type GitCommitFile = FileChangePreview & { path: string; oldPath?: string }

export interface GitCommitDetail extends GitCommit {
  parents: string[]
  body: string
  message: string
  email: string
  files: GitCommitFile[]
  added: number
  removed: number
  more?: number
}

export interface GitStashEntry {
  ref: string
  index: number
  hash: string
  shortHash: string
  timestamp: number
  message: string
  branch: string | null
}

export interface GitStashDetail {
  ref: string
  files: GitCommitFile[]
  added: number
  removed: number
  more?: number
}

export type GitMutation =
  | { kind: 'switch'; name: string; remote: string | null; autoStash?: boolean }
  | { kind: 'createBranch'; name: string; startPoint?: string }
  | { kind: 'renameBranch'; oldName: string; newName: string }
  | { kind: 'deleteBranch'; name: string; force?: boolean }
  | { kind: 'deleteRemoteBranch'; remote: string; branch: string }
  | { kind: 'setUpstream'; branch?: string; upstream: string | null }
  | { kind: 'merge'; branch: string; remote: string | null; mode: GitMergeMode }
  | { kind: 'fetch'; prune?: boolean }
  | { kind: 'pull'; strategy?: GitPullStrategy }
  | { kind: 'push'; forceWithLease?: boolean }
  | { kind: 'stageAll' | 'stageTracked' | 'stageUntracked' | 'unstageAll' | 'discardAll' | 'cleanAll' }
  | { kind: 'stage' | 'unstage'; path: string }
  | { kind: 'discard'; path: string; untracked: boolean }
  | { kind: 'ignore'; path: string; mode: 'file' | 'dir' | 'ext' }
  | { kind: 'commit' | 'stageAndCommit'; message: string; amend?: boolean }
  | { kind: 'undoLastCommit' }
  | { kind: 'stashPush'; message?: string; includeUntracked?: boolean; keepIndex?: boolean }
  | { kind: 'stashApply' | 'stashPop' | 'stashDrop'; ref: string; expectedHash?: string }
  | { kind: 'stashClear' }
  | { kind: 'stashBranch'; ref: string; name: string; expectedHash?: string }
  | { kind: 'checkoutCommit'; hash: string }
  | { kind: 'cherryPick'; hash: string }
  | { kind: 'revert'; hash: string; mainline?: number }
  | { kind: 'reset'; hash: string; mode: GitResetMode }
  | { kind: 'continueOperation' | 'skipOperation' | 'abortOperation'; expectedOperation?: GitInProgressOp }
  | { kind: 'resolveConflict'; path: string; repoRelative?: boolean; hunkIndex?: number; choice: GitConflictChoice; stageIfComplete?: boolean; expectedVersion?: string }
  | { kind: 'markResolved'; path: string; repoRelative?: boolean; expectedVersion?: string }
  | { kind: 'createTag'; name: string; target?: string; message?: string }
  | { kind: 'deleteTag'; name: string }
  | { kind: 'deleteRemoteTag'; remote: string; name: string }
  | { kind: 'pushTag'; remote: string; name?: string; all?: boolean }
  | { kind: 'addRemote'; name: string; url: string }
  | { kind: 'setRemoteUrl'; name: string; url: string; pushUrl?: string }
  | { kind: 'removeRemote'; name: string }

/** Read-only preview of an attached file (64 KB cap). */
export interface AttachmentText extends ExtFileText {
  /** Not text (NUL bytes in the head): open it with the system app instead. */
  binary: boolean
}

export interface OnboardingState {
  completed: boolean
  /** userData had no config yet when this run started (a brand-new install). */
  firstRun: boolean
}
