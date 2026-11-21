import type { ProfileKind, ProfileState } from '@shared/types'

/** Friendly names for well-known sub-model ids; anything else is shown verbatim. */
const LABELS: Record<string, string> = {
  fable: 'Fable',
  opus: 'Opus',
  sonnet: 'Sonnet',
  haiku: 'Haiku'
}

export const modelLabel = (id: string | null | undefined): string => {
  if (!id) return '默认'
  return LABELS[id.toLowerCase()] ?? id
}

/** Model a turn actually uses: explicit choice, else the account default, else CLI default (null). */
export const effectiveModel = (explicit: string | null | undefined, p: ProfileState | undefined): string | null =>
  explicit?.trim() || p?.defaultModel?.trim() || null

export const DEFAULT_HINT: Record<ProfileKind, string> = {
  claude: '跟随 Claude Code 默认',
  codex: '跟随 Codex CLI 默认',
  gemini: '跟随 agy 默认'
}
