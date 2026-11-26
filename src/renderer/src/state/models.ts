import { useEffect, useSyncExternalStore } from 'react'
import type { ModelList, ModelOption, ProfileId } from '@shared/types'
import { EFFORT_SUFFIX_RE } from '@shared/modelSpec'

/** Per-account sub-model lists fetched from the main process (catalog / CLI / cache / static). */

const lists = new Map<ProfileId, ModelList>()
const loading = new Map<ProfileId, Promise<ModelList | null>>()
const listeners = new Set<() => void>()
let version = 0
const notify = () => {
  version++
  listeners.forEach((l) => l())
}

export function loadModels(id: ProfileId, refresh = false): Promise<ModelList | null> {
  const pending = loading.get(id)
  if (pending && !refresh) return pending
  const request = window.agentswitch.models.list(id, refresh).then((list) => {
    if (loading.get(id) === request) lists.set(id, list)
    return list
  }).catch(() => null).finally(() => {
    if (loading.get(id) !== request) return
    loading.delete(id)
    notify()
  })
  loading.set(id, request)
  notify()
  return request
}

export function forgetAccountModels(id: ProfileId): void {
  const hadList = lists.delete(id)
  const wasLoading = loading.delete(id)
  if (hadList || wasLoading) notify()
}

export function useModels(id: ProfileId | null | undefined): { list: ModelList | null; loading: boolean; refresh: () => void } {
  useSyncExternalStore(
    (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    () => version
  )
  useEffect(() => {
    if (id && !lists.has(id)) void loadModels(id)
  }, [id])
  return {
    list: id ? (lists.get(id) ?? null) : null,
    loading: !!id && loading.has(id),
    refresh: () => id && void loadModels(id, true)
  }
}

/**
 * Finds the list row for a model id (own account first, then any account). A raw id with an
 * effort suffix (`gemini-4-neon-high`, e.g. reported back by agy) resolves to its folded base row.
 */
export function findModel(id: string | null | undefined, profileId?: ProfileId): { opt: ModelOption; effort: string | null } | null {
  if (!id) return null
  const own = profileId ? lists.get(profileId) : undefined
  const all = own ? [own, ...lists.values()] : [...lists.values()]
  for (const l of all) {
    const m = l.models.find((x) => x.id === id)
    if (m) return { opt: m, effort: null }
  }
  const s = EFFORT_SUFFIX_RE.exec(id)
  if (s)
    for (const l of all) {
      const m = l.models.find((x) => x.id === s[1] && x.efforts?.includes(s[2]))
      if (m) return { opt: m, effort: s[2] }
    }
  return null
}

/** Display name of a model id, using any account's fetched list. */
export const modelName = (id: string | null | undefined, profileId?: ProfileId): string | null => findModel(id, profileId)?.opt.label ?? null

/** Synchronous read of an already-fetched list (null if not loaded yet). */
export const getModelList = (id: ProfileId): ModelList | null => lists.get(id) ?? null

/** Re-render on any model-list change (for components reading several accounts' lists). */
export function useModelsVersion(): number {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    () => version
  )
}
