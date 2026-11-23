import { useEffect, useRef, useState } from 'react'
import type { GitBranch, GitMutation, GitStatus } from '@shared/types'
import { useEscape } from '../lib/escStack'
import { t } from '../state/i18n'
import type { RunGit } from '../state/useProjectGit'
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

export function GitBranchMenu({ status, disabled, busy, pending, run, onViewChanges }: {
  status: Extract<GitStatus, { repo: true }>
  disabled: boolean
  busy: boolean
  pending: GitMutation['kind'] | null
  run: RunGit
  onViewChanges: () => void
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const [serverInvalid, setServerInvalid] = useState(false)
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  const ref = useRef<HTMLDivElement>(null)
  const search = useRef<HTMLInputElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const leaveCreate = () => {
    setCreating(false)
    setName('')
    setServerInvalid(false)
  }
  const close = () => {
    setOpen(false)
    setQuery('')
    leaveCreate()
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

  const invalid = !!name && (serverInvalid || invalidBranchName(name))
  const networkAction = syncActions.find((action) => action.kind === pending)
  const progressLabel = networkAction && t(networkAction.progress)

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
          <input ref={search} autoFocus className={gitInput} value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t('git.search')} aria-label={t('git.search')} />
          <div className="max-h-[min(230px,30vh)] overflow-y-auto py-1">
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
          </div>
          {creating ? (
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
          ) : <button className={item} disabled={disabled} title={busy ? t('git.agentBusy') : undefined} onClick={() => setCreating(true)}>{t('git.createBranch')}</button>}
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
        </div>
      )}
    </div>
  )
}
