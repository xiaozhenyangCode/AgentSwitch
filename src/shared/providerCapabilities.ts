import type { AutoApprove, ProfileKind } from './types'

export type SkillTriggerPrefix = '/' | '$' | null
export type ProviderAuthMode = 'oauth-or-apikey' | 'apikey-only'
export type SystemPromptMode = 'flag' | 'inline' | 'acp-flag-else-inline'
export type ModelListMode = 'direct-local' | 'live-with-fallback' | 'cached-ttl' | 'explicit-refresh'
export type PermissionPromptStyle = 'standard' | 'workspace-sandbox' | 'reasonix'

/**
 * Single Source of Truth for real, verified provider capabilities.
 *
 * Guidelines:
 * - Only declare capabilities the CLI genuinely supports; never fabricate unsupported modes.
 * - Orchestration and UI layers must branch on these capabilities rather than `kind === '...'`.
 * - Low-level adapter details (CLI flags, stdout/stderr parsers, local log paths) stay inside
 *   their respective adapter modules.
 */
export interface ProviderCapabilities {
  // ---- Session & rewind ----
  /** Supports resuming a previous native CLI session (`--resume` / `codex exec resume` / `--conversation`). */
  supportsResume: boolean
  /** Supports natively forking an existing CLI session into a new branch. */
  supportsFork: boolean
  /** Supports natively rewinding a CLI session's internal turn history (`false` => unbind CLI sessions on rewind). */
  supportsNativeRewind: boolean
  /** Supports mid-turn steering on a live persistent session (reserved for P2-1). */
  supportsSteer: boolean
  /** AgentSwitch reads, imports, and deletes local CLI session history files for this provider. */
  supportsLocalHistory: boolean

  // ---- Input, skills & permissions ----
  /** Accepts image inputs (CLI image flag, ACP content block, or prompt file path). */
  supportsImageInput: boolean
  /** Prompt token prefix that invokes a skill (`'/'`, `'$'`, or `null` when skills are unsupported). */
  skillTriggerPrefix: SkillTriggerPrefix
  /** Supports extensions discovery (skills, rules, MCP, agents, hooks) and editable rule files. */
  supportsExtensions: boolean
  /** Real permission modes supported by the CLI (ordered for UI presentation). */
  permissionModes: readonly AutoApprove[]
  /** Default permission mode for newly created accounts. */
  defaultPermissionMode: AutoApprove
  /** Permission wording style communicated to the model in system instructions. */
  permissionPromptStyle: PermissionPromptStyle
  /** Supports switching to an interactive persistent transport (e.g. ACP). */
  supportsInteractiveTransport: boolean

  // ---- Context, MCP & usage ----
  /** Fallback context window (tokens) when the CLI does not report one. */
  defaultContextWindow: number
  /** Supports temporary read-only MCP injection via CLI flags (used by P0-3 thread history reader). */
  supportsMcpTempInjection: boolean
  /** Supports subscription 5h / 7d usage quota reporting (API-key accounts never use subscription quota). */
  supportsUsageQuota: boolean
  /** Safe to fetch/refresh model catalog passively without spawning a heavy language server. */
  supportsPassiveModelList: boolean
  /** Model list caching & refresh policy. */
  modelListMode: ModelListMode

  // ---- Auth, prompt delivery & UI semantics ----
  /** Account login / credential model. */
  authMode: ProviderAuthMode
  /** Allows third-party / custom API-key endpoints (e.g. DeepSeek / Anthropic-compatible). */
  supportsThirdPartyApiKey: boolean
  /** How system instructions are delivered (`flag` vs `inline` compaction across resumed turns). */
  systemPromptMode: SystemPromptMode
  /** Supports `:disabled` as a valid reasoning effort value. */
  supportsDisabledEffort: boolean
  /** Exposes an explicit account-level default model name in its catalog even when `defaultModel` is blank. */
  hasExplicitDefaultModel: boolean
  /** Reports cache-hit ratio and fine-grained CNY / 6-decimal cost precision in message usage lines. */
  showsFineGrainedCost: boolean
  /** Uses "agent" wording instead of "subagent" when inserting an agent phrase. */
  usesStandaloneAgentTerm: boolean
  /** Whether the upstream CLI is marked unmaintained and only shows updates when a custom update command is set. */
  isUnmaintained: boolean
}

const STANDARD_PERMISSION_MODES: readonly AutoApprove[] = ['cli', 'edits', 'full']

/**
 * Compile-time exhaustive capability table keyed by `ProfileKind`.
 * Adding a new `ProfileKind` forces declaring every capability field here.
 */
