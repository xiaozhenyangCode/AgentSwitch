import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { ExtDescription, ExtOverview, ExtTranslateProgressEvent, ProfileId, ProfileKind, SkillItem, SkillList } from '@shared/types'
import type { Locale } from '@shared/i18n'
import { useI18n } from './i18n'

/**
 * Skills and MCP servers an account would load in a project, read by the main process from the
 * CLIs' local config files (no CLI run, no model call). Results are kept per account + folder
 * so menus open instantly; each open re-reads in the background (the main process caches 15 s).
 */

type Key = string
const cacheSubs = new Set<() => void>()
const subscribeCache = (cb: () => void) => (cacheSubs.add(cb), () => void cacheSubs.delete(cb))
let cacheRevision = 0

export function invalidateExtCache(): void {
  skillStore.clear()
  overviewStore.clear()
  cacheRevision++
  for (const cb of cacheSubs) cb()
}

function useLocalConfig<T>(
  fetcher: (id: ProfileId, cwd: string | null, refresh: boolean, locale: Locale) => Promise<T>,
  store: Map<Key, T>,
  id: ProfileId | null,
  cwd: string | null,
  active: boolean
) {
  const { locale } = useI18n()
  const key = id ? JSON.stringify([id, cwd, locale]) : null
  const revision = useSyncExternalStore(subscribeCache, () => cacheRevision)
  const [result, setResult] = useState<{ key: Key; data: T | null } | null>(null)
  const [loadingKey, setLoadingKey] = useState<Key | null>(null)
  const latest = useRef(key)
  latest.current = key
  const request = useRef(0)

  const load = useCallback(async (refresh = false, background = false) => {
    if (!id || !key) return
    const startedAt = cacheRevision
    const requestId = ++request.current
    const isCurrent = () => request.current === requestId && latest.current === key && cacheRevision === startedAt
    if (!background) setLoadingKey(key)
    try {
      const data = await fetcher(id, cwd, refresh, locale)
      if (!isCurrent()) return
      store.set(key, data)
      setResult({ key, data })
    } catch {
      if (isCurrent()) setResult({ key, data: store.get(key) ?? null })
    } finally {
      if (isCurrent()) setLoadingKey(null)
    }
  }, [id, cwd, key, locale, fetcher, store])

  useEffect(() => {
    if (!key || !active) return
    void load(false, true)
    const timer = window.setInterval(() => void load(false, true), 15_000)
    return () => window.clearInterval(timer)
  }, [key, active, load, revision])

  const data = result?.key === key ? result.data : key ? (store.get(key) ?? null) : null
  return { data, loading: !!key && (loadingKey === key || (active && !data && result?.key !== key)), reload: () => load(true) }
}

const skillStore = new Map<Key, SkillList>()
const fetchSkills = (id: ProfileId, cwd: string | null, refresh: boolean, locale: Locale) => window.agentswitch.ext.skills(id, cwd, refresh, locale)

/** `active`: fetch now (e.g. when the / menu opens); otherwise only cached data is returned. */
export const useSkills = (id: ProfileId | null, cwd: string | null, active: boolean) => useLocalConfig(fetchSkills, skillStore, id, cwd, active)

const overviewStore = new Map<Key, ExtOverview>()
const fetchOverview = (id: ProfileId, cwd: string | null, refresh: boolean, locale: Locale) => window.agentswitch.ext.overview(id, cwd, refresh, locale)
/** Skills, agents, plugins, MCP, rules and hooks for the extensions settings page. */
export const useOverview = (id: ProfileId | null, cwd: string | null, active = true) => useLocalConfig(fetchOverview, overviewStore, id, cwd, active)

const ORIGINAL_KEY = 'agentswitch.extensions.showOriginal'
let showOriginal = window.localStorage.getItem(ORIGINAL_KEY) === 'true'
const descriptionSubs = new Set<() => void>()
const subscribeDescription = (cb: () => void) => (descriptionSubs.add(cb), () => void descriptionSubs.delete(cb))

export const useShowOriginalDesc = () => useSyncExternalStore(subscribeDescription, () => showOriginal)

export function setShowOriginalDesc(value: boolean): void {
  showOriginal = value
  window.localStorage.setItem(ORIGINAL_KEY, String(value))
  for (const cb of descriptionSubs) cb()
}

export function displayExtDescription(item: ExtDescription, original: boolean): string {
  return original ? item.description : item.translatedDescription ?? item.description
}

let translateProgress: ExtTranslateProgressEvent | null = null
const progressSubs = new Set<() => void>()
const subscribeProgress = (cb: () => void) => (progressSubs.add(cb), () => void progressSubs.delete(cb))
export const useTranslateProgress = () => useSyncExternalStore(subscribeProgress, () => translateProgress)

window.agentswitch.ext.onTranslateProgress((event) => {
  const previous = translateProgress
  translateProgress = event
  if (event.status !== 'running' || event.translated > (previous?.runId === event.runId ? previous.translated : 0)) {
    invalidateExtCache()
  }
  for (const cb of progressSubs) cb()
})

// ---- pinned skills (per CLI kind, stored in userData) ------------------------------------------

let pins: Partial<Record<ProfileKind, string[]>> = {}
const pinSubs = new Set<() => void>()
void window.agentswitch.ext
  .pins()
  .then((p) => {
    pins = p ?? {}
    for (const cb of pinSubs) cb()
  })
  .catch(() => {})

const subscribePins = (cb: () => void) => (pinSubs.add(cb), () => void pinSubs.delete(cb))
const EMPTY: string[] = []

/** Pinned skill names for a CLI kind (pinned ones lead the / menu). */
export const usePins = (kind: ProfileKind | null | undefined): string[] => useSyncExternalStore(subscribePins, () => (kind ? (pins[kind] ?? EMPTY) : EMPTY))

export function togglePin(kind: ProfileKind, name: string): void {
  const cur = pins[kind] ?? []
  const next = cur.includes(name) ? cur.filter((n) => n !== name) : [name, ...cur]
  pins = { ...pins, [kind]: next }
  for (const cb of pinSubs) cb()
  void window.agentswitch.ext.setPins(kind, next)
}

/** Pinned first (in pin order), the rest unchanged. */
export function pinnedFirst(items: SkillItem[], pinned: string[]): SkillItem[] {
  if (!pinned.length) return items
  const rank = new Map(pinned.map((n, i) => [n, i]))
  return [...items].sort((a, b) => (rank.get(a.name) ?? 1e9) - (rank.get(b.name) ?? 1e9))
}
