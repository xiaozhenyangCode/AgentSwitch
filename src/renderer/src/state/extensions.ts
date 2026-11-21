import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { ExtOverview, ProfileId, ProfileKind, SkillItem, SkillList } from '@shared/types'

/**
 * Skills and MCP servers an account would load in a project, read by the main process from the
 * CLIs' local config files (no CLI run, no model call). Results are kept per account + folder
 * so menus open instantly; each open re-reads in the background (the main process caches 15 s).
 */

type Key = string
const keyOf = (id: ProfileId, cwd: string | null): Key => `${id}|${cwd ?? ''}`

function useLocalConfig<T>(fetcher: (id: ProfileId, cwd: string | null, refresh: boolean) => Promise<T>, store: Map<Key, T>, id: ProfileId | null, cwd: string | null, active: boolean) {
  const key = id ? keyOf(id, cwd) : null
  const [data, setData] = useState<T | null>(key ? (store.get(key) ?? null) : null)
  const [loading, setLoading] = useState(false)
  const latest = useRef(key)
  latest.current = key

  const load = useCallback(
    async (refresh = false) => {
      if (!id || !key) return
      setLoading(true)
      try {
        const r = await fetcher(id, cwd, refresh)
        store.set(key, r)
        if (latest.current === key) setData(r)
      } catch {
        // config unreadable: behave as "nothing configured"
        if (latest.current === key) setData(store.get(key) ?? null)
      } finally {
        if (latest.current === key) setLoading(false)
      }
    },
    [id, cwd, key, fetcher, store]
  )

  useEffect(() => {
    setLoading(false)
    setData(key ? (store.get(key) ?? null) : null)
    if (key && active) void load()
  }, [key, active, load, store])

  return { data, loading, reload: () => load(true) }
}

const skillStore = new Map<Key, SkillList>()
const fetchSkills = (id: ProfileId, cwd: string | null, refresh: boolean) => window.agentswitch.ext.skills(id, cwd, refresh)

/** `active`: fetch now (e.g. when the / menu opens); otherwise only cached data is returned. */
export const useSkills = (id: ProfileId | null, cwd: string | null, active: boolean) => useLocalConfig(fetchSkills, skillStore, id, cwd, active)

const overviewStore = new Map<Key, ExtOverview>()
const fetchOverview = (id: ProfileId, cwd: string | null, refresh: boolean) => window.agentswitch.ext.overview(id, cwd, refresh)
/** Skills, agents, plugins, MCP, rules and hooks for the toolbar entry and its panel. */
export const useOverview = (id: ProfileId | null, cwd: string | null, active = true) => useLocalConfig(fetchOverview, overviewStore, id, cwd, active)

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