export const PROVIDER_CAPABILITIES: Readonly<Record<ProfileKind, ProviderCapabilities>> = {
  claude: {
    supportsResume: true,
    supportsFork: false,
    supportsNativeRewind: false,
    supportsSteer: false,
    supportsLocalHistory: true,
    supportsImageInput: true,
    skillTriggerPrefix: '/',
    supportsExtensions: true,
    permissionModes: STANDARD_PERMISSION_MODES,
    defaultPermissionMode: 'cli',
    permissionPromptStyle: 'standard',
    supportsInteractiveTransport: false,
    defaultContextWindow: 200_000,
    supportsMcpTempInjection: true,
    supportsUsageQuota: true,
    supportsPassiveModelList: true,
    modelListMode: 'live-with-fallback',
    authMode: 'oauth-or-apikey',
    supportsThirdPartyApiKey: true,
    systemPromptMode: 'flag',
    supportsDisabledEffort: false,
    hasExplicitDefaultModel: false,
    showsFineGrainedCost: false,
    usesStandaloneAgentTerm: false,
    isUnmaintained: false
  },
  codex: {
    supportsResume: true,
    supportsFork: false,
    supportsNativeRewind: false,
    supportsSteer: false,
    supportsLocalHistory: true,
    supportsImageInput: true,
    skillTriggerPrefix: '$',
    supportsExtensions: true,
    permissionModes: STANDARD_PERMISSION_MODES,
    defaultPermissionMode: 'cli',
    permissionPromptStyle: 'workspace-sandbox',
    supportsInteractiveTransport: false,
    defaultContextWindow: 272_000,
    supportsMcpTempInjection: true,
    supportsUsageQuota: true,
    supportsPassiveModelList: true,
    modelListMode: 'cached-ttl',
    authMode: 'oauth-or-apikey',
    supportsThirdPartyApiKey: false,
    systemPromptMode: 'inline',
    supportsDisabledEffort: false,
    hasExplicitDefaultModel: false,
    showsFineGrainedCost: false,
    usesStandaloneAgentTerm: true,
    isUnmaintained: false
  },
  gemini: {
    supportsResume: true,
    supportsFork: false,
    supportsNativeRewind: false,
    supportsSteer: false,
    supportsLocalHistory: true,
    supportsImageInput: true,
    skillTriggerPrefix: '/',
    supportsExtensions: true,
    permissionModes: STANDARD_PERMISSION_MODES,
    defaultPermissionMode: 'cli',
    permissionPromptStyle: 'standard',
    supportsInteractiveTransport: true,
    defaultContextWindow: 1_000_000,
    supportsMcpTempInjection: false,
    supportsUsageQuota: true,
    supportsPassiveModelList: false,
    modelListMode: 'explicit-refresh',
    authMode: 'oauth-or-apikey',
    supportsThirdPartyApiKey: false,
    systemPromptMode: 'acp-flag-else-inline',
    supportsDisabledEffort: false,
    hasExplicitDefaultModel: false,
    showsFineGrainedCost: false,
    usesStandaloneAgentTerm: false,
    isUnmaintained: false
  },
  reasonix: {
    supportsResume: true,
    supportsFork: false,
    supportsNativeRewind: false,
    supportsSteer: false,
    supportsLocalHistory: false,
    supportsImageInput: true,
    skillTriggerPrefix: null,
    supportsExtensions: false,
    permissionModes: STANDARD_PERMISSION_MODES,
    defaultPermissionMode: 'cli',
    permissionPromptStyle: 'reasonix',
    supportsInteractiveTransport: false,
    defaultContextWindow: 1_000_000,
    supportsMcpTempInjection: false,
    supportsUsageQuota: false,
    supportsPassiveModelList: true,
    modelListMode: 'direct-local',
    authMode: 'apikey-only',
    supportsThirdPartyApiKey: false,
    systemPromptMode: 'inline',
    supportsDisabledEffort: true,
    hasExplicitDefaultModel: true,
    showsFineGrainedCost: true,
    usesStandaloneAgentTerm: false,
    isUnmaintained: true
  }
}

export function getProviderCapabilities(kind: ProfileKind): ProviderCapabilities {
  return PROVIDER_CAPABILITIES[kind]
}

/** Fallback context window (tokens) when a turn did not report one; recognizes 1M model variants. */
export function defaultContextWindowFor(kind: ProfileKind, model?: string | null): number {
  const base = PROVIDER_CAPABILITIES[kind].defaultContextWindow
  if (base < 1_000_000 && /\[1m\]|-1m\b/i.test(model ?? '')) return 1_000_000
  return base
}

/** Whether system instructions must be inlined into the prompt (and compacted on resumed turns). */
export function usesInlineSystemPrompt(kind: ProfileKind, transport?: 'print' | 'acp'): boolean {
  const mode = PROVIDER_CAPABILITIES[kind].systemPromptMode
  if (mode === 'inline') return true
  if (mode === 'flag') return false
  return transport !== 'acp'
}

export function isPermissionModeSupported(kind: ProfileKind, mode: AutoApprove): boolean {
  return PROVIDER_CAPABILITIES[kind].permissionModes.includes(mode)
}

export function resolvePermissionMode(kind: ProfileKind, mode?: string | null): AutoApprove {
  const caps = PROVIDER_CAPABILITIES[kind]
  if (mode && (caps.permissionModes as readonly string[]).includes(mode)) return mode as AutoApprove
  return caps.defaultPermissionMode
}

export function canUseOAuthLogin(kind: ProfileKind): boolean {
  return PROVIDER_CAPABILITIES[kind].authMode === 'oauth-or-apikey'
}

export function canUseSubscriptionQuota(kind: ProfileKind, hasApiKey: boolean): boolean {
  return !hasApiKey && PROVIDER_CAPABILITIES[kind].supportsUsageQuota
}

export function shouldUnbindSessionsOnRewind(kind: ProfileKind): boolean {
  return !PROVIDER_CAPABILITIES[kind].supportsNativeRewind
}
