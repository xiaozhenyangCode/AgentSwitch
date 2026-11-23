/**
 * API-key accounts: turns an account's non-secret ApiKeyConfig + its key into spawn env.
 * Pure (no electron import) so it can be unit-tested.
 *
 * Verified 2026-11-23 with fake keys (see docs/superpowers/specs/2026-11-23-api-key-accounts-design.md):
 *   claude official  ANTHROPIC_API_KEY
 *   claude 3rd-party ANTHROPIC_BASE_URL + ANTHROPIC_AUTH_TOKEN + ANTHROPIC_MODEL…
 *   codex            CODEX_API_KEY (OPENAI_API_KEY is ignored by codex)
 *   gemini (agy)     GEMINI_API_KEY + modelProvider "gemini" in its settings.json
 */
import type { ApiKeyConfig, ProfileKind } from '@shared/types'

/** DeepSeek's documented Claude Code setup (api-docs.deepseek.com, agent_integrations/claude_code). */
export const DEEPSEEK = {
  label: 'DeepSeek',
  baseUrl: 'https://api.deepseek.com/anthropic',
  /** first = default, as in DeepSeek's doc; `[1m]` opts into the 1M context window */
  models: ['deepseek-flash[1m]', 'deepseek-v4-pro[1m]'],
  /** background tasks / subagents */
  smallModel: 'deepseek-flash',
  env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '786432' } as Record<string, string>
}

/** Vars that pick credentials or endpoints, per CLI. Stripped from every inherited env. */
export const CREDENTIAL_VARS: Record<ProfileKind, string[]> = {
  claude: [
    'ANTHROPIC_BASE_URL',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_MODEL',
    'ANTHROPIC_DEFAULT_OPUS_MODEL',
    'ANTHROPIC_DEFAULT_SONNET_MODEL',
    'ANTHROPIC_DEFAULT_HAIKU_MODEL',
    'ANTHROPIC_SMALL_FAST_MODEL',
    'CLAUDE_CODE_SUBAGENT_MODEL'
  ],
  codex: ['CODEX_API_KEY', 'OPENAI_API_KEY', 'OPENAI_BASE_URL'],
  gemini: ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_GEMINI_BASE_URL', 'GOOGLE_GENAI_USE_VERTEXAI', 'GOOGLE_CLOUD_PROJECT']
}

/** Env vars whose values are secrets and must be masked wherever env is displayed. */
export const SECRET_VARS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CODEX_API_KEY', 'GEMINI_API_KEY', 'OPENAI_API_KEY', 'GOOGLE_API_KEY']

const isThirdParty = (cfg: ApiKeyConfig): boolean => cfg.provider === 'deepseek' || cfg.provider === 'custom'

/** Fills the DeepSeek preset's endpoint and models; other configs are returned as-is. */
export function resolveApiKeyConfig(_kind: ProfileKind, cfg: ApiKeyConfig): ApiKeyConfig {
  if (cfg.provider === 'deepseek') return { provider: 'deepseek', baseUrl: DEEPSEEK.baseUrl, models: [...DEEPSEEK.models] }
  return cfg
}

/**
 * Returns an i18n key describing the first problem, or null when valid.
 * Normalizes a custom `baseUrl` (trim, no trailing slash) and `models` (trimmed, non-empty) in place.
 */
export function validateApiKeyConfig(kind: ProfileKind, cfg: ApiKeyConfig): string | null {
  if (!['official', 'deepseek', 'custom'].includes(cfg.provider)) return 'apikey.badProvider'
  if (isThirdParty(cfg) && kind !== 'claude') return 'apikey.badProvider'
  if (cfg.provider !== 'custom') return null
  const url = (cfg.baseUrl ?? '').trim().replace(/\/+$/, '')
  if (!/^https?:\/\/[^\s/]+/i.test(url)) return 'apikey.badUrl'
  cfg.baseUrl = url
  cfg.models = (cfg.models ?? []).map((m) => m.trim()).filter(Boolean)
  if (!cfg.models.length) return 'apikey.noModels'
  return null
}

/** Env that connects `kind` with `key`. `defaultModel` = the account's chosen default ('' = first model). */
export function apiKeyEnv(kind: ProfileKind, cfg: ApiKeyConfig, key: string, defaultModel: string): Record<string, string> {
  if (kind === 'codex') return { CODEX_API_KEY: key }
  if (kind === 'gemini') return { GEMINI_API_KEY: key }
  if (!isThirdParty(cfg)) return { ANTHROPIC_API_KEY: key }
  const models = cfg.models ?? []
  const main = defaultModel || models[0] || ''
  const small = cfg.provider === 'deepseek' ? DEEPSEEK.smallModel : main
  return {
    ANTHROPIC_BASE_URL: cfg.baseUrl ?? '',
    ANTHROPIC_AUTH_TOKEN: key,
    ANTHROPIC_MODEL: main,
    ANTHROPIC_DEFAULT_OPUS_MODEL: main,
    ANTHROPIC_DEFAULT_SONNET_MODEL: main,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: small,
    CLAUDE_CODE_SUBAGENT_MODEL: small,
    ...(cfg.provider === 'deepseek' ? DEEPSEEK.env : {})
  }
}

/** Removes this CLI's credential/endpoint vars, so a global `export` can't redirect an account. */
export function stripCredentials(kind: ProfileKind, base: Record<string, string>): Record<string, string> {
  const drop = new Set(CREDENTIAL_VARS[kind])
  return Object.fromEntries(Object.entries(base).filter(([k]) => !drop.has(k)))
}

export function maskSecret(v: string): string {
  return v.length >= 12 ? `${v.slice(0, 3)}…${v.slice(-4)}` : '••••'
}

export function maskEnv(env: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(env).map(([k, v]) => [k, SECRET_VARS.includes(k) && v ? maskSecret(v) : v]))
}

/** Display form of a model id (`deepseek-flash[1m]` → `deepseek-flash`). */
export const displayModel = (id: string): string => id.replace(/\[1m\]$/i, '')

const INVALID_KEY_RE = /invalid api key|invalid_api_key|incorrect api key|api key not valid|authentication_error|invalid x-api-key|authentication fails|failed to authenticate/i
export const isInvalidKeyError = (text: string): boolean => INVALID_KEY_RE.test(text)

/** Claude Code's stderr notice for model ids it doesn't know (every third-party model). */
export const isClaudeModelWarning = (line: string): boolean =>
  line.includes('[claude-code:unrecognized_model]') || /Claude Code doesn't recognize the model/.test(line)
