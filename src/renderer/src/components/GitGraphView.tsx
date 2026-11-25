import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent as ReactPointerEvent, type RefObject } from 'react'
import { normalizeGitCommitQuery } from '@shared/gitCommitMatch'
import type { GitBranch, GitCommitDetail, GitGraphCommit, GitGraphData, GitMutation, GitMutationResult, GitStatus } from '@shared/types'
import { useLayer } from '../lib/escStack'
import {
  appendGraphPage, getGraphNodes, graphCommits, graphLinePath, layoutGitGraph,
  GRAPH_LANE_GAP, GRAPH_LEFT_PAD, GRAPH_ROW_HEIGHT, WORKTREE_NODE, type GraphRow
} from '../lib/gitGraph'
import { useApp } from '../state/AppContext'
import { currentLocale, fmtAgo, t } from '../state/i18n'
import { gitErrorTitle, type RunGit } from '../state/useProjectGit'
import { Counts, FileRow } from './ChangesPanel'
import { IconArrowUp, IconBranch, IconCheck, IconChevronDown, IconCopy, IconDownload, IconFocus, IconRefresh, IconSearch, IconTag, IconX, Spinner } from './icons'

type CommitDetail = { hash: string; commit?: GitCommitDetail; error?: string }
type RemoteControls = {
  status: Extract<GitStatus, { repo: true }> | null
  disabled: boolean
  busy: boolean
  pending: GitMutation['kind'] | null
  run: RunGit
  refresh: () => void
}
type RemoteFailure = Extract<GitMutationResult, { ok: false }>

const PAGE_SIZE = 100
const allBranches = '__ALL__'
const columnKey = 'agentswitch.gitGraph.columns'
const defaultWidths = { author: 96, time: 78, hash: 80 }
const minWidths = { author: 70, time: 70, hash: 68 }
type Column = keyof typeof defaultWidths
const columnLabels = { author: 'git.graphAuthor', time: 'git.graphDate', hash: 'git.graphHash' } as const
const adjustableColumns = ['author', 'time', 'hash'] as const
const maxWidth = 400
const clampWidth = (column: Column, width: number) => Math.min(maxWidth, Math.max(minWidths[column], width))
const splitKey = 'agentswitch.gitGraph.inspectorRatio'
const defaultRatio = 0.35
const minRatio = 0.25
const maxRatio = 0.62
const clampRatio = (ratio: number) => Math.min(maxRatio, Math.max(minRatio, ratio))
const iconButton = 'grid size-8 shrink-0 place-items-center rounded-lg text-ink-2 hover:bg-black/[0.06] hover:text-ink disabled:opacity-40'
const textButton = 'rounded-md px-2.5 py-1 text-[12px] font-medium text-ink-2 hover:bg-black/[0.06] hover:text-ink disabled:opacity-45'
const toolbarButton = 'flex h-8 shrink-0 items-center gap-1.5 rounded-lg px-2 text-[12px] text-ink-2 hover:bg-black/[0.06] hover:text-ink disabled:opacity-40'
const laneColor = (color: number) => `var(--git-lane-${color % 6})`
const syncActions = [
  { kind: 'fetch', Icon: IconRefresh, progress: 'git.fetching' },
  { kind: 'pull', Icon: IconDownload, progress: 'git.pulling' },
  { kind: 'push', Icon: IconArrowUp, progress: 'git.pushing' }
] as const
type RemoteAction = typeof syncActions[number]['kind']

function readColumnWidths() {
  const widths = { ...defaultWidths }
  try {
    const saved = JSON.parse(localStorage.getItem(columnKey) ?? 'null')
    for (const column of adjustableColumns) {
      const width = saved?.[column]
      if (typeof width === 'number' && Number.isFinite(width)) widths[column] = clampWidth(column, width)
    }
  } catch { /* Use defaults when storage is unavailable or invalid. */ }
  return widths
}

