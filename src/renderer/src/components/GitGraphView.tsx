import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react'
import type { GitBranch, GitCommitDetail, GitGraphCommit, GitGraphData } from '@shared/types'
import { useLayer } from '../lib/escStack'
import {
  appendGraphPage, getGraphNodes, graphCommits, graphLinePath, layoutGitGraph, matchesGitCommit,
  GRAPH_LANE_GAP, GRAPH_LEFT_PAD, GRAPH_ROW_HEIGHT, WORKTREE_NODE, type GraphRow
} from '../lib/gitGraph'
import { useApp } from '../state/AppContext'
import { currentLocale, fmtAgo, t } from '../state/i18n'
import { Counts, FileRow } from './ChangesPanel'
import { IconBranch, IconCheck, IconChevronDown, IconCopy, IconFocus, IconRefresh, IconSearch, IconTag, IconX, Spinner } from './icons'

type CommitDetail = { hash: string; commit?: GitCommitDetail; error?: string }

const allBranches = '__ALL__'
const splitKey = 'agentswitch.gitGraph.inspectorRatio'
const defaultRatio = 0.35
const minRatio = 0.25
const maxRatio = 0.62
const clampRatio = (ratio: number) => Math.min(maxRatio, Math.max(minRatio, ratio))
const iconButton = 'grid size-8 shrink-0 place-items-center rounded-lg text-ink-2 hover:bg-black/[0.06] hover:text-ink disabled:opacity-40'
const textButton = 'rounded-md px-2.5 py-1 text-[12px] font-medium text-ink-2 hover:bg-black/[0.06] hover:text-ink disabled:opacity-45'
const laneColor = (color: number) => `var(--git-lane-${color % 6})`

