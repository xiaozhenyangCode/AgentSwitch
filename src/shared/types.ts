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
  /** Plain-text recap of the recent conversation, oldest first. */
  transcript: string
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
  /** Only from AgentSwitch's own runs (CLI-reported total_cost_usd). */
  costUsd: number
  /** AgentSwitch runs counted. */
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
  /**
   * Tokens in the model's context on the turn's last request (prompt incl. cache). The other
   * fields add up every request of the turn (each tool round re-reads the context), so they
   * say nothing about how full the context is.
   */
  context?: number
  /** The model's context window as reported by the CLI (codex); otherwise derived from the model. */
  contextWindow?: number
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
  profilesUpdate: 'profiles:update',
  profilesRemove: 'profiles:remove',
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
  gitChanges: 'git:changes',
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
  chatSend: 'chat:send',
  chatStop: 'chat:stop',
  chatActive: 'chat:active',
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
  historyStat: 'history:stat',
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
  /** M modified · A added · D deleted · U untracked · R renamed. */
  status: 'M' | 'A' | 'D' | 'U' | 'R'
  added: number
  removed: number
  /** Unified diff (may be cut short); empty for binary files. */
  diff: string
  binary?: boolean
  truncated?: boolean
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