export function GitGraphView({ dir, onClose, onViewChanges, remote }: {
  dir: string
  onClose: () => void
  onViewChanges: () => void
  remote: RemoteControls | null
}) {
  const { toast } = useApp()
  const dialog = useRef<HTMLDialogElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const sentinel = useRef<HTMLDivElement>(null)
  const table = useRef<HTMLDivElement>(null)
  const search = useRef<HTMLInputElement>(null)
  const [branch, setBranch] = useState(allBranches)
  const [branches, setBranches] = useState<GitBranch[]>([])
  const [query, setQuery] = useState('')
  const [data, setData] = useState<GitGraphData | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [detail, setDetail] = useState<CommitDetail | null>(null)
  const [copiedHash, setCopiedHash] = useState<string | null>(null)
  const [focusHash, setFocusHash] = useState<string | null>(null)
  const [remoteError, setRemoteError] = useState<RemoteFailure | null>(null)
  const [widths, setWidths] = useState(readColumnWidths)
  const savedWidths = useRef(widths)
  const graphRequest = useRef(0)
  const inFlight = useRef(false)
  const nextSkip = useRef<number | null>(null)
  const filters = useRef({ branch: allBranches, query: '' })
  const searchValue = useRef('')
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const composing = useRef(false)
  const mounted = useRef(false)
  const remoteRunning = useRef(false)
  const detailRequest = useRef(0)
  const copyRequest = useRef(0)

  useLayer({ onEsc: onClose, onClose })
  useLayoutEffect(() => {
    const modal = dialog.current
    if (!modal) return
    modal.showModal()
    search.current?.focus()
    return () => modal.close()
  }, [])

  const cancelSearch = useCallback(() => {
    if (searchTimer.current !== null) clearTimeout(searchTimer.current)
    searchTimer.current = null
  }, [])

  const loadPage = useCallback(async (skip: number, ref: string, query: string) => {
    const request = ++graphRequest.current
    inFlight.current = true
    if (!skip) setData(null)
    setLoading(true)
    setLoadError('')
    try {
      const readPage = (branch: string) => window.agentswitch.git.graph(dir, { branch, skip, limit: PAGE_SIZE, query })
      let result = await readPage(ref)
      if (request !== graphRequest.current) return null
      if (!skip && !result.ok && result.code === 'invalidBranch' && ref !== allBranches) {
        filters.current.branch = allBranches
        setBranch(allBranches)
        result = await readPage(allBranches)
        if (request !== graphRequest.current) return null
      }
      if (!result.ok) {
        setLoadError(result.error)
        return null
      }
      nextSkip.current = result.hasMore ? result.nextSkip : null
      setData((previous) => skip && previous ? appendGraphPage(previous, result) : result)
      setBranches(result.branches)
      return result
    } catch (error) {
      if (request === graphRequest.current) setLoadError(String(error))
      return null
    } finally {
      if (request === graphRequest.current) {
        inFlight.current = false
        setLoading(false)
      }
    }
  }, [dir])

  const resetList = useCallback((ref: string, query: string) => {
    graphRequest.current++
    cancelSearch()
    filters.current = { branch: ref, query }
    nextSkip.current = null
    setBranch(ref)
    detailRequest.current++
    setDetail(null)
    setFocusHash(null)
    list.current?.scrollTo(0, 0)
    return loadPage(0, ref, query)
  }, [cancelSearch, loadPage])

  useEffect(() => {
    mounted.current = true
    let active = true
    queueMicrotask(() => { if (active) void resetList(allBranches, '') })
    return () => {
      active = false
      mounted.current = false
      cancelSearch()
      graphRequest.current++
      inFlight.current = false
      nextSkip.current = null
      detailRequest.current++
      copyRequest.current++
    }
  }, [cancelSearch, resetList])

  const refreshStatus = remote?.refresh
  useEffect(() => { refreshStatus?.() }, [refreshStatus])

  const openCommit = async (hash: string) => {
    const request = ++detailRequest.current
    setDetail({ hash })
    try {
      const result = await window.agentswitch.git.commitDetail(dir, hash)
      if (request !== detailRequest.current) return
      setDetail(result.ok ? { hash, commit: result.commit } : { hash, error: result.error })
    } catch (error) {
      if (request === detailRequest.current) setDetail({ hash, error: String(error) })
    }
  }

  const currentQuery = () => composing.current ? filters.current.query : normalizeGitCommitQuery(searchValue.current)

  const scheduleSearch = () => {
    cancelSearch()
    graphRequest.current++
    inFlight.current = false
    setLoading(true)
    setLoadError('')
    searchTimer.current = setTimeout(() => {
      void resetList(filters.current.branch, currentQuery())
    }, 250)
  }

  const updateSearch = (value: string) => {
    searchValue.current = value
    setQuery(value)
    if (!composing.current) scheduleSearch()
  }

  const reload = () => resetList(filters.current.branch, currentQuery())

  const syncRemote = async (kind: RemoteAction) => {
    if (!remote || remote.disabled || remoteRunning.current) return
    remoteRunning.current = true
    setRemoteError(null)
    try {
      const result = await remote.run({ kind }, { errorToast: false })
      if (!mounted.current) return
      if (result.ok) void reload()
      else setRemoteError(result)
    } finally {
      remoteRunning.current = false
    }
  }

  const saveWidth = (column: Column, width: number) => {
    const next = { ...savedWidths.current, [column]: width }
    savedWidths.current = next
    setWidths(next)
    try { localStorage.setItem(columnKey, JSON.stringify(next)) } catch { /* Keep in-memory widths. */ }
  }

  const copyHash = async (hash: string) => {
    const request = ++copyRequest.current
    try {
      await window.agentswitch.sys.copy(hash)
      if (request === copyRequest.current) setCopiedHash(hash)
    } catch {
      if (request === copyRequest.current) toast({ kind: 'error', title: t('git.copyHashFailed') })
    }
  }

  const commits = useMemo(() => data ? graphCommits(data) : [], [data])
  const byHash = useMemo(() => new Map(commits.map((commit) => [commit.hash, commit])), [commits])
  const topology = useMemo(
    () => layoutGitGraph(getGraphNodes(commits, data?.headHash ?? null, data?.dirty ?? false)),
    [commits, data?.headHash, data?.dirty]
  )
  const graphWidth = GRAPH_LEFT_PAD * 2 + (topology.laneCount - 1) * GRAPH_LANE_GAP
  const columns = `${graphWidth}px minmax(180px, 1fr) var(--col-author) var(--col-time) var(--col-hash)`
  const tableStyle = {
    '--col-author': `${widths.author}px`, '--col-time': `${widths.time}px`, '--col-hash': `${widths.hash}px`,
    minWidth: `calc(${graphWidth}px + 180px + var(--col-author) + var(--col-time) + var(--col-hash))`
  } as CSSProperties
  const tabStop = detail && byHash.has(detail.hash) ? detail.hash : commits[0]?.hash

  const loadMore = useCallback(() => {
    if (!data?.hasMore || loading || inFlight.current || searchTimer.current !== null || composing.current
      || data.nextSkip !== nextSkip.current) return
    void loadPage(data.nextSkip, filters.current.branch, filters.current.query)
  }, [data, loading, loadPage])

  const pagination = useRef({ loadMore, loadError })
  useLayoutEffect(() => { pagination.current = { loadMore, loadError } }, [loadMore, loadError])
  const canAutoLoad = data?.hasMore && !loading && !loadError
  useLayoutEffect(() => {
    if (!canAutoLoad || !list.current || !sentinel.current || typeof IntersectionObserver === 'undefined') return
    let active = true
    const observer = new IntersectionObserver((entries) => {
      if (active && entries.some((entry) => entry.isIntersecting) && !pagination.current.loadError) pagination.current.loadMore()
    }, { root: list.current, rootMargin: '0px 0px 200px 0px' })
    observer.observe(sentinel.current)
    return () => {
      active = false
      observer.disconnect()
    }
  }, [canAutoLoad, data])

  useLayoutEffect(() => {
    if (!focusHash) return
    const row = list.current?.querySelector<HTMLButtonElement>(`[data-commit="${focusHash}"]`)
    if (!row) return
    row.focus({ preventScroll: true })
    row.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    setFocusHash(null)
  }, [focusHash, commits])

  const selectCommit = (hash: string) => {
    if (hash !== detail?.hash) void openCommit(hash)
    setFocusHash(hash)
  }
  const locateHead = async () => {
    if (!data?.headHash) return
    const alreadyLoaded = !composing.current && searchTimer.current === null && !currentQuery()
      && !filters.current.query && byHash.has(data.headHash)
    cancelSearch()
    searchValue.current = ''
    setQuery('')
    if (alreadyLoaded) {
      selectCommit(data.headHash)
      return
    }
    const ref = filters.current.branch === allBranches ? allBranches : 'HEAD'
    const result = await resetList(ref, '')
    if (!result) return
    if (result.headHash && graphCommits(result).some(({ hash }) => hash === result.headHash)) {
      void openCommit(result.headHash)
      setFocusHash(result.headHash)
    } else {
      toast({ kind: 'error', title: t('git.headNotLoaded') })
    }
  }

  const navigateRows = (event: KeyboardEvent) => {
    if (!commits.length || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) return
    if (!(event.target instanceof HTMLElement) || event.target.closest('input,select,textarea,[contenteditable="true"],[role="separator"]')) return
    event.preventDefault()
    const focused = event.target.closest<HTMLElement>('[data-history-row]')?.dataset.historyRow
    const index = commits.findIndex(({ hash }) => hash === (focused ?? detail?.hash))
    const next = index < 0
      ? event.key === 'ArrowDown' ? 0 : commits.length - 1
      : Math.min(commits.length - 1, Math.max(0, index + (event.key === 'ArrowDown' ? 1 : -1)))
    selectCommit(commits[next].hash)
  }

  return (
    <dialog ref={dialog} aria-labelledby="git-workspace-title"
      onCancel={(event) => { event.preventDefault(); onClose() }}
      onMouseDown={(event) => { if (event.target === dialog.current) onClose() }}
      className="git-workspace no-drag fixed inset-0 m-auto h-[calc(100vh*2/3)] min-h-[min(460px,calc(100vh-32px))] max-h-[calc(100vh-32px)] w-[calc(100vw*2/3)] min-w-[min(720px,calc(100vw-32px))] max-w-[calc(100vw-32px)] overflow-hidden rounded-2xl bg-surface text-ink shadow-[0_0_0_1px_var(--ring),0_24px_64px_rgba(0,0,0,0.18),0_8px_24px_rgba(0,0,0,0.08)] backdrop:bg-(--scrim)">
      <div className="flex h-full min-h-0 flex-col">
        <header className="flex min-h-13 shrink-0 flex-wrap items-center gap-2 border-b border-hairline bg-surface-2 px-3 py-2">
          <h2 id="git-workspace-title" className="mr-2 flex shrink-0 items-center gap-2 text-[13px] font-semibold">
            <IconBranch size={15} className="text-ink-2" aria-hidden="true" />
            {t('git.historyTab')}
          </h2>
          <label className="relative flex min-w-0 shrink-0 items-center">
            <select aria-label={t('git.graphBranchFilter')} value={branch}
              onChange={(event) => void resetList(event.target.value, currentQuery())}
              className="h-8 max-w-[180px] appearance-none truncate rounded-lg border border-hairline bg-surface pl-2.5 pr-7 text-[12px] text-ink focus-visible:outline-2 focus-visible:outline-accent">
              <option value={allBranches}>{t('git.graphAllBranches')}</option>
              <option value="HEAD">{t('git.graphCurrentBranch')}</option>
              {branches.filter(({ remote }) => remote === null).map(({ name }) => <option key={name} value={`refs/heads/${name}`}>{name}</option>)}
              {branches.filter(({ remote }) => remote !== null).map(({ name }) => <option key={name} value={`refs/remotes/${name}`}>{name}</option>)}
            </select>
            <IconChevronDown size={12} className="pointer-events-none absolute right-2 text-ink-3" aria-hidden="true" />
          </label>
          <label className="flex h-8 min-w-28 max-w-[370px] flex-1 items-center gap-2 rounded-lg border border-hairline bg-surface px-2.5 focus-within:border-accent">
            <IconSearch size={14} className="shrink-0 text-ink-3" aria-hidden="true" />
            <input ref={search} type="search" className="min-w-0 flex-1 bg-transparent text-[12px] outline-none placeholder:text-ink-3"
              placeholder={t('git.searchCommits')} aria-label={t('git.searchCommits')} value={query}
              onChange={(event) => updateSearch(event.target.value)}
              onCompositionStart={() => { composing.current = true; cancelSearch() }}
              onCompositionEnd={(event) => { composing.current = false; updateSearch(event.currentTarget.value) }} />
          </label>
          <div className="ml-auto flex items-center gap-1">
            {remote && <RemoteButtons remote={remote} onRun={(kind) => void syncRemote(kind)} />}
            <button type="button" className={toolbarButton}
              onClick={() => void locateHead()} disabled={!data?.headHash} title={t('git.graphLocateHead')}>
              <IconFocus size={14} aria-hidden="true" />
              <span>{t('git.graphLocateHead')}</span>
            </button>
            <button type="button" className={iconButton} onClick={() => { refreshStatus?.(); void reload() }}
              aria-label={t('git.refreshGraph')} title={t('git.refreshGraph')}>
              <IconRefresh size={15} />
            </button>
            <button type="button" className={iconButton} onClick={onClose} aria-label={t('common.close')} title={t('common.close')}>
              <IconX size={16} aria-hidden="true" />
            </button>
          </div>
        </header>
        {remote && remoteError && <RemoteError result={remoteError} onClose={() => setRemoteError(null)} />}
        <GitHistorySplit inspector={(
          <CommitInspector detail={detail} copiedHash={copiedHash} onCopy={(hash) => void copyHash(hash)} onRetry={(hash) => void openCommit(hash)} />
        )}>
          <div ref={list} className="h-full overflow-auto scroll-pt-[32px]" onKeyDown={navigateRows}
            aria-label={t('git.historyTab')} role="region">
            <div ref={table} style={tableStyle}>
              <div className="sticky top-0 z-10 grid h-[32px] items-center border-b border-hairline bg-surface-2 text-[11px] font-medium text-ink-2" style={{ gridTemplateColumns: columns }}>
                <span className="col-start-2 min-w-0 truncate pl-2">{t('git.graphSubject')}</span>
                {adjustableColumns.map((column) => (
                  <ColumnHeader key={column} column={column} width={widths[column]} table={table} onResize={saveWidth} />
                ))}
              </div>
              {data?.dirty && !data.headHash && !filters.current.query && <WorktreeRow count={data.uncommittedCount} onClick={onViewChanges} />}
              {topology.rows.map((row) => {
                const isHead = row.hash === data?.headHash
                const graph = <GraphRail row={row} head={isHead} width={graphWidth} />
                const commit = byHash.get(row.hash)
                if (!commit) return <WorktreeRow key={row.hash} rail={graph} count={data?.uncommittedCount ?? 0} onClick={onViewChanges} />
                return <HistoryRow key={row.hash} commit={commit} rail={graph} head={isHead} columns={columns}
                  selected={detail?.hash === row.hash} tabIndex={tabStop === row.hash ? 0 : -1} copied={copiedHash === row.hash}
                  onSelect={() => selectCommit(row.hash)} onCopy={() => void copyHash(row.hash)} />
              })}
              {data && !loading && !commits.length && (
                <p className="px-4 py-4 text-[12px] text-ink-2">{t(filters.current.query ? 'git.noMatchingCommits' : 'git.noCommits')}</p>
              )}
              {loadError && <ReadError text={t('git.historyFailed')} detail={loadError}
                onRetry={() => { if (data) loadMore(); else void reload() }} />}
              {!loadError && (loading || data) && (
                <div className="border-t border-hairline px-3 py-2">
                  {loading
                    ? <p role="status" className="flex items-center gap-2 px-2.5 py-1 text-[12px] text-ink-2"><Spinner size={13} />{t('git.loadingHistory')}</p>
                    : data?.hasMore
                      ? <button type="button" className={textButton} onClick={loadMore}>{t('git.graphMore')}</button>
                      : <p role="status" className="px-2.5 py-1 text-[12px] text-ink-3">{t('git.historyAllLoaded')}</p>}
                </div>
              )}
              <div ref={sentinel} className="h-px" aria-hidden="true" />
            </div>
          </div>
        </GitHistorySplit>
        <span className="sr-only" role="status">{copiedHash && t('common.copied')}</span>
      </div>
    </dialog>
  )
}