export function GitGraphView({ dir, onClose, onViewChanges }: {
  dir: string
  onClose: () => void
  onViewChanges: () => void
}) {
  const { toast } = useApp()
  const dialog = useRef<HTMLDialogElement>(null)
  const list = useRef<HTMLDivElement>(null)
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
  const graphRequest = useRef(0)
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

  const loadPage = useCallback(async (skip: number, ref: string) => {
    const request = ++graphRequest.current
    if (!skip) setData(null)
    setLoading(true)
    setLoadError('')
    try {
      const result = await window.agentswitch.git.graph(dir, { branch: ref, skip })
      if (request !== graphRequest.current) return null
      if (!result.ok) {
        setLoadError(result.error)
        return null
      }
      setData((previous) => skip && previous ? appendGraphPage(previous, result) : result)
      setBranches(result.branches)
      return result
    } catch (error) {
      if (request === graphRequest.current) setLoadError(String(error))
      return null
    } finally {
      if (request === graphRequest.current) setLoading(false)
    }
  }, [dir])

  useEffect(() => {
    let active = true
    queueMicrotask(() => { if (active) void loadPage(0, allBranches) })
    return () => {
      active = false
      graphRequest.current++
      detailRequest.current++
      copyRequest.current++
    }
  }, [loadPage])

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

  const resetList = (ref: string) => {
    detailRequest.current++
    setDetail(null)
    setFocusHash(null)
    list.current?.scrollTo(0, 0)
    return loadPage(0, ref)
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
  const visible = useMemo(() => commits.filter((commit) => matchesGitCommit(commit, query)), [commits, query])
  const byHash = useMemo(() => new Map(visible.map((commit) => [commit.hash, commit])), [visible])
  const topology = useMemo(
    () => layoutGitGraph(getGraphNodes(visible, data?.headHash ?? null, data?.dirty ?? false)),
    [visible, data?.headHash, data?.dirty]
  )
  const graphWidth = GRAPH_LEFT_PAD * 2 + (topology.laneCount - 1) * GRAPH_LANE_GAP
  const columns = `${graphWidth}px minmax(145px, 1fr) 96px 78px 80px`
  const tabStop = detail && byHash.has(detail.hash) ? detail.hash : visible[0]?.hash

  useLayoutEffect(() => {
    if (!focusHash) return
    const row = list.current?.querySelector<HTMLButtonElement>(`[data-commit="${focusHash}"]`)
    if (!row) return
    row.focus({ preventScroll: true })
    row.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    setFocusHash(null)
  }, [focusHash, visible])

  const selectCommit = (hash: string) => {
    if (hash !== detail?.hash) void openCommit(hash)
    setFocusHash(hash)
  }
  const locateHead = async () => {
    if (!data?.headHash) return
    setQuery('')
    if (commits.some((commit) => commit.hash === data.headHash)) {
      selectCommit(data.headHash)
      return
    }
    setBranch('HEAD')
    const result = await resetList('HEAD')
    if (result?.headHash) {
      void openCommit(result.headHash)
      setFocusHash(result.headHash)
    }
  }

  const navigateRows = (event: KeyboardEvent) => {
    if (!visible.length || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) return
    if (!(event.target instanceof HTMLElement) || event.target.closest('input,select,textarea,[contenteditable="true"]')) return
    event.preventDefault()
    const focused = event.target.closest<HTMLElement>('[data-history-row]')?.dataset.historyRow
    const index = visible.findIndex(({ hash }) => hash === (focused ?? detail?.hash))
    const next = index < 0
      ? event.key === 'ArrowDown' ? 0 : visible.length - 1
      : Math.min(visible.length - 1, Math.max(0, index + (event.key === 'ArrowDown' ? 1 : -1)))
    selectCommit(visible[next].hash)
  }

  return (
    <dialog ref={dialog} aria-labelledby="git-workspace-title"
      onCancel={(event) => { event.preventDefault(); onClose() }}
      onMouseDown={(event) => { if (event.target === dialog.current) onClose() }}
      className="git-workspace no-drag fixed inset-0 m-auto h-[min(640px,calc(100vh-88px))] max-h-none w-[min(1000px,calc(100vw-64px))] max-w-none overflow-hidden rounded-2xl bg-surface text-ink shadow-[0_0_0_1px_var(--ring),0_24px_64px_rgba(0,0,0,0.18),0_8px_24px_rgba(0,0,0,0.08)] backdrop:bg-(--scrim) backdrop:backdrop-blur-md">
      <div className="flex h-full min-h-0 flex-col">
        <header className="flex min-h-13 shrink-0 flex-wrap items-center gap-2 border-b border-hairline bg-surface-2 px-3 py-2">
          <h2 id="git-workspace-title" className="mr-2 flex shrink-0 items-center gap-2 text-[13px] font-semibold">
            <IconBranch size={15} className="text-ink-2" aria-hidden="true" />
            {t('git.historyTab')}
          </h2>
          <label className="relative flex min-w-0 shrink-0 items-center">
            <select aria-label={t('git.graphBranchFilter')} value={branch}
              onChange={(event) => { setBranch(event.target.value); void resetList(event.target.value) }}
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
              placeholder={t('git.searchCommits')} aria-label={t('git.searchCommits')} value={query} onChange={(event) => setQuery(event.target.value)} />
          </label>
          <div className="ml-auto flex items-center gap-1">
            <button type="button" className="flex h-8 shrink-0 items-center gap-1.5 rounded-lg px-2 text-[12px] text-ink-2 hover:bg-black/[0.06] hover:text-ink disabled:opacity-40"
              onClick={() => void locateHead()} disabled={!data?.headHash || loading} title={t('git.graphLocateHead')}>
              <IconFocus size={14} aria-hidden="true" />
              <span>{t('git.graphLocateHead')}</span>
            </button>
            <button type="button" className={iconButton} onClick={() => void resetList(branch)} disabled={loading}
              aria-label={t('git.refreshGraph')} title={t('git.refreshGraph')}>
              {loading ? <Spinner size={14} /> : <IconRefresh size={15} />}
            </button>
            <button type="button" className={iconButton} onClick={onClose} aria-label={t('common.close')} title={t('common.close')}>
              <IconX size={16} aria-hidden="true" />
            </button>
          </div>
        </header>
        <GitHistorySplit inspector={(
          <CommitInspector detail={detail} copiedHash={copiedHash} onCopy={(hash) => void copyHash(hash)} onRetry={(hash) => void openCommit(hash)} />
        )}>
          <div ref={list} className="h-full overflow-auto scroll-pt-[32px]" onKeyDown={navigateRows}
            aria-label={t('git.historyTab')} role="region">
            <div style={{ minWidth: graphWidth + 399 }}>
              <div className="sticky top-0 z-10 grid h-[32px] items-center border-b border-hairline bg-surface-2 text-[11px] font-medium text-ink-2" style={{ gridTemplateColumns: columns }}>
                <span className="col-start-2 pl-2">{t('git.graphSubject')}</span>
                <span className="pl-2">{t('git.graphAuthor')}</span>
                <span className="pl-2">{t('git.graphDate')}</span>
                <span className="pl-2">{t('git.graphHash')}</span>
              </div>
              {data?.dirty && !data.headHash && <WorktreeRow count={data.uncommittedCount} onClick={onViewChanges} />}
              {topology.rows.map((row) => {
                const isHead = row.hash === data?.headHash
                const graph = <GraphRail row={row} head={isHead} width={graphWidth} />
                const commit = byHash.get(row.hash)
                if (!commit) return <WorktreeRow key={row.hash} rail={graph} count={data?.uncommittedCount ?? 0} onClick={onViewChanges} />
                return <HistoryRow key={row.hash} commit={commit} rail={graph} head={isHead} columns={columns}
                  selected={detail?.hash === row.hash} tabIndex={tabStop === row.hash ? 0 : -1} copied={copiedHash === row.hash}
                  onSelect={() => selectCommit(row.hash)} onCopy={() => void copyHash(row.hash)} />
              })}
              {!data && loading && <p role="status" className="px-4 py-5 text-[12px] text-ink-2">{t('git.loadingHistory')}</p>}
              {data && !visible.length && (
                <p className="px-4 py-4 text-[12px] text-ink-2">{t(commits.length ? 'git.noMatchingCommits' : 'git.noCommits')}</p>
              )}
              {loadError && <ReadError text={t('git.historyFailed')} detail={loadError}
                onRetry={() => void (data ? loadPage(data.nextSkip, branch) : resetList(branch))} />}
              {data?.hasMore && !loadError && (
                <div className="border-t border-hairline px-3 py-2">
                  <button type="button" className={textButton} disabled={loading} onClick={() => void loadPage(data.nextSkip, branch)}>
                    {loading ? t('git.loadingHistory') : t('git.graphMore')}
                  </button>
                </div>
              )}
            </div>
          </div>
        </GitHistorySplit>
        <span className="sr-only" role="status">{copiedHash && t('common.copied')}</span>
      </div>
    </dialog>
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
        <span className="flex min-w-0 items-center gap-1.5 pl-2 pr-1">
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
        <time className="truncate px-2 text-[11px] text-ink-2" title={date} dateTime={new Date(commit.timestamp).toISOString()}>{fmtAgo(commit.timestamp)}</time>
      </button>
      <HashButton hash={commit.hash} copied={copied} onCopy={onCopy} className="justify-self-start" tabIndex={tabIndex} />
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
      {shortHash}
      <Icon size={11} className={copied ? 'text-accent' : 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 group-hover/hash:opacity-100 group-focus-visible/hash:opacity-100'} aria-hidden="true" />
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
