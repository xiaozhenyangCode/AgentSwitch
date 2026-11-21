import type { ModelOption, ProfileKind, ProfileState } from '@shared/types'
import { EFFORT_LABEL, joinSpec, splitSpec } from '@shared/modelSpec'
import { findModel } from '../state/models'

/** Display name for a model spec (`model` or `model:effort`), e.g. `Gemini 4 Neon · High`. */
export const modelLabel = (spec: string | null | undefined, profileId?: string): string => {
  const { model, effort } = splitSpec(spec)
  if (!model) return '默认'
  const f = findModel(model, profileId)
  const name = f?.opt.label.replace(/（最新）$/, '') ?? model
  const e = effort ?? f?.effort
  return e ? `${name} · ${EFFORT_LABEL[e] ?? e}` : name
}

/**
 * Splits a spec into its list row + effort, folding raw suffixed ids
 * (`gemini-4-neon-high` → base `gemini-4-neon` + `high`).
 */
export function resolveSpec(spec: string | null | undefined, profileId?: string): { model: string | null; effort: string | null; opt: ModelOption | null } {
  const { model, effort } = splitSpec(spec)
  if (!model) return { model: null, effort: null, opt: null }
  const f = findModel(model, profileId)
  if (!f) return { model, effort, opt: null }
  return { model: f.opt.id, effort: effort ?? f.effort, opt: f.opt }
}

/** Keeps `effort` only if the model supports it. */
export const withEffort = (opt: ModelOption | null, model: string, effort: string | null): string | null =>
  joinSpec(model, effort && opt?.efforts?.includes(effort) ? effort : null)

/** Model a turn actually uses: explicit choice, else the account default, else CLI default (null). */
export const effectiveModel = (explicit: string | null | undefined, p: ProfileState | undefined): string | null =>
  explicit?.trim() || p?.defaultModel?.trim() || null

export const DEFAULT_HINT: Record<ProfileKind, string> = {
  claude: '跟随 Claude Code 默认',
  codex: '跟随 Codex CLI 默认',
  gemini: '跟随 agy 默认'
}