function RemoteButtons({ remote, onRun }: { remote: RemoteControls; onRun: (kind: RemoteAction) => void }) {
  const { status, pending, disabled, busy } = remote
  return (
    <>
      {syncActions.map(({ kind, Icon, progress }) => {
        const active = pending === kind
        const label = t(kind === 'push' && status?.branch && !status.upstream ? 'git.publish' : `git.${kind}`)
        const count = kind === 'pull' && status && status.behind > 0 ? `↓${status.behind}`
          : kind === 'push' && status && status.ahead > 0 ? `↑${status.ahead}` : ''
        let unavailable = ''
        if (status && kind !== 'fetch' && !status.branch) unavailable = t('git.detachedNoRemote')
        else if (status && kind === 'pull' && !status.upstream) unavailable = t('git.pullNoUpstream')
        const title = busy ? t('git.agentBusy') : active ? t(progress) : unavailable || [label, count].filter(Boolean).join(' ')
        return (
          <span key={kind} className="inline-flex" title={title}>
            <button type="button" className={toolbarButton + ' disabled:pointer-events-none' + (active ? ' disabled:opacity-100!' : '')}
              disabled={!status || disabled || !!unavailable} onClick={() => onRun(kind)}>
              {active ? <Spinner size={13} className="text-accent" /> : <Icon size={14} aria-hidden="true" />}
              <span>{active ? t(progress) : label}</span>
              {!active && count && <span className="text-[10px] tabular-nums text-ink-3">{count}</span>}
            </button>
          </span>
        )
      })}
      <span aria-hidden="true" className="mx-1 h-4 w-px bg-hairline" />
    </>
  )
}

