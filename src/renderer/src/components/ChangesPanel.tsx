import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import type { FileChange, FileChanges, GitCommit, GitCommitFile, GitStatus } from '@shared/types'
import type { Thread } from '../state/chat'
import { fmtAgo, t } from '../state/i18n'
import { useApp } from '../state/AppContext'
import type { RunGit } from '../state/useProjectGit'
import { gitBranchLabel, gitInput } from './GitBranchMenu'
import { GitGraphView } from './GitGraphView'
import { Segmented } from './common'
import { DiffView } from './Process'
import { IconChevronDown, IconExternal, IconFile, IconFolder, IconMinus, IconPlus, IconRefresh, IconUndo, IconX, Spinner } from './icons'

/**
 * 文件修改 panel (right of the chat): the project's working-tree changes from git, or — when
 * the folder isn't a repo — the files the chat's replies wrote (from their activity diffs).
 */

const EMPTY: FileChanges = { repo: false, files: [], added: 0, removed: 0 }

const countDiff = (diff: string) => {
  let added = 0
  let removed = 0
  for (const l of diff.split('\n')) {
    if (l.startsWith('+++') || l.startsWith('---')) continue
    if (l.startsWith('+')) added++
    else if (l.startsWith('-')) removed++
  }
  return { added, removed }
}

/** Not a git repo: what this chat's replies wrote, newest diff last. */
function fromActivity(thread: Thread | null, dir: string | null): FileChanges {
  if (!thread) return EMPTY
  const by = new Map<string, FileChange>()
  for (const m of thread.messages) {
    if (m.role !== 'assistant') continue
    for (const a of m.activity) {
      if (a.type !== 'write' || a.status === 'error') continue
      const abs = a.target.startsWith('/') ? a.target : dir ? `${dir.replace(/\/$/, '')}/${a.target}` : a.target
      const path = dir && abs.startsWith(dir.replace(/\/$/, '') + '/') ? abs.slice(dir.replace(/\/$/, '').length + 1) : a.target
      const diff = a.detail?.diff ?? ''
      const c = countDiff(diff)
      const prev = by.get(abs)
      const isNew = /^--- \/dev\/null/m.test(diff)
      by.set(abs, {
        path,
        abs,
        status: prev ? prev.status : isNew ? 'A' : 'M',
        added: (prev?.added ?? 0) + c.added,
        removed: (prev?.removed ?? 0) + c.removed,
        diff: [prev?.diff, diff].filter(Boolean).join('\n')
      })
    }
  }
  const files = [...by.values()].sort((a, b) => a.path.localeCompare(b.path))
  return {
    repo: false,
    files,
    added: files.reduce((n, f) => n + f.added, 0),
    removed: files.reduce((n, f) => n + f.removed, 0)
  }
}

/**
 * Live changes of the chat's project folder: refreshed when a turn ends, the window regains
 * focus, the folder changes, or on demand.
 */
export function useFileChanges(thread: Thread | null, dir: string | null, busy: boolean, split: boolean) {
  const [snapshot, setSnapshot] = useState<{ dir: string; changes: FileChanges } | null>(null)
  const [loading, setLoading] = useState(false)
  const seq = useRef(0)

  const refresh = useCallback(() => {
    const n = ++seq.current
    if (!dir) {
      setSnapshot(null)
      setLoading(false)
      return
    }
    setLoading(true)
    window.agentswitch.git
      .changes(dir, split)
      .then((r) => n === seq.current && setSnapshot({ dir, changes: r }))
      .catch(() => n === seq.current && setSnapshot({ dir, changes: EMPTY }))
      .finally(() => n === seq.current && setLoading(false))
  }, [dir, split])

  useEffect(() => {
    refresh()
  }, [refresh])
  // a turn just finished
  const wasBusy = useRef(busy)
  useEffect(() => {
    if (wasBusy.current && !busy) refresh()
    wasBusy.current = busy
  }, [busy, refresh])
  useEffect(() => {
    window.addEventListener('focus', refresh)
    return () => window.removeEventListener('focus', refresh)
  }, [refresh])

  const git = snapshot?.dir === dir ? snapshot.changes : null
  const changes = !dir ? EMPTY : git?.repo ? git : git ? fromActivity(thread, dir) : null
  return { changes, loading, refresh }
}

