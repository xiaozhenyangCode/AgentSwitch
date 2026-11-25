import { GitLog, type Commit } from '@tomplum/react-git-log'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { GitCommitDetail, GitCommitFile, GitGraphCommit, GitGraphData } from '@shared/types'
import { CHECKED_OUT_LANE, matchesGitCommit, toGitGraphEntries, WORKTREE_NODE } from '../lib/gitGraph'
import { useApp } from '../state/AppContext'
import { fmtAgo, t } from '../state/i18n'
import { useTheme } from '../state/theme'
import { IconCheck, IconRefresh, IconX, Spinner } from './icons'

type Result<T> = { kind: 'loading' } | { kind: 'ready'; data: T } | { kind: 'error'; detail: string }

const iconButton = 'grid size-7 shrink-0 place-items-center rounded-lg text-ink-2 hover:bg-black/[0.05] hover:text-ink disabled:opacity-45'
const smallButton = 'rounded-md px-2 py-1 text-[12px] text-ink-2 hover:bg-black/[0.05] hover:text-ink'

export function GitGraphView({ dir, onViewChanges, renderFile }: {
  dir: string
  onViewChanges: () => void
  renderFile: (file: GitCommitFile) => ReactNode
}) {
  const { toast } = useApp()
  const { dark } = useTheme()
  const [query, setQuery] = useState('')
  const [reload, setReload] = useState(0)
  const [graph, setGraph] = useState<Result<GitGraphData>>({ kind: 'loading' })
  const [detail, setDetail] = useState<{ hash: string; result: Result<GitCommitDetail> } | null>(null)
  const [copiedHash, setCopiedHash] = useState<string | null>(null)
  const detailRequest = useRef(0)
  const copyRequest = useRef(0)
  const graphSelection = useRef<string | null>(null)

  useEffect(() => {
    let active = true
    const load = async () => {
      try {
        const result = await window.agentswitch.git.graph(dir)
        if (!active) return
        setGraph(result.ok ? { kind: 'ready', data: result } : { kind: 'error', detail: result.error })
      } catch (error) {
        if (active) setGraph({ kind: 'error', detail: String(error) })
      }
    }
    // Strict Mode may clean up the probe mount before starting the request.
    void Promise.resolve().then(() => { if (active) void load() })
    return () => { active = false }
  }, [dir, reload])

  useEffect(() => () => {
    detailRequest.current++
    copyRequest.current++
  }, [dir])

  const closeDetail = () => {
    detailRequest.current++
    setDetail(null)
  }
  const refresh = () => {
    closeDetail()
    graphSelection.current = null
    setGraph({ kind: 'loading' })
    setReload((count) => count + 1)
  }
  const openCommit = async (hash: string) => {
    if (hash === WORKTREE_NODE) {
      onViewChanges()
      return
    }
    const request = ++detailRequest.current
    setDetail({ hash, result: { kind: 'loading' } })
    try {
      const result = await window.agentswitch.git.commitDetail(dir, hash)
      if (request !== detailRequest.current) return
      setDetail({ hash, result: result.ok ? { kind: 'ready', data: result.commit } : { kind: 'error', detail: result.error } })
    } catch (error) {
      if (request === detailRequest.current) setDetail({ hash, result: { kind: 'error', detail: String(error) } })
    }
  }
  const selectGraphCommit = (commit?: Commit) => {
    if (commit) graphSelection.current = commit.hash
    // The library sends undefined when clicking the same node twice.
    const hash = graphSelection.current
    if (hash && hash !== detail?.hash) void openCommit(hash)
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

  const data = graph.kind === 'ready' ? graph.data : null
  const entries = useMemo(() => data ? toGitGraphEntries(data) : [], [data])
  const commits = useMemo(() => new Map(data?.commits.map((commit) => [commit.hash, commit])), [data])
  const matching = useMemo(() => {
    const hashes = new Set(data?.commits.filter((commit) => matchesGitCommit(commit, query)).map((commit) => commit.hash))
    if (data?.dirty) hashes.add(WORKTREE_NODE)
    return hashes
  }, [data, query])
  const filter = useMemo(() => (rows: Commit[]) => rows.filter(({ hash }) => matching.has(hash)), [matching])
  const noMatchingCommits = matching.size === (data?.dirty ? 1 : 0)

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-hairline px-3 py-2">
        <input className="min-w-0 flex-1 rounded-lg border border-hairline bg-surface px-2.5 py-1.5 text-[12px] text-ink outline-none focus:border-accent"
          placeholder={t('git.searchCommits')} aria-label={t('git.searchCommits')} value={query} onChange={(event) => setQuery(event.target.value)} />
        <button type="button" className={iconButton} onClick={refresh} disabled={graph.kind === 'loading'}
          title={t('git.refreshGraph')} aria-label={t('git.refreshGraph')}>
          {graph.kind === 'loading' ? <Spinner size={13} /> : <IconRefresh size={14} />}
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2">
        {graph.kind === 'loading' && <p role="status" className="px-2 py-5 text-[12px] text-ink-2">{t('git.loadingHistory')}</p>}
        {graph.kind === 'error' && <ReadError text={t('git.historyFailed')} detail={graph.detail} onRetry={refresh} />}
        {data && matching.size > 0 && (
          <GitLog entries={entries} currentBranch={CHECKED_OUT_LANE} theme={dark ? 'dark' : 'light'}
            colours={dark ? 'neon-aurora-dark' : 'neon-aurora-light'} showGitIndex={false} defaultGraphWidth={36}
            classes={{ containerClass: 'commit-graph', containerStyles: { height: 'auto' } }}
            enableSelectedCommitStyling={false} enablePreviewedCommitStyling={false}
            filter={filter} onSelectCommit={selectGraphCommit}>
            <GitLog.GraphHTMLGrid nodeSize={12} node={({ commit, nodeSize, colour }: { commit: Commit; nodeSize: number; colour: string }) =>
              commit.hash === WORKTREE_NODE
                ? <span className="z-20 rounded-full border-2 border-dashed bg-surface" style={{ width: nodeSize, height: nodeSize, borderColor: colour }} />
                : undefined
            } />
            <GitLog.Table styles={{ table: { minWidth: 0 } }} row={({ commit }) => {
              const entry = commits.get(commit.hash)
              if (!entry) {
                return (
                  <button type="button" className="flex h-10 w-full min-w-0 items-center gap-2 rounded-md px-2 text-left text-[12px] hover:bg-black/[0.05]"
                    onClick={onViewChanges}>
                    <span className="min-w-0 flex-1 truncate font-medium text-ink">{t('git.uncommittedChanges')}</span>
                    <span className="shrink-0 text-[11px] text-ink-2">{t('chg.nFiles', { n: data.uncommittedCount })}</span>
                  </button>
                )
              }
              return <CommitRow commit={entry} selected={detail?.hash === entry.hash} copied={copiedHash === entry.hash}
                onOpen={() => void openCommit(entry.hash)} onCopy={() => void copyHash(entry.hash)} />
            }} />
          </GitLog>
        )}
        {data && noMatchingCommits && (
          <p className="px-2 py-4 text-[12px] text-ink-2">{t(data.commits.length ? 'git.noMatchingCommits' : 'git.noCommits')}</p>
        )}
      </div>
      <span className="sr-only" role="status">{copiedHash && t('common.copied')}</span>
      {detail && (
        <section className="flex max-h-[55%] min-h-0 shrink-0 flex-col border-t border-hairline bg-surface/80" aria-label={t('git.commitDetail')}>
          <header className="flex shrink-0 items-center justify-between px-3 py-1">
            <h3 className="text-[12px] font-semibold text-ink">{t('git.commitDetail')}</h3>
            <button type="button" className={iconButton} onClick={closeDetail} title={t('common.close')} aria-label={t('common.close')}>
              <IconX size={13} />
            </button>
          </header>
          <div key={detail.hash} className="min-h-0 overflow-y-auto px-2 pb-2">
            {detail.result.kind === 'loading' && <p role="status" className="px-2 pb-2 text-[12px] text-ink-2">{t('git.loadingCommitDetail')}</p>}
            {detail.result.kind === 'error' && (
              <ReadError text={t('git.commitDetailFailed')} detail={detail.result.detail} onRetry={() => void openCommit(detail.hash)} />
            )}
            {detail.result.kind === 'ready' && (
              <CommitDetail commit={detail.result.data} copied={copiedHash === detail.hash}
                onCopy={() => void copyHash(detail.hash)} renderFile={renderFile} />
            )}
          </div>
        </section>
      )}
    </div>
  )
}