function RemoteError({ result, onClose }: { result: RemoteFailure; onClose: () => void }) {
  const message = result.code === 'busy' ? '' : result.error.split(/\r?\n/)
    .map((line) => line.trim()).filter((line) => line && !line.startsWith('hint:')).slice(0, 4).join('\n').slice(0, 400)
  return (
    <div role="alert" className="flex shrink-0 items-start justify-between gap-2 border-b border-hairline bg-danger/10 px-3 py-2 text-danger">
      <div className="min-w-0">
        <p className="text-[12px] font-medium">{gitErrorTitle(result)}</p>
        {message && <p className="mt-0.5 select-text font-mono text-[11px] wrap-anywhere whitespace-pre-wrap">{message}</p>}
      </div>
      <button type="button" className={iconButton} onClick={onClose} aria-label={t('common.close')} title={t('common.close')}>
        <IconX size={14} aria-hidden="true" />
      </button>
    </div>
  )
}

function ColumnHeader({ column, width, table, onResize }: {
  column: Column
  width: number
  table: RefObject<HTMLDivElement | null>
  onResize: (column: Column, width: number) => void
}) {
  const drag = useRef<{ pointerId: number; startX: number; startWidth: number; width: number } | null>(null)
  const label = t(columnLabels[column])
  const resizeLabel = t('git.resizeColumn')
  const finish = (event: ReactPointerEvent<HTMLDivElement>) => {
    const active = drag.current
    if (!active || active.pointerId !== event.pointerId) return
    drag.current = null
    delete event.currentTarget.dataset.dragging
    onResize(column, active.width)
  }

  return (
    <div className="relative flex h-full min-w-0 items-center">
      <span className="min-w-0 truncate pl-2">{label}</span>
      <div role="separator" aria-orientation="vertical" aria-label={label} title={resizeLabel}
        aria-valuemin={minWidths[column]} aria-valuemax={maxWidth} aria-valuenow={width} tabIndex={0}
        className="group/resize absolute inset-y-0 -left-[3px] z-10 flex w-[6px] touch-none cursor-col-resize items-stretch justify-center focus-visible:outline-none"
        onPointerDown={(event) => {
          if (event.button !== 0 || drag.current) return
          event.preventDefault()
          const handle = event.currentTarget
          handle.focus({ preventScroll: true })
          handle.setPointerCapture(event.pointerId)
          handle.dataset.dragging = 'true'
          drag.current = { pointerId: event.pointerId, startX: event.clientX, startWidth: width, width }
        }}
        onPointerMove={(event) => {
          const active = drag.current
          if (!active || active.pointerId !== event.pointerId) return
          active.width = clampWidth(column, active.startWidth + active.startX - event.clientX)
          table.current?.style.setProperty(`--col-${column}`, `${active.width}px`)
        }}
        onPointerUp={finish} onPointerCancel={finish} onLostPointerCapture={finish}
        onDoubleClick={() => onResize(column, defaultWidths[column])}
        onKeyDown={(event) => {
          if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight' && event.key !== 'Home') return
          event.preventDefault()
          if (drag.current) return
          const value = event.key === 'Home' ? defaultWidths[column] : clampWidth(column, width + (event.key === 'ArrowLeft' ? 8 : -8))
          onResize(column, value)
        }}>
        <span aria-hidden="true" className="w-px group-hover/resize:bg-accent group-focus-visible/resize:bg-accent group-data-[dragging]/resize:bg-accent" />
      </div>
    </div>
  )
}

