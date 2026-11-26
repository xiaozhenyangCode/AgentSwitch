import { useEffect, useMemo, useState } from 'react'
import fuzzysort from 'fuzzysort'
import type { Attachment } from '@shared/chat'
import { attachmentDedupKey, attachmentRefLabel, COMPOSER_ATTACHMENT_LIMIT } from '@shared/fileReferences'
import { joinPosixRelative } from '@shared/fileResolve'
import type { FileSearchItem, FileSearchResponse } from '@shared/types'
import type { FileTrigger } from '../lib/fileMention'

interface Search {
  cwd: string
  trigger: FileTrigger
}

interface SearchResult extends Search {
  refresh: Search | null
  data: FileSearchResponse | null
}

export type ComposerFileCandidate =
  | (FileSearchItem & { kind: 'workspace' })
  | { kind: 'added'; attachment: Attachment; name: string; indexes: number[]; dir: string; aliasIndexes: number[] }

export function useFileSearch(cwd: string | null, trigger: FileTrigger | null, attachments: readonly Attachment[]) {
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
      void window.agentswitch.files.search({ cwd, query: trigger.query, limit: 20 + COMPOSER_ATTACHMENT_LIMIT, refresh: force }).then(
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

  const current = result?.cwd === cwd && result?.trigger === trigger && result.refresh === refresh ? result : null
  const query = trigger?.query
  const items = useMemo<ComposerFileCandidate[]>(() => {
    if (query === undefined) return []
    const indexed = attachments.filter((a) => a.path || a.fallbackPath || (cwd && a.relativePath))
      .map((attachment) => ({ attachment, name: attachment.name, label: attachmentRefLabel(attachment) }))
    const added = query
      ? fuzzysort.go(query, indexed, { keys: ['name', 'label'], threshold: 0, limit: 0 }).map((match) => ({
          ...match.obj, indexes: [...match[0].indexes], aliasIndexes: [...match[1].indexes]
        }))
      : indexed.map((item) => ({ ...item, indexes: [], aliasIndexes: [] }))
    const candidates: ComposerFileCandidate[] = added.map(({ attachment, name, label, indexes, aliasIndexes }) => ({
      kind: 'added', attachment, name, indexes, dir: label === name ? attachment.path ?? '' : label,
      aliasIndexes: label === name ? [] : aliasIndexes
    }))
    if (!cwd || !current?.data) return candidates
    const maxVisible = candidates.length + 20
    const keys = new Set(attachments.map((att) => attachmentDedupKey(att, cwd)))
    for (const item of current.data.items) {
      const path = joinPosixRelative(cwd, item.relPath, { literalPosix: true })
      if (!path || keys.has(attachmentDedupKey({ id: '', path }, cwd))) continue
      candidates.push({ ...item, kind: 'workspace' })
      if (candidates.length === maxVisible) break
    }
    return candidates
  }, [query, attachments, current, cwd])
  return {
    items,
    loading: !!cwd && !!trigger && !current,
    failed: current?.data === null,
    truncated: !!current?.data?.truncated,
    onRefresh: () => { if (cwd && trigger) setRefresh({ cwd, trigger }) }
  }
}