function CommitRow({ commit, selected, copied, onOpen, onCopy }: {
  commit: GitGraphCommit
  selected: boolean
  copied: boolean
  onOpen: () => void
  onCopy: () => void
}) {
  const subject = commit.subject || t('git.noCommitSubject')
  const branch = commit.refs.find((ref) => ref.kind === 'branch')
  const tag = commit.refs.find((ref) => ref.kind === 'tag')
  const visibleRefs = [...new Set([branch, tag, ...commit.refs])].filter((ref) => ref !== undefined).slice(0, 2)
  return (
    <div className={`flex h-10 min-w-0 flex-col justify-center rounded-md px-2 ${selected ? 'bg-accent/10' : 'hover:bg-black/[0.05]'}`}>
      <button type="button" aria-pressed={selected} className="flex min-w-0 items-center gap-1.5 text-left text-[12px] text-ink"
        title={[subject, ...commit.refs.map((ref) => ref.name)].join('\n')} onClick={onOpen}>
        {visibleRefs.map((ref) => (
          <span key={ref.kind + ':' + ref.name}
            className={`max-w-[30%] shrink-0 truncate rounded px-1 text-[10px] leading-3.5 ${ref.kind === 'tag' ? 'bg-warn-soft text-warn' : 'bg-info-soft text-info'}`}>
            {ref.name}
          </span>
        ))}
        {commit.refs.length > visibleRefs.length && <span className="shrink-0 text-[10px] text-ink-2">+{commit.refs.length - visibleRefs.length}</span>}
        <span className="min-w-0 flex-1 truncate">{subject}</span>
      </button>
      <div className="flex min-w-0 items-center gap-1.5 text-[11px] leading-4 text-ink-2">
        <HashButton hash={commit.hash} label={commit.shortHash} copied={copied} onCopy={onCopy} />
        <span className="min-w-0 truncate" title={commit.author}>{commit.author}</span>
        <span className="shrink-0">{fmtAgo(commit.timestamp)}</span>
      </div>
    </div>
  )
}