function GitHistorySplit({ children, inspector }: { children: React.ReactNode; inspector: React.ReactNode }) {
  const [ratio, setRatio] = useState(() => {
    try {
      return clampRatio(Number(localStorage.getItem(splitKey)) || defaultRatio)
    } catch {
      return defaultRatio
    }
  })
  const [dragging, setDragging] = useState(false)
  const split = useRef<HTMLDivElement>(null)
  const pane = useRef<HTMLElement>(null)
  const dragCleanup = useRef<(() => void) | null>(null)
  useEffect(() => () => dragCleanup.current?.(), [])
  const save = (value: number) => {
    try { localStorage.setItem(splitKey, String(value)) } catch { /* Keep the in-memory width. */ }
  }
  const startDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const width = split.current?.clientWidth
    if (event.button !== 0 || !width || !pane.current || dragCleanup.current) return
    event.preventDefault()
    const handle = event.currentTarget
    const { pointerId, clientX } = event
    const startRatio = pane.current.getBoundingClientRect().width / width
    let value = ratio
    const move = (pointer: PointerEvent) => {
      if (pointer.pointerId !== pointerId) return
      value = clampRatio(startRatio + (clientX - pointer.clientX) / width)
      setRatio(value)
    }
    const finish = () => {
      dragCleanup.current?.()
      save(value)
      setDragging(false)
    }
    const endPointer = (pointer: PointerEvent) => {
      if (pointer.pointerId === pointerId) finish()
    }
    handle.setPointerCapture(pointerId)
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', endPointer)
    window.addEventListener('pointercancel', endPointer)
    window.addEventListener('blur', finish)
    dragCleanup.current = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', endPointer)
      window.removeEventListener('pointercancel', endPointer)
      window.removeEventListener('blur', finish)
      dragCleanup.current = null
    }
    setDragging(true)
  }

  return (
    <div ref={split} className={`flex min-h-0 flex-1 ${dragging ? 'cursor-col-resize select-none' : ''}`}>
      <div className="min-w-0 flex-1">{children}</div>
      <div role="separator" aria-orientation="vertical" aria-label={t('git.graphResize')} title={t('git.graphResize')}
        aria-valuemin={25} aria-valuemax={62} aria-valuenow={Math.round(ratio * 100)} tabIndex={0}
        className={`relative z-10 w-1.5 shrink-0 touch-none cursor-col-resize border-l border-hairline hover:bg-accent/20 focus-visible:bg-accent/20 focus-visible:outline-none ${dragging ? 'bg-accent/25' : 'bg-surface-2'}`}
        onPointerDown={startDrag}
        onDoubleClick={() => { setRatio(defaultRatio); save(defaultRatio) }}
        onKeyDown={(event) => {
          if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight' && event.key !== 'Home') return
          event.preventDefault()
          const value = event.key === 'Home' ? defaultRatio : clampRatio(ratio + (event.key === 'ArrowLeft' ? 0.03 : -0.03))
          setRatio(value)
          save(value)
        }} />
      <aside ref={pane} className="min-w-0 shrink-0 overflow-y-auto bg-surface"
        style={{ width: `clamp(min(295px, 42%), ${ratio * 100}%, min(820px, 62%))` }}>
        {inspector}
      </aside>
    </div>
  )
}

