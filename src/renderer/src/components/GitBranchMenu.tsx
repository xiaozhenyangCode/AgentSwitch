import { useEffect, useRef, useState } from 'react'
import type { GitBranch, GitCommit, GitMutation, GitStatus } from '@shared/types'
import { useEscape } from '../lib/escStack'
import { useApp } from '../state/AppContext'
import { fmtAgo, t } from '../state/i18n'
import type { RunGit } from '../state/useProjectGit'
import { Segmented } from './common'
import { IconArrowUp, IconBranch, IconCheck, IconChevronDown, IconDownload, IconRefresh, Spinner } from './icons'

const item = 'flex min-h-8 w-full min-w-0 items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[12px] text-ink hover:bg-black/[0.05] dark:hover:bg-white/[0.07] disabled:opacity-45'
export const gitInput = 'w-full min-w-0 rounded-lg border border-hairline bg-surface px-2.5 py-1.5 text-[12px] text-ink outline-none focus:border-accent'

export function gitBranchLabel(status: Extract<GitStatus, { repo: true }>) {
  return status.branch ?? (status.detached ? `HEAD@${status.detached}` : 'HEAD')
}

function invalidBranchName(name: string) {
  return name === 'HEAD' || /^-|[\s\x00-\x1f\x7f~^:?*\[\\]|\.\.|@\{|\.$/.test(name) ||
    name.split('/').some((part) => !part || part.startsWith('.') || part.endsWith('.lock'))
}

const syncActions = [
  { kind: 'fetch', Icon: IconRefresh, progress: 'git.fetching' },
  { kind: 'pull', Icon: IconDownload, progress: 'git.pulling' },
  { kind: 'push', Icon: IconArrowUp, progress: 'git.pushing' }
] as const

type View = 'branches' | 'commits'
type CommitLog = { kind: 'loading' } | { kind: 'ready'; commits: GitCommit[] } | { kind: 'error'; detail: string }

export function GitBranchMenu({ dir, status, disabled, busy, pending, run, onViewChanges, onViewHistory }: {
  dir: string
  status: Extract<GitStatus, { repo: true }>
  disabled: boolean
  busy: boolean
  pending: GitMutation['kind'] | null
  run: RunGit
  onViewChanges: () => void
  onViewHistory: () => void
}) {
  const { toast } = useApp()
  const [open, setOpen] = useState(false)
  const [view, setView] = useState<View>('branches')
  const [query, setQuery] = useState('')
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const [serverInvalid, setServerInvalid] = useState(false)
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  const [commitLog, setCommitLog] = useState<CommitLog>({ kind: 'loading' })
  const [copiedHash, setCopiedHash] = useState<string | null>(null)
  const logRequest = useRef(0)
  const ref = useRef<HTMLDivElement>(null)
  const search = useRef<HTMLInputElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const leaveCreate = () => {
    setCreating(false)
    setName('')
    setServerInvalid(false)
  }
  const close = () => {
    logRequest.current++
    setOpen(false)
    setView('branches')
    setQuery('')
    leaveCreate()
  }

  const loadCommitLog = async () => {
    const request = ++logRequest.current
    setCommitLog({ kind: 'loading' })
    setCopiedHash(null)
    try {
      const result = await window.agentswitch.git.log(dir)
      if (request !== logRequest.current) return
      setCommitLog(result.ok ? { kind: 'ready', commits: result.commits } : { kind: 'error', detail: result.error })
    } catch (error) {
      if (request === logRequest.current) setCommitLog({ kind: 'error', detail: String(error) })
    }
  }

  const selectView = (next: View) => {
    if (next === view) return
    setView(next)
    setQuery('')
    if (creating) search.current?.focus()
    leaveCreate()
    if (next === 'commits') void loadCommitLog()
    else logRequest.current++
  }

  const copyHash = async (commit: GitCommit) => {
    const request = logRequest.current
    const hash = commit.hash || commit.shortHash
    try {
      await window.agentswitch.sys.copy(hash)
      if (request === logRequest.current) setCopiedHash(hash)
    } catch {
      if (request === logRequest.current) toast({ kind: 'error', title: t('git.copyHashFailed') })
    }
  }

  useEscape(() => {
    if (creating) {
      leaveCreate()
      search.current?.focus()
    } else {
      close()
      trigger.current?.focus()
    }
  }, open)
  useEffect(() => {
    if (!open) return
    const down = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) close()
    }
    window.addEventListener('mousedown', down)
    return () => window.removeEventListener('mousedown', down)
  }, [open])

  const branchLabel = gitBranchLabel(status)
  const filter = query.trim().toLowerCase()
  const branches = status.branches.filter((branch) => branch.name.toLowerCase().includes(filter))
  const locals = branches.filter((branch) => branch.remote === null)
  const localNames = new Set(status.branches.filter((branch) => branch.remote === null).map((branch) => branch.name))
  const remotes = new Map<string, GitBranch[]>()
  for (const branch of branches) {
    if (branch.remote === null) continue
    const group = remotes.get(branch.remote) ?? []
    group.push(branch)
    remotes.set(branch.remote, group)
  }

  const renderBranch = (branch: GitBranch) => {
    const localName = branch.remote === null ? branch.name : branch.name.slice(branch.remote.length + 1)
    const alreadyLocal = branch.remote !== null && localNames.has(localName)
    const active = branch.remote === null && branch.name === status.branch
    const label = alreadyLocal ? `${branch.name} · ${t('git.alreadyLocal')}` : branch.name
    return (
      <button key={branch.name} className={item} disabled={disabled || active} title={busy ? t('git.agentBusy') : label} onClick={() => {
        void run({ kind: 'switch', name: alreadyLocal ? localName : branch.name, remote: alreadyLocal ? null : branch.remote }).then((result) => {
          if (result.ok) close()
        })
      }}>
        <span className="min-w-0 flex-1 truncate">{branch.name}</span>
        {alreadyLocal && <span className="shrink-0 text-[10px] text-ink-3">{t('git.alreadyLocal')}</span>}
        {active && <IconCheck size={14} className="shrink-0 text-accent" />}
      </button>
    )
  }

  const renderCommitLog = () => {
    if (commitLog.kind === 'loading') {
      return <div role="status" className="flex items-center gap-1.5 px-2.5 py-1 text-[12px] text-ink-3"><Spinner size={13} />{t('git.loadingHistory')}</div>
    }
    if (commitLog.kind === 'error') {
      return (
        <div className="flex items-center gap-1.5 px-2.5 py-1 text-[12px]">
          <span role="status" className="min-w-0 flex-1 text-ink-2" title={commitLog.detail}>{t('git.historyFailed')}</span>
          <button type="button" className={item + ' w-auto shrink-0'} onClick={() => void loadCommitLog()}>{t('git.retryHistory')}</button>
        </div>
      )
    }
    const matches = commitLog.commits.filter((commit) =>
      [commit.subject, commit.shortHash, commit.sha, commit.hash, commit.author].some((field) => field.toLowerCase().includes(filter))
    )
    if (!matches.length) {
      return <div className="px-2.5 py-1 text-[12px] text-ink-3">{t(commitLog.commits.length ? 'git.noMatchingCommits' : 'git.noCommits')}</div>
    }
    return matches.map((commit) => {
      const hash = commit.hash || commit.shortHash
      const copied = copiedHash === hash
      const copyLabel = t('git.copyHash', { hash: commit.shortHash })
      return (
        <div key={hash} className="min-w-0 border-b border-hairline px-2.5 py-1.5 last:border-0">
          <div className="truncate text-[12px] text-ink" title={commit.subject}>{commit.subject || t('git.noCommitSubject')}</div>
          <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[11px] text-ink-3">
            <button type="button" aria-label={copyLabel} title={copied ? t('common.copied') : copyLabel}
              className="inline-flex h-5 max-w-[40%] shrink-0 items-center gap-1 rounded px-1 font-mono text-ink-2 hover:bg-black/[0.05] hover:text-ink dark:hover:bg-white/[0.07]"
              onClick={() => void copyHash(commit)}>
              <span className="min-w-0 truncate">{commit.shortHash}</span>
              {copied && <IconCheck size={12} aria-hidden="true" className="shrink-0 text-accent" />}
            </button>
            <span className="min-w-0 truncate" title={commit.author}>{commit.author}</span>
            <span className="shrink-0">{fmtAgo(commit.timestamp)}</span>
          </div>
        </div>
      )
    })
  }

  const invalid = !!name && (serverInvalid || invalidBranchName(name))
  const networkAction = syncActions.find((action) => action.kind === pending)
  const progressLabel = networkAction && t(networkAction.progress)
  const searchLabel = t(view === 'commits' ? 'git.searchCommits' : 'git.search')

  return (
    <div ref={ref} className="ml-1 flex min-w-0 max-w-[55%] shrink-0">
      <button ref={trigger} type="button" aria-expanded={open} aria-label={`${t('git.branch')} ${branchLabel}`}
        title={[branchLabel, status.upstream, progressLabel].filter(Boolean).join(' · ')}
        className="flex h-7 min-w-0 items-center gap-1.5 rounded-lg px-2 text-[12.5px] text-ink hover:bg-black/[0.05] dark:hover:bg-white/[0.07]"
        onClick={() => open ? close() : setOpen(true)}>
        {progressLabel ? <Spinner size={13} className="shrink-0 text-accent" /> : <IconBranch size={14} className="shrink-0 text-accent" />}
        <span className="truncate font-medium">{branchLabel}</span>
        {status.dirty && <span className="size-1.5 shrink-0 rounded-full bg-warn" title={t('git.dirty')} aria-label={t('git.dirty')} />}
        {status.upstream && !!(status.ahead || status.behind) && (
          <span className="shrink-0 text-[11px] tabular-nums text-ink-3" title={status.upstream}>
            {status.ahead > 0 && `↑${status.ahead}`}{status.ahead > 0 && status.behind > 0 && ' '}{status.behind > 0 && `↓${status.behind}`}
          </span>
        )}
        <IconChevronDown size={12} className="shrink-0 text-ink-3" />
      </button>
      <span className="sr-only" role="status">{progressLabel}</span>
      {open && (
        <div className="absolute bottom-full right-0 z-30 mb-1.5 w-[340px] max-w-full rounded-2xl bg-surface/95 p-1.5 shadow-[0_0_0_1px_var(--ring),0_12px_40px_rgba(0,0,0,0.16)] backdrop-blur-xl">
          <Segmented size="sm" value={view} onChange={selectView} options={[
            { value: 'branches', label: t('git.branchesTab') },
            { value: 'commits', label: t('git.commitsTab') }
          ]} />
          <div className="mt-1.5 flex items-center gap-1">
            <input ref={search} autoFocus className={gitInput + ' flex-1'} value={query} onChange={(e) => setQuery(e.target.value)} placeholder={searchLabel} aria-label={searchLabel} />
            {view === 'commits' && (
              <button type="button" className={item + ' w-auto shrink-0'} disabled={commitLog.kind === 'loading'}
                aria-label={t('common.refresh')} title={t('common.refresh')} onClick={() => void loadCommitLog()}>
                <IconRefresh size={14} aria-hidden="true" />
              </button>
            )}
          </div>
          <div key={view} className="max-h-[min(230px,30vh)] overflow-y-auto py-1">
            {view === 'commits' ? renderCommitLog() : (
              <>
                {locals.length > 0 && <div className="px-2.5 py-1 text-[11px] text-ink-3">{t('git.local')}</div>}
                {locals.map(renderBranch)}
                {[...remotes].map(([remote, group]) => {
                  const show = !!filter || expanded.has(remote)
                  return (
                    <div key={remote}>
                      <button className={item + ' text-ink-3!'} aria-expanded={show} title={t('git.remote', { name: remote })} onClick={() => setExpanded((previous) => {
                        const next = new Set(previous)
                        if (next.has(remote)) next.delete(remote)
                        else next.add(remote)
                        return next
                      })}>
                        <IconChevronDown size={12} className={`shrink-0 transition-transform ${show ? '' : '-rotate-90'}`} />
                        <span className="truncate">{t('git.remote', { name: remote })}</span>
                      </button>
                      {show && <div className="pl-4">{group.map(renderBranch)}</div>}
                    </div>
                  )
                })}
                {branches.length === 0 && <div className="px-2.5 py-1 text-[12px] text-ink-3">{t('git.noBranches')}</div>}
              </>
            )}
          </div>
          <span className="sr-only" role="status">{view === 'commits' && copiedHash && t('common.copied')}</span>
          {view === 'branches' && (creating ? (
            <form className="p-1" onSubmit={(e) => {
              e.preventDefault()
              if (!name || invalid || disabled) return
              void run({ kind: 'createBranch', name }).then((result) => {
                if (result.ok) close()
                else if (result.code === 'invalidBranch') setServerInvalid(true)
              })
            }}>
              <div className="flex gap-1">
                <input autoFocus className={gitInput + ' flex-1'} value={name} onChange={(e) => {
                  setName(e.target.value)
                  setServerInvalid(false)
                }} onKeyDown={(event) => {
                  if (event.key !== 'Enter' || event.nativeEvent.isComposing) return
                  event.preventDefault()
                  event.currentTarget.form?.requestSubmit()
                }} placeholder={t('git.branchName')} aria-label={t('git.branchName')} aria-invalid={invalid} />
                <button className={item + ' w-auto shrink-0'} disabled={disabled || !name || invalid} title={busy ? t('git.agentBusy') : undefined}>{t('git.createBranch')}</button>
              </div>
              <p className="truncate px-1 pt-1 text-[11px] text-ink-3" title={branchLabel}>{t('git.branchBase', { name: branchLabel })}</p>
              {invalid && <p role="alert" className="px-1 text-[11px] text-danger">{t('git.invalidBranch')}</p>}
            </form>
          ) : <button className={item} disabled={disabled} title={busy ? t('git.agentBusy') : undefined} onClick={() => setCreating(true)}>{t('git.createBranch')}</button>)}
          <div className="grid grid-cols-3 gap-1 border-y border-hairline py-1">
            {syncActions.map(({ kind, Icon, progress }) => {
              const active = kind === pending
              const publish = kind === 'push' && !status.upstream
              const label = t(publish ? 'git.publish' : `git.${kind}`)
              const count = kind === 'pull' && status.behind ? `↓${status.behind}` : kind === 'push' && status.ahead ? `↑${status.ahead}` : ''
              return (
                <button key={kind} className={item + ` justify-center gap-1 px-1 ${active ? 'disabled:opacity-100!' : ''}`}
                  disabled={disabled} title={busy ? t('git.agentBusy') : active ? t(progress) : [label, count].filter(Boolean).join(' ')}
                  onClick={() => void run({ kind })}>
                  {active ? <Spinner size={13} className="shrink-0 text-accent" /> : <Icon size={13} className="shrink-0 text-ink-3" />}
                  <span className="min-w-0 truncate">{active ? t(progress) : label}</span>
                  {!active && count && <span className="shrink-0 text-[10px] tabular-nums text-ink-3">{count}</span>}
                </button>
              )
            })}
          </div>
          {busy && <p className="px-2.5 py-1 text-[11px] text-ink-3">{t('git.agentBusy')}</p>}
          <button className={item} onClick={() => { close(); onViewChanges() }}>{t('git.viewChanges')}</button>
          <button className={item} onClick={() => { close(); onViewHistory() }}>{t('git.viewHistory')}</button>
        </div>
      )}
    </div>
  )
}