function CommitDetail({ commit, copied, onCopy, renderFile }: {
  commit: GitCommitDetail
  copied: boolean
  onCopy: () => void
  renderFile: (file: GitCommitFile) => ReactNode
}) {
  return (
    <>
      <div className="min-w-0 space-y-1.5 border-b border-hairline px-2 pb-2">
        <h4 className="text-[13px] font-semibold wrap-anywhere text-ink">{commit.subject || t('git.noCommitSubject')}</h4>
        <div className="flex min-w-0 items-center gap-1.5 text-[11px] text-ink-2">
          <span className="min-w-0 truncate" title={commit.email}>{commit.author}</span>
          <span className="shrink-0">{fmtAgo(commit.timestamp)}</span>
        </div>
        <HashButton hash={commit.hash} label={commit.hash} copied={copied} onCopy={onCopy} full />
        {commit.body && <p className="select-text text-[12px] wrap-anywhere whitespace-pre-wrap text-ink-2">{commit.body}</p>}
      </div>
      {commit.files.length ? commit.files.map(renderFile) : <p className="px-2 py-2 text-[12px] text-ink-2">{t('git.noCommitFiles')}</p>}
      {!!commit.more && <p className="px-2 py-2 text-[12px] text-ink-2">{t('chg.more', { n: commit.more })}</p>}
    </>
  )
}

function HashButton({ hash, label, copied, onCopy, full = false }: {
  hash: string; label: string; copied: boolean; onCopy: () => void; full?: boolean
}) {
  const copyLabel = t('git.copyHash', { hash })
  return (
    <button type="button" className={`inline-flex min-w-0 shrink-0 items-center gap-1 rounded px-1 font-mono text-[11px] text-ink-2 hover:bg-black/[0.05] ${full ? 'max-w-full' : 'max-w-[37%]'}`}
      title={copied ? t('common.copied') : copyLabel} aria-label={copyLabel}
      onClick={(event) => { event.stopPropagation(); onCopy() }}>
      <span className="truncate">{label}</span>
      {copied && <IconCheck size={11} className="shrink-0 text-accent" />}
    </button>
  )
}

function ReadError({ text, detail, onRetry }: { text: string; detail: string; onRetry: () => void }) {
  return (
    <div className="flex items-center justify-between gap-2 px-2 py-2 text-[12px]">
      <p role="status" className="text-ink-2" title={detail}>{text}</p>
      <button type="button" className={smallButton} onClick={onRetry}>{t('git.retryHistory')}</button>
    </div>
  )
}