function GraphRail({ row, head, width }: { row: GraphRow; head: boolean; width: number }) {
  const x = GRAPH_LEFT_PAD + row.lane * GRAPH_LANE_GAP
  const y = GRAPH_ROW_HEIGHT / 2
  const worktree = row.hash === WORKTREE_NODE
  const color = laneColor(row.color)
  return (
    <svg aria-hidden="true" width={width} height={GRAPH_ROW_HEIGHT} className="block shrink-0">
      {row.lines.map((line, index) => (
        <path key={index} d={graphLinePath(line)} fill="none" stroke={laneColor(line.color)} strokeWidth={2}
          strokeDasharray={line.dashed ? '3 2' : undefined} />
      ))}
      {head && <circle cx={x} cy={y} r={6.25} fill="var(--surface)" stroke={color} strokeWidth={1.25} />}
      <circle cx={x} cy={y} r={worktree ? 4.25 : 3.4} fill={worktree ? 'var(--surface)' : color}
        stroke={worktree ? color : undefined} strokeWidth={worktree ? 1.5 : undefined} strokeDasharray={worktree ? '2.5 1.5' : undefined} />
    </svg>
  )
}

function WorktreeRow({ rail, count, onClick }: { rail?: React.ReactNode; count: number; onClick: () => void }) {
  return (
    <button type="button" data-history-row={WORKTREE_NODE} onClick={onClick}
      className="flex h-[32px] w-full min-w-0 items-center gap-2 text-left text-[12px] hover:bg-black/[0.045] focus-visible:ring-2 focus-visible:ring-accent/55 focus-visible:ring-inset focus-visible:outline-none">
      {rail ?? <span className="w-6 shrink-0" />}
      <span className="shrink-0 font-medium text-ink">{t('git.uncommittedChanges')}</span>
      <span className="min-w-0 truncate text-[11px] text-ink-2">{t('chg.nFiles', { n: count })}</span>
    </button>
  )
}

