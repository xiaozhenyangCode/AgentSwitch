import { useCallback, useEffect, useRef, useState } from 'react'
import type { McpList, ProfileId, SkillList } from '@shared/types'

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
const mcpStore = new Map<Key, McpList>()
const fetchSkills = (id: ProfileId, cwd: string | null, refresh: boolean) => window.agentswitch.ext.skills(id, cwd, refresh)
const fetchMcp = (id: ProfileId, cwd: string | null, refresh: boolean) => window.agentswitch.ext.mcp(id, cwd, refresh)

/** `active`: fetch now (e.g. when the / menu opens); otherwise only cached data is returned. */
export const useSkills = (id: ProfileId | null, cwd: string | null, active: boolean) => useLocalConfig(fetchSkills, skillStore, id, cwd, active)
export const useMcp = (id: ProfileId | null, cwd: string | null) => useLocalConfig(fetchMcp, mcpStore, id, cwd, true)
