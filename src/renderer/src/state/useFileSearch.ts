import { useEffect, useState } from 'react'
import type { FileSearchResponse } from '@shared/types'
import type { FileTrigger } from '../lib/fileMention'

interface Search {
  cwd: string
  trigger: FileTrigger
}

interface SearchResult extends Search {
  refresh: Search | null
  data: FileSearchResponse | null
}

export function useFileSearch(cwd: string | null, trigger: FileTrigger | null) {
  const [result, setResult] = useState<SearchResult | null>(null)
  const [refresh, setRefresh] = useState<Search | null>(null)
  useEffect(() => {
    if (!cwd || !trigger) {
      setResult(null)
      return
    }
    const force = refresh?.cwd === cwd && refresh.trigger === trigger
    let cancelled = false
    const run = () => {
      void window.agentswitch.files.search({ cwd, query: trigger.query, refresh: force }).then(
        (data) => { if (!cancelled) setResult({ cwd, trigger, refresh, data }) },
        () => { if (!cancelled) setResult({ cwd, trigger, refresh, data: null }) }
      )
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    if (!trigger.query || force) run()
    else timer = setTimeout(run, 30)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [cwd, trigger, refresh])

  const visible = trigger && result?.cwd === cwd && result.trigger.start === trigger.start ? result : null
  const current = visible?.trigger === trigger && visible?.refresh === refresh ? visible : null
  return {
    items: visible?.data?.items ?? [],
    loading: !!cwd && !!trigger && !current,
    failed: current?.data === null,
    truncated: !!current?.data?.truncated,
    onRefresh: () => { if (cwd && trigger) setRefresh({ cwd, trigger }) }
  }
}