function HistoryRow({ commit, rail, head, columns, selected, tabIndex, copied, onSelect, onCopy }: {
  commit: GitGraphCommit
  rail: React.ReactNode
  head: boolean
  columns: string
  selected: boolean
  tabIndex: number
  copied: boolean
  onSelect: () => void
  onCopy: () => void
}) {
  const subject = commit.subject || t('git.noCommitSubject')
  const branch = commit.refs.find((ref) => ref.kind === 'branch')
  const tag = commit.refs.find((ref) => ref.kind === 'tag')
  const refs = [...new Set([branch, tag, ...commit.refs].filter((ref) => ref !== undefined))]
    .filter((ref) => ref.kind !== 'head' || !branch)
  const date = new Date(commit.timestamp).toLocaleString(currentLocale())
  return (
    <div data-history-row={commit.hash} style={{ gridTemplateColumns: columns }}
      className={`group grid h-[32px] items-center text-[12px] [box-shadow:inset_0_-1px_var(--hairline)] ${selected ? 'bg-accent/10' : 'hover:bg-black/[0.045]'}`}>
      <button type="button" data-commit={commit.hash} aria-pressed={selected} tabIndex={tabIndex}
        className="col-span-4 grid h-full min-w-0 grid-cols-subgrid items-center overflow-hidden text-left focus-visible:ring-2 focus-visible:ring-accent/55 focus-visible:ring-inset focus-visible:outline-none"
        title={[subject, ...commit.refs.map((ref) => ref.name)].join('\n')} onClick={onSelect}>
        {rail}
        <span className="flex min-w-0 items-center gap-1.5 overflow-hidden whitespace-nowrap pl-2 pr-1">
          {refs.slice(0, 2).map((ref) => (
            <span key={ref.kind + ':' + ref.name} title={ref.name}
              className={`inline-flex max-w-[29%] shrink-0 items-center gap-1 rounded-md px-1 py-0.5 text-[10px] leading-3 ${head && (ref === branch || ref.kind === 'head') ? 'bg-info-soft text-info' : 'bg-black/[0.055] text-ink-2'}`}>
              {ref.kind === 'tag' ? <IconTag size={10} className="shrink-0" aria-hidden="true" /> : <IconBranch size={10} className="shrink-0" aria-hidden="true" />}
              <span className="truncate">{ref.name}</span>
            </span>
          ))}
          {refs.length > 2 && <span className="shrink-0 text-[10px] text-ink-3">+{refs.length - 2}</span>}
          <span className="min-w-0 flex-1 truncate">{subject}</span>
        </span>
        <span className="min-w-0 truncate px-2 text-[11px] text-ink-2" title={commit.author}>{commit.author}</span>
        <time className="min-w-0 truncate px-2 text-[11px] text-ink-2" title={date} dateTime={new Date(commit.timestamp).toISOString()}>{fmtAgo(commit.timestamp)}</time>
      </button>
      <HashButton hash={commit.hash} copied={copied} onCopy={onCopy} className="max-w-full min-w-0 justify-self-start overflow-hidden" tabIndex={tabIndex} />
    </div>
  )
}