const STATUS_CLS: Record<FileChange['status'], string> = {
  M: 'text-info bg-info-soft',
  A: 'text-ok bg-ok-soft',
  U: 'text-ok bg-ok-soft',
  D: 'text-danger bg-danger-soft',
  R: 'text-warn bg-warn-soft'
}

export function Counts({ added, removed, className = '' }: { added: number; removed: number; className?: string }) {
  return (
    <span className={`shrink-0 font-mono tabular-nums ${className}`}>
      <span className="text-ok">+{added}</span> <span className="text-danger">-{removed}</span>
    </span>
  )
}

const WIDTH_KEY = 'agentswitch.changesWidth'
const MIN_W = 300
const MAX_W = 760

export type ChangesTab = 'changes' | 'history'

export function ChangesPanel({
  changes,
  loading,
  dir,
  onRefresh,
  onClose,
  tab,
  onTabChange,
  gitTools
}: {
  changes: FileChanges | null
  loading: boolean
  dir: string | null
  onRefresh: () => void
  onClose: () => void
  tab: ChangesTab
  onTabChange: (tab: ChangesTab) => void
  gitTools: {
    status: Extract<GitStatus, { repo: true }>
    disabled: boolean
    busy: boolean
    run: RunGit
  } | null
}) {
  const { confirm } = useApp()
  const tools = changes?.repo && dir ? gitTools : null
  const gitTitle = tools?.busy ? t('git.agentBusy') : undefined
  const discard = async (file: FileChange) => {
    if (tools && await confirm({
      title: t('git.discard'),
      message: t(file.status === 'U' ? 'git.deleteConfirm' : 'git.restoreConfirm', { path: file.path }),
      confirmLabel: t('git.discard'),
      destructive: true
    })) {
      await tools.run({ kind: 'discard', path: file.path, untracked: file.status === 'U' })
    }
  }
  const [width, setWidth] = useState(() => Math.min(MAX_W, Math.max(MIN_W, Number(localStorage.getItem(WIDTH_KEY)) || 400)))
  const startDrag = (e: React.PointerEvent) => {
    e.preventDefault()
    const x0 = e.clientX
    const w0 = width
    let w = w0
    const move = (ev: PointerEvent) => {
      w = Math.min(MAX_W, Math.max(MIN_W, w0 + (x0 - ev.clientX)))
      setWidth(w)
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      document.body.style.cursor = ''
      localStorage.setItem(WIDTH_KEY, String(w))
    }
    document.body.style.cursor = 'col-resize'
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  const files = changes?.files ?? []
  const canShowHistory = !!dir && (!!gitTools || !!changes?.repo)
  const historyDir = tab === 'history' && canShowHistory ? dir : null
  return (
    <aside className="relative flex h-full shrink-0 flex-col border-l border-hairline bg-surface/60" style={{ width }}>
      <div
        className="absolute inset-y-0 -left-1 z-10 w-2 cursor-col-resize transition-colors hover:bg-accent/20"
        onPointerDown={startDrag}
        onDoubleClick={() => {
          setWidth(400)
          localStorage.setItem(WIDTH_KEY, '400')
        }}
        title={t('chg.resize')}
      />
      <div className="drag flex h-14 shrink-0 items-center gap-2 border-b border-hairline px-4">
        <span className="text-[14px] font-semibold text-ink">{t('chg.title')}</span>
        {!historyDir && files.length > 0 && (
          <span className="text-[12px] text-ink-3">
            {t('chg.nFiles', { n: files.length + (changes?.more ?? 0) })} · <Counts added={changes!.added} removed={changes!.removed} />
          </span>
        )}
        <div className="flex-1" />
        {!historyDir && changes && !changes.repo && files.length > 0 && <span className="text-[11px] text-ink-3">{t('chg.fromChat')}</span>}
        {!historyDir && <button
          className="no-drag grid h-7 w-7 place-items-center rounded-lg text-ink-3 hover:bg-black/[0.05] hover:text-ink"
          onClick={onRefresh}
          disabled={!dir}
          title={t('common.refresh')}
        >
          {loading ? <Spinner size={13} /> : <IconRefresh size={14} />}
        </button>}
        <button className="no-drag grid h-7 w-7 place-items-center rounded-lg text-ink-3 hover:bg-black/[0.05] hover:text-ink" onClick={onClose} title={t('common.close')}>
          <IconX size={14} />
        </button>
      </div>

      {canShowHistory && (
        <div className="shrink-0 border-b border-hairline px-3 py-1.5">
          <Segmented size="sm" value={historyDir ? 'history' : 'changes'} onChange={onTabChange} options={[
            { value: 'changes', label: t('git.changesTab') },
            { value: 'history', label: t('git.historyTab') }
          ]} />
        </div>
      )}
      {historyDir && (
        <GitGraphView key={historyDir} dir={historyDir} renderFile={(file) => <FileRow key={file.path} f={file} />}
          onViewChanges={() => { onTabChange('changes'); onRefresh() }} />
      )}
      <div className={historyDir ? 'hidden' : 'contents'}>
        {tools && <CommitSection key={dir + ':commit'} git={tools.status} disabled={tools.disabled} busy={tools.busy} run={tools.run} />}
        <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
          {!dir ? (
            <Empty text={t('chg.noProject')} />
          ) : changes === null ? (
            <div className="flex justify-center py-10 text-ink-3">
              <Spinner size={16} />
            </div>
          ) : tools?.status.dirty ? (
            <>
              {!tools.status.atRoot && <p className="px-2 pb-2 text-[11px] text-ink-3">{t('git.repoScope')}</p>}
              <ChangeGroup key={dir + ':staged'} name="staged" files={files} disabled={tools.disabled} busy={gitTitle}
                count={tools.status.staged} run={tools.run} onDiscard={(file) => void discard(file)} />
              <ChangeGroup key={dir + ':unstaged'} name="unstaged" files={files} disabled={tools.disabled} busy={gitTitle}
                count={tools.status.unstaged} run={tools.run} onDiscard={(file) => void discard(file)} />
            </>
          ) : files.length === 0 ? (
            <Empty text={changes.repo ? t('chg.clean') : t('chg.notRepo')} />
          ) : (
            files.map((f) => <FileRow key={f.abs + ':' + f.status} f={f} />)
          )}
          {!!changes?.more && <div className="px-2 py-2 text-[12px] text-ink-3">{t('chg.more', { n: changes.more })}</div>}
        </div>
        {!historyDir && tools && dir && <CommitHistory key={dir + ':history'} dir={dir} git={tools.status} />}
      </div>
    </aside>
  )
}

function Empty({ text }: { text: string }) {
  return (
    <div className="flex flex-col items-center gap-2 px-6 py-14 text-center text-[13px] leading-relaxed text-ink-3">
      <IconFile size={22} className="opacity-60" />
      {text}
    </div>
  )
}

const gitButton = 'rounded-md px-2 py-1 text-[11.5px] text-ink-2 hover:bg-black/[0.05] dark:hover:bg-white/[0.07] disabled:opacity-45'
const rowAction = 'grid h-6 w-6 place-items-center rounded text-ink-3 hover:bg-black/[0.06] dark:hover:bg-white/[0.07] hover:text-ink disabled:opacity-45'

function ChangeGroup({ name, files, count, disabled, busy, run, onDiscard }: {
  name: 'staged' | 'unstaged'
  files: FileChange[]
  count: number
  disabled: boolean
  busy?: string
  run: RunGit
  onDiscard: (file: FileChange) => void
}) {
  const [expanded, setExpanded] = useState(true)
  const staged = name === 'staged'
  const group = files.flatMap((file) => {
    const change = staged ? file.stagedChange : file.unstagedChange
    return change ? [{ ...file, ...change }] : []
  })
  if (!group.length) return null // like VS Code: an empty group is noise
  const bulkLabel = t(staged ? 'git.unstageAll' : 'git.stageAll')
  const actionLabel = t(staged ? 'git.unstage' : 'git.stage')

  return (
    <section className="mb-2 min-w-0" aria-label={t(staged ? 'git.stagedGroup' : 'git.changesGroup', { n: group.length })}>
      <div className="flex items-center gap-1 rounded-lg bg-black/[0.035] px-1 dark:bg-white/[0.045]">
        <button className="flex min-w-0 flex-1 items-center gap-1.5 px-1.5 py-1.5 text-left text-[12px] font-semibold text-ink"
          aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
          <IconChevronDown size={12} className={`shrink-0 text-ink-3 transition-transform ${expanded ? '' : '-rotate-90'}`} />
          <span className="truncate">{t(staged ? 'git.stagedGroup' : 'git.changesGroup', { n: group.length })}</span>
        </button>
        <button className={gitButton + ' shrink-0'} disabled={disabled || !count} title={busy ?? bulkLabel}
          onClick={() => void run({ kind: staged ? 'unstageAll' : 'stageAll' })}>{bulkLabel}</button>
      </div>
      {expanded && group.map((file) => (
        <FileRow key={file.abs + ':' + (file.status === 'U')} f={file}>
          <button className={rowAction} disabled={disabled} aria-label={actionLabel} title={busy ?? actionLabel}
            onClick={() => void run({ kind: staged ? 'unstage' : 'stage', path: file.path })}>
            {staged ? <IconMinus size={14} /> : <IconPlus size={14} />}
          </button>
          {!staged && (
            <button className={rowAction + ' enabled:hover:text-danger!'} disabled={disabled} aria-label={t('git.discard')}
              title={busy ?? t('git.discard')} onClick={() => onDiscard(file)}><IconUndo size={14} /></button>
          )}
        </FileRow>
      ))}
    </section>
  )
}

function FileRow({ f, children }: { f: FileChange | GitCommitFile; children?: ReactNode }) {
  const [open, setOpen] = useState(false)
  const slash = f.path.lastIndexOf('/')
  const name = f.path.slice(slash + 1)
  const parent = slash >= 0 ? f.path.slice(0, slash) : ''
  const openablePath = 'abs' in f && f.status !== 'D' ? f.abs : null
  const showActions = !!children || !!openablePath
  const pathTitle = 'oldPath' in f && f.oldPath ? `${f.oldPath} → ${f.path}` : f.path
  return (
    <div className="min-w-0 rounded-lg">
      <div className="group flex h-8 min-w-0 items-center gap-1 rounded-lg px-2 hover:bg-black/[0.04] dark:hover:bg-white/[0.05]">
        <button className="flex min-w-0 flex-1 items-center gap-2 text-left" onClick={() => setOpen(!open)} aria-expanded={open} title={pathTitle}>
          <IconChevronDown size={12} className={`shrink-0 text-ink-3 transition-transform ${open ? '' : '-rotate-90'}`} />
          <span className={`grid h-[18px] w-[18px] shrink-0 place-items-center rounded font-mono text-[10.5px] font-semibold ${STATUS_CLS[f.status]}`}
            title={t(`chg.st.${f.status}`)}>{f.status}</span>
          <span className="min-w-0 flex-1 truncate text-[12.5px]">
            <span className={`text-ink ${f.status === 'D' ? 'line-through opacity-70' : ''}`}>{name}</span>
            {parent && <span className="ml-1.5 text-ink-3">{parent}</span>}
          </span>
        </button>
        <div className="relative flex shrink-0 items-center">
          {showActions && <span className="pointer-events-none absolute right-0 flex items-center gap-0.5 opacity-0 group-hover:pointer-events-auto group-hover:static group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:static group-focus-within:opacity-100">
            {children}
            {openablePath && (
              <>
                <button className={rowAction} onClick={() => void window.agentswitch.sys.showInFolder(openablePath)}
                  title={t('common.showInFinder')} aria-label={t('common.showInFinder')}><IconFolder size={13} /></button>
                <button className={rowAction} onClick={() => void window.agentswitch.sys.openPath(openablePath).catch(() => {})}
                  title={t('att.open')} aria-label={t('att.open')}><IconExternal size={13} /></button>
              </>
            )}
          </span>}
          <Counts added={f.added} removed={f.removed} className={`text-[11.5px] ${showActions ? 'group-hover:hidden group-focus-within:hidden' : ''}`} />
        </div>
      </div>
      {open && (
        <div className="mt-0.5 mb-2 ml-6">
          {f.binary ? (
            <div className="px-2 py-1.5 text-[12px] text-ink-3">{t('chg.binary')}</div>
          ) : f.diff ? (
            <DiffView diff={f.diff} />
          ) : (
            <div className="px-2 py-1.5 text-[12px] text-ink-3">{t(f.truncated ? 'git.diffTooLarge' : 'chg.noDiff')}</div>
          )}
        </div>
      )}
    </div>
  )
}

function CommitSection({ git, disabled, busy, run }: {
  git: Extract<GitStatus, { repo: true }>
  disabled: boolean
  busy: boolean
  run: RunGit
}) {
  const [message, setMessage] = useState('')
  if (!git.dirty) return null
  const disabledReason = busy ? t('git.agentBusy') : disabled ? t('git.waiting')
    : !message.trim() ? t('git.enterMessage') : !git.staged ? t('git.noStaged') : undefined
  const canStageAndCommit = !disabled && !!message.trim() && git.unstaged > 0 && !git.staged
  const commit = (kind: 'commit' | 'stageAndCommit') => {
    if (kind === 'commit' ? !!disabledReason : !canStageAndCommit) return
    const submitted = message
    void run({ kind, message: submitted }).then((result) => {
      if (result.ok) setMessage((current) => current === submitted ? '' : current)
    })
  }
  const label = t('git.commitTo', { name: gitBranchLabel(git) })

  return (
    <div className="shrink-0 space-y-1.5 border-b border-hairline p-3">
      <textarea rows={3} className={gitInput + ' max-h-[22vh] resize-y'} value={message} onChange={(e) => setMessage(e.target.value)}
        onKeyDown={(e) => {
          if (e.metaKey && e.key === 'Enter' && !e.nativeEvent.isComposing) {
            e.preventDefault()
            e.stopPropagation()
            commit('commit')
          }
        }} placeholder={t('git.message')} aria-label={t('git.message')} />
      <button className="block w-full truncate rounded-lg bg-accent px-3 py-1.5 text-[12px] font-medium text-white disabled:opacity-45"
        disabled={!!disabledReason} title={disabledReason ?? label + ' · ⌘+Enter'} onClick={() => commit('commit')}>{label}</button>
      {disabledReason && <p className="px-1 text-[11px] text-ink-3">{disabledReason}</p>}
      {!git.staged && git.unstaged > 0 && (
        <button className={gitButton + ' w-full'} disabled={!canStageAndCommit}
          title={busy ? t('git.agentBusy') : !message.trim() ? t('git.enterMessage') : undefined}
          onClick={() => commit('stageAndCommit')}>{t('git.stageAndCommit')}</button>
      )}
    </div>
  )
}

function CommitHistory({ dir, git }: { dir: string; git: Extract<GitStatus, { repo: true }> }) {
  const [historyOpen, setHistoryOpen] = useState(false)
  const [history, setHistory] = useState<GitCommit[] | null>(null)
  const [historyError, setHistoryError] = useState('')
  const { toast } = useApp()
  useEffect(() => {
    if (!historyOpen) return
    let active = true
    setHistoryError('')
    const fail = (desc: string) => {
      if (active) {
        setHistoryError(desc)
        toast({ kind: 'error', title: t('git.failed'), desc })
      }
    }
    void window.agentswitch.git.log(dir).then((result) => {
      if (result.ok) {
        if (active) setHistory(result.commits)
      } else fail(result.error)
    }).catch((error) => fail(String(error)))
    return () => { active = false }
  }, [dir, git, historyOpen, toast])

  return (
    <div className="shrink-0 space-y-2 border-t border-hairline p-3">
      <button className="flex w-full items-center gap-1.5 text-left text-[12px] text-ink-2" aria-expanded={historyOpen}
        onClick={() => setHistoryOpen(!historyOpen)}>
        <IconChevronDown size={12} className={`shrink-0 transition-transform ${historyOpen ? '' : '-rotate-90'}`} />
        {t('git.history')}
      </button>
      {historyOpen && <div className="mt-1 max-h-[min(180px,24vh)] overflow-y-auto">
          {historyError ? <p className="truncate py-1 text-[11px] text-danger" title={historyError}>{historyError}</p>
            : history === null ? <Spinner size={13} />
            : history.length === 0 ? <p className="py-1 text-[11px] text-ink-3">{t('git.noCommits')}</p>
            : history.map((entry) => (
              <div key={entry.sha} className="border-b border-hairline py-1 last:border-0">
                <div className="flex items-baseline gap-2">
                  <code className="text-[11px] text-ink-3">{entry.sha}</code>
                  <span className="min-w-0 truncate text-[12px] text-ink" title={entry.subject}>{entry.subject}</span>
                </div>
                <div className="truncate text-[11px] text-ink-3">{entry.author} · {fmtAgo(entry.authoredAt)}</div>
              </div>
            ))}
        </div>}
    </div>
  )
}
