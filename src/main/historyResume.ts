import { historyModel, type TranscriptEntry } from '@shared/transcript'
import { getProviderCapabilities } from '@shared/providerCapabilities'
import type { ProfileId, ProfileKind } from '@shared/types'

export interface NativeSessions {
  scope?: string
  sessions?: Record<ProfileId, string>
  models?: Record<ProfileId, string | null>
  priorSessions?: [ProfileId, string][]
  imported?: string[]
  importedAt?: Record<string, number>
}

export function canResume(
  state: NativeSessions, profileId: ProfileId, kind: ProfileKind, model: string | null,
  history: TranscriptEntry[], takingOver: boolean
): string | null {
  if (!getProviderCapabilities(kind).supportsResume) return null
  const session = state.sessions?.[profileId]
  if (!session || takingOver) return null
  const target = historyModel(model, kind)
  if (state.models && Object.hasOwn(state.models, profileId)) return state.models[profileId] === target ? session : null

  // Older versions could bind two accounts that use the same local store to a single session.
  let owner: TranscriptEntry | undefined
  for (let i = history.length - 1; i >= 0; i--) {
    const entry = history[i]
    if (entry.profileId && entry.replied && state.sessions?.[entry.profileId] === session) {
      owner = entry
      break
    }
  }
  if (owner && owner.profileId !== profileId) return null
  if (owner && !state.imported?.includes(session) && historyModel(owner.model, kind) !== target) return null
  return session
}

/** Keep replaced sessions discoverable for ownership, usage and thread deletion. */
export function nativeSessionEntries(state: NativeSessions): [ProfileId, string][] {
  return [...Object.entries(state.sessions ?? {}), ...(Array.isArray(state.priorSessions) ? state.priorSessions : [])]
    .filter((entry) => Array.isArray(entry) && typeof entry[0] === 'string' && typeof entry[1] === 'string' && !!entry[1])
}

export function recordUnconfirmedSession(state: NativeSessions, profileId: ProfileId, sid: string): NativeSessions {
  const sessions = { ...state.sessions }
  const models = { ...state.models }
  for (const [account, boundId] of Object.entries(sessions)) {
    if (boundId !== sid) continue
    delete sessions[account]
    delete models[account]
  }
  // Keep failed runs attached for history filtering and deletion without offering them for resume.
  const priorSessions = nativeSessionEntries(state).filter(([account, previous]) => sessions[account] !== previous)
  if (!priorSessions.some(([account, previous]) => account === profileId && previous === sid)) {
    priorSessions.push([profileId, sid])
  }
  return { ...state, sessions, models, priorSessions }
}

export function bindNativeSession(
  state: NativeSessions, profileId: ProfileId, sid: string,
  options: { scope?: string; model: string | null } | { importedAt: number }
): NativeSessions {
  const scope = 'scope' in options ? options.scope : undefined
  const sameScope = state.scope === scope
  const sessions = { ...(sameScope ? state.sessions : undefined), [profileId]: sid }
  const models = { ...(sameScope ? state.models : undefined) }
  const priorSessions = nativeSessionEntries(state)
    .filter(([account, previous]) => sessions[account] !== previous)
  const imported = new Set(state.imported)
  const importedAt = { ...state.importedAt }
  if ('importedAt' in options) {
    imported.add(sid)
    importedAt[sid] ??= options.importedAt
    delete models[profileId]
  } else {
    models[profileId] = options.model
  }
  return { scope, sessions, models, priorSessions, imported: [...imported], importedAt }
}

/**
 * Unbinds all active native CLI sessions (e.g. after rewinding a conversation) while keeping
 * them in `priorSessions` so history filtering, usage accounting and thread deletion still work.
 * The next turn cannot `--resume` stale truncated context and falls back to budgeted handoff.
 */
export function clearActiveSessions(
  state: NativeSessions,
  shouldUnbind: (profileId: ProfileId) => boolean = () => true
): NativeSessions {
  const sessions: Record<ProfileId, string> = {}
  const models: Record<ProfileId, string | null> = {}
  for (const [account, sid] of Object.entries(state.sessions ?? {})) {
    if (!shouldUnbind(account)) {
      sessions[account] = sid
      if (state.models && Object.hasOwn(state.models, account)) models[account] = state.models[account]
    }
  }
  const priorSessions = nativeSessionEntries(state).filter(([account, sid]) => sessions[account] !== sid)
  return {
    ...state,
    sessions,
    models,
    priorSessions
  }
}