function CommitInspector({ detail, copiedHash, onCopy, onRetry }: {
  detail: CommitDetail | null
  copiedHash: string | null
  onCopy: (hash: string) => void
  onRetry: (hash: string) => void
}) {
  const commit = detail?.commit
  return (
    <section aria-label={t('git.commitDetail')}>
      <h3 className="sticky top-0 z-10 flex h-[32px] items-center border-b border-hairline bg-surface-2 px-3 text-[11px] font-medium text-ink-2">
        {t('git.commitDetail')}
      </h3>
      {!detail && <p className="px-4 py-7 text-[12px] text-ink-2">{t('git.graphSelectCommit')}</p>}
      {detail && !commit && !detail.error && <p role="status" className="px-4 py-4 text-[12px] text-ink-2">{t('git.loadingCommitDetail')}</p>}
      {detail?.error && <ReadError text={t('git.commitDetailFailed')} detail={detail.error} onRetry={() => onRetry(detail.hash)} />}
      {commit && (
        <div key={commit.hash}>
          <div className="space-y-2 border-b border-hairline px-3 py-3">
            <h4 className="text-[14px] leading-snug font-semibold wrap-anywhere">{commit.subject || t('git.noCommitSubject')}</h4>
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-ink-2">
              <span className="font-medium" title={commit.email}>{commit.author}</span>
              <time dateTime={new Date(commit.timestamp).toISOString()}>{new Date(commit.timestamp).toLocaleString(currentLocale())} · {fmtAgo(commit.timestamp)}</time>
              <HashButton hash={commit.hash} onCopy={() => onCopy(commit.hash)} copied={copiedHash === commit.hash}
                className="border border-hairline bg-surface-2" />
            </div>
            {commit.body && <p className="select-text text-[12px] leading-relaxed wrap-anywhere whitespace-pre-wrap text-ink-2">{commit.body}</p>}
          </div>
          <div className="p-1.5">
            <div className="flex items-center gap-2 px-1.5 py-1.5 text-[11.5px] text-ink-2">
              <span className="font-medium">{t('chg.nFiles', { n: commit.files.length + (commit.more ?? 0) })}</span>
              <Counts added={commit.added} removed={commit.removed} />
            </div>
            {commit.files.map((file) => <FileRow key={file.path} f={file} />)}
            {!commit.files.length && <p className="px-1.5 py-2 text-[12px] text-ink-2">{t('git.noCommitFiles')}</p>}
            {!!commit.more && <p className="px-1.5 py-2 text-[12px] text-ink-2">{t('chg.more', { n: commit.more })}</p>}
          </div>
        </div>
      )}
    </section>
  )
}

function HashButton({ hash, copied, onCopy, className, tabIndex }: {
  hash: string; copied: boolean; onCopy: () => void; className: string; tabIndex?: number
}) {
  const shortHash = hash.slice(0, 7)
  const label = t('git.copyHash', { hash: shortHash })
  const Icon = copied ? IconCheck : IconCopy
  return (
    <button type="button" className={`group/hash inline-flex h-6 items-center gap-1 rounded-md px-1.5 font-mono text-[11px] text-ink-2 hover:bg-black/[0.055] hover:text-ink ${className}`}
      title={copied ? t('common.copied') : label} aria-label={label} tabIndex={tabIndex} onClick={onCopy}>
      <span className="truncate">{shortHash}</span>
      <Icon size={11} className={copied ? 'shrink-0 text-accent' : 'shrink-0 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 group-hover/hash:opacity-100 group-focus-visible/hash:opacity-100'} aria-hidden="true" />
    </button>
  )
}

function ReadError({ text, detail, onRetry }: { text: string; detail: string; onRetry: () => void }) {
  return (
    <div className="flex items-center justify-between gap-2 px-3 py-3 text-[12px]">
      <p role="status" className="text-ink-2" title={detail}>{text}</p>
      <button type="button" className={textButton} onClick={onRetry}>{t('git.retryHistory')}</button>
    </div>
  )
}
