/**
 * A "model spec" is the sub-model choice as stored everywhere (thread driver, @mentions,
 * account default): `<model>` or `<model>:<effort>`, e.g. `gemini-4-neon:high`.
 * Each CLI adapter maps the effort to its own flag (claude --effort, codex
 * model_reasoning_effort, agy model-id suffix).
 */

export const EFFORT_ORDER = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const

export const EFFORT_LABEL: Record<string, string> = {
  none: 'None',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Med',
  high: 'High',
  xhigh: 'XHigh',
  max: 'Max',
  ultra: 'Ultra'
}

/** Effort suffix agy (and similar lists) bakes into model ids: `gemini-4-neon-high`. */
export const EFFORT_SUFFIX_RE = /^(.+)-(minimal|low|medium|high|xhigh|max)$/

export const effortRank = (e: string): number => {
  const i = (EFFORT_ORDER as readonly string[]).indexOf(e)
  return i < 0 ? 99 : i
}

export function splitSpec(spec: string | null | undefined, kind?: 'reasonix'): { model: string | null; effort: string | null } {
  const s = spec?.trim()
  if (!s) return { model: null, effort: null }
  const i = s.lastIndexOf(':')
  if (i <= 0) return { model: s, effort: null }
  const e = s.slice(i + 1)
  return EFFORT_LABEL[e] || (kind === 'reasonix' && e === 'disabled') ? { model: s.slice(0, i), effort: e } : { model: s, effort: null }
}

export const joinSpec = (model: string | null, effort: string | null): string | null => (model ? (effort ? `${model}:${effort}` : model) : null)
