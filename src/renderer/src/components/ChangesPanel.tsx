import { useCallback, useEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { FileChange, FileChanges, GitCommitFile, GitStashDetail, GitStashEntry, GitStatus } from '@shared/types'
import { useEscape } from '../lib/escStack'
import { EDITOR_CHAT_MIN_W } from '../lib/editorLayout'
import type { Thread } from '../state/chat'
import { fmtAgo, t } from '../state/i18n'
import { useApp } from '../state/AppContext'
import type { ProjectGitTools, RunGit } from '../state/useProjectGit'
import { gitBranchLabel, gitInput } from './GitBranchMenu'
import { GitCommandLogDrawer } from './GitCommandLogDrawer'
import { GitConflictBar, GitConflictList, GitConflictModal } from './GitConflicts'
import { GitRepositoryDialog } from './GitRepositoryDialog'
import { Segmented } from './common'
import { DiffView } from './Process'
import { IconBranch, IconChevronDown, IconEdit, IconExternal, IconFile, IconFolder, IconMinus, IconPlus, IconRefresh, IconUndo, IconX, Spinner } from './icons'

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
  const { toast } = useApp()
  const [snapshot, setSnapshot] = useState<{ dir: string; changes: FileChanges } | null>(null)
  const [loading, setLoading] = useState(false)
  const [failedDir, setFailedDir] = useState<string | null>(null)
  const seq = useRef(0)

  const refresh = useCallback(() => {
    const n = ++seq.current
    setFailedDir(null)
    if (!dir) {
      setSnapshot(null)
      setLoading(false)
      return
    }
    setLoading(true)
    window.agentswitch.git
      .changes(dir, split)
      .then((r) => n === seq.current && setSnapshot({ dir, changes: r }))
      .catch((error) => {
        if (n !== seq.current) return
        toast({ kind: 'error', title: t('git.failed'), desc: String(error) })
        setFailedDir(dir)
      })
      .finally(() => n === seq.current && setLoading(false))
  }, [dir, split, toast])

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
  return { changes, loading, refresh, readFailed: failedDir !== null && failedDir === dir }
}

const STATUS_CLS: Record<FileChange['status'], string> = {
  M: 'text-info bg-info-soft',
  A: 'text-ok bg-ok-soft',
  U: 'text-ok bg-ok-soft',
  D: 'text-danger bg-danger-soft',
  R: 'text-warn bg-warn-soft',
  C: 'text-danger bg-danger-soft'
}

export function Counts({ added, removed, className = '' }: { added: number; removed: number; className?: string }) {
  return (
    <span className={`shrink-0 font-mono tabular-nums ${className}`}>
      <span className="text-ok">+{added}</span> <span className="text-danger">-{removed}</span>
    </span>
  )
}

const WIDTH_KEY = 'agentswitch.changesWidth'
export const CHANGES_PANEL_MIN_W = 300
const MAX_W = 760
type GitTools = ProjectGitTools

export function ChangesPanel({
  changes,
  loading,
  readFailed,
  dir,
  onRefresh,
  onClose,
  onViewHistory,
  onEditFile,
  gitTools,
  gitRevision,
  overlay
}: {
  changes: FileChanges | null
  loading: boolean
  readFailed: boolean
  dir: string | null
  onRefresh: () => void
  onClose: () => void
  onViewHistory: () => void
  onEditFile?: (absPath: string) => void
  gitTools: GitTools | null
  gitRevision: number
  overlay: boolean
}) {
  const tools = dir ? gitTools : null
  const [tab, setTab] = useState<'changes' | 'stashes'>('changes')
  const [repository, setRepository] = useState<'tags' | 'remotes' | null>(null)
  const [conflictPath, setConflictPath] = useState<string | null>(null)
  const [width, setWidth] = useState(() => Math.min(MAX_W, Math.max(CHANGES_PANEL_MIN_W, Number(localStorage.getItem(WIDTH_KEY)) || 400)))
  const startDrag = (e: React.PointerEvent) => {
    e.preventDefault()
    const x0 = e.clientX
    const w0 = e.currentTarget.parentElement?.clientWidth ?? width
    let w = w0
    const move = (ev: PointerEvent) => {
      w = Math.min(MAX_W, Math.max(CHANGES_PANEL_MIN_W, w0 + (x0 - ev.clientX)))
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
  const conflictFiles = tools ? files.filter((file) => file.conflicted) : []
  const canShowHistory = !!dir && (!!gitTools || !!changes?.repo)
  return (
    <aside
      className={`flex min-h-0 shrink-0 flex-col border-l border-hairline ${overlay
        ? 'absolute top-[52px] right-0 bottom-0 z-20 bg-surface shadow-lg'
        : 'relative h-full bg-surface/60'}`}
      style={{ width, maxWidth: overlay ? '100%' : `calc(100% - ${EDITOR_CHAT_MIN_W}px)` }}
    >
      <div
        className="absolute inset-y-0 -left-1 z-10 w-2 cursor-col-resize transition-colors hover:bg-accent/20"
        onPointerDown={startDrag}
        onDoubleClick={() => {
          setWidth(400)
          localStorage.setItem(WIDTH_KEY, '400')
        }}
        title={t('chg.resize')}
      />
      <div className="drag flex h-[52px] shrink-0 items-center gap-2 border-b border-hairline px-4">
        <span className="text-[14px] font-semibold text-ink">{t('chg.title')}</span>
        {files.length > 0 && (
          <span className="text-[12px] text-ink-3">
            {t('chg.nFiles', { n: files.length + (changes?.more ?? 0) })} · <Counts added={changes!.added} removed={changes!.removed} />
          </span>
        )}
        <div className="flex-1" />
        {changes && !changes.repo && files.length > 0 && <span className="text-[11px] text-ink-3">{t('chg.fromChat')}</span>}
        <button
          className="no-drag grid h-7 w-7 place-items-center rounded-lg text-ink-3 hover:bg-black/[0.05] hover:text-ink"
          onClick={onRefresh}
          disabled={!dir}
          title={t('common.refresh')}
        >
          {loading ? <Spinner size={13} /> : <IconRefresh size={14} />}
        </button>
        <button className="no-drag grid h-7 w-7 place-items-center rounded-lg text-ink-3 hover:bg-black/[0.05] hover:text-ink" onClick={onClose} title={t('common.close')}>
          <IconX size={14} />
        </button>
      </div>

      {(canShowHistory || tools) && (
        <div className="flex shrink-0 flex-wrap items-center gap-1 border-b border-hairline px-3 py-1.5">
          {tools && <Segmented size="sm" value={tab} onChange={setTab} options={[
            { value: 'changes', label: t('chg.short') },
            { value: 'stashes', label: t('git.stashesTab', { n: tools.status.stashCount }) }
          ]} />}
          {tools && <div className="flex items-center gap-0.5">
            <button type="button" className={gitButton} onClick={() => setRepository('tags')}>{t('git.tags')}</button>
            <button type="button" className={gitButton} onClick={() => setRepository('remotes')}>{t('git.remotes')}</button>
          </div>}
          {canShowHistory && (
            <button type="button" onClick={onViewHistory}
              className="ml-auto flex h-7 shrink-0 items-center gap-2 rounded-lg px-2 text-[12px] font-medium text-ink-2 hover:bg-black/[0.05] hover:text-ink">
              <IconBranch size={13} aria-hidden="true" />
              {t('git.historyTab')}
            </button>
          )}
        </div>
      )}
      {tools && <GitConflictBar tools={tools} />}
      {tools && <div hidden={tab === 'stashes' || !!tools.status.inProgress || !!tools.status.conflicts}>
        <CommitSection key={dir} git={tools.status} disabled={tools.disabled} run={tools.run} />
      </div>}
      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
        {tools && <GitConflictList files={conflictFiles} count={tools.status.conflicts} resolve={setConflictPath} />}
        {tools && dir && tab === 'stashes' ? (
          <StashPanel key={dir} dir={dir} tools={tools} />
        ) : !dir ? (
          <Empty text={t('chg.noProject')} />
        ) : changes === null && readFailed ? (
          <Empty text={t('git.failed')} />
        ) : changes === null ? (
          <div className="flex justify-center py-10 text-ink-3">
            <Spinner size={16} />
          </div>
        ) : tools?.status.dirty ? (
          <>
            {!tools.status.atRoot && <p className="px-2 pb-2 text-[11px] text-ink-3">{t('git.repoScope')}</p>}
            {(['staged', 'unstaged', 'untracked'] as const).map((name) => (
              <ChangeGroup key={dir + name} name={name} files={files} tools={tools} onEditFile={onEditFile} />
            ))}
          </>
        ) : files.length === 0 ? (
          <Empty text={changes.repo ? t('chg.clean') : t('chg.notRepo')} />
        ) : (
          files.map((f) => <FileRow key={f.abs + ':' + f.status} f={f} onEditFile={onEditFile} />)
        )}
        {(!tools || tab === 'changes') && !!changes?.more && <div className="px-2 py-2 text-[12px] text-ink-3">{t('chg.more', { n: changes.more })}</div>}
      </div>
      {tools && dir && <GitCommandLogDrawer key={dir} dir={dir} revision={gitRevision} />}
      {tools && dir && repository && <GitRepositoryDialog key={dir + repository} dir={dir} tools={tools}
        initialTab={repository} onClose={() => setRepository(null)} />}
      {tools && dir && conflictPath && <GitConflictModal key={dir + conflictPath} dir={dir} path={conflictPath}
        run={tools.run} disabled={tools.disabled} onClose={() => setConflictPath(null)} />}
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

function ChangeGroup({ name, files, tools, onEditFile }: {
  name: 'staged' | 'unstaged' | 'untracked'
  files: FileChange[]
  tools: GitTools
  onEditFile?: (absPath: string) => void
}) {
  const { confirm } = useApp()
  const { run, disabled } = tools
  const [expanded, setExpanded] = useState(true)
  const staged = name === 'staged'
  const untracked = name === 'untracked'
  const group = files.flatMap((file) => {
    if (file.conflicted) return []
    if (!staged && (file.status === 'U') !== untracked) return []
    const change = staged ? file.stagedChange : file.unstagedChange
    return change ? [{ ...file, ...change }] : []
  })
  if (!group.length) return null
  const title = t(staged ? 'git.stagedGroup' : untracked ? 'git.untrackedGroup' : 'git.unstagedGroup', { n: group.length })
  const bulkLabel = t(staged ? 'git.unstageAll' : 'git.stageAll')
  const blockedBulk = !untracked && tools.status.conflicts > 0
  const actionLabel = t(staged ? 'git.unstage' : 'git.stage')
  const discardLabel = t(untracked ? 'git.cleanFile' : 'git.discard')
  const bulkDiscardLabel = t(untracked ? 'git.cleanAll' : 'git.discardAll')
  const discard = async (file?: FileChange) => {
    const label = file ? discardLabel : bulkDiscardLabel
    const message = file
      ? t(untracked ? 'git.deleteConfirm' : 'git.restoreConfirm', { path: file.path })
      : t(untracked ? 'git.cleanAllConfirm' : 'git.discardAllConfirm')
    if (await confirm({ title: label, message, confirmLabel: label, destructive: true })) {
      await run(file ? { kind: 'discard', path: file.path, untracked } : { kind: untracked ? 'cleanAll' : 'discardAll' })
    }
  }

  return (
    <section className="mb-2 min-w-0" aria-label={title}>
      <div className="flex items-center gap-1 rounded-lg bg-black/[0.035] px-1 dark:bg-white/[0.045]">
        <button className="flex min-w-0 flex-1 items-center gap-1.5 px-1.5 py-1.5 text-left text-[12px] font-semibold text-ink"
          aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
          <IconChevronDown size={12} className={`shrink-0 text-ink-3 transition-transform ${expanded ? '' : '-rotate-90'}`} />
          <span className="truncate">{title}</span>
        </button>
        <button className={gitButton + ' shrink-0'} disabled={disabled || blockedBulk} title={blockedBulk ? t('git.continueResolveFirst') : bulkLabel}
          onClick={() => void run({ kind: staged ? 'unstageAll' : untracked ? 'stageUntracked' : 'stageTracked' })}>{bulkLabel}</button>
        {!staged && <button className={gitButton + ' shrink-0 enabled:hover:text-danger!'} disabled={disabled || blockedBulk}
          title={blockedBulk ? t('git.continueResolveFirst') : bulkDiscardLabel}
          onClick={() => void discard()}>{bulkDiscardLabel}</button>}
      </div>
      {expanded && group.map((file) => {
        const stage = () => void run({ kind: staged ? 'unstage' : 'stage', path: file.path })
        const ignore = (mode: 'file' | 'dir' | 'ext') => () => void run({ kind: 'ignore', path: file.path, mode })
        const filename = file.path.split('/').at(-1) ?? ''
        return (
          <FileRow key={file.abs} f={file} onEditFile={onEditFile} menu={disabled ? undefined : [
            ...(onEditFile && file.status !== 'D' ? [{ label: t('editor.editFile'), run: () => onEditFile(file.abs) }] : []),
            { label: actionLabel, run: stage },
            ...(staged ? [] : [{ label: discardLabel, run: () => void discard(file), destructive: true }]),
            { label: t('git.ignoreFile'), run: ignore('file') },
            ...(file.path.includes('/') || !tools.status.atRoot ? [{ label: t('git.ignoreDir'), run: ignore('dir') }] : []),
            ...(filename.lastIndexOf('.') > 0 ? [{ label: t('git.ignoreExt'), run: ignore('ext') }] : [])
          ]}>
            <button className={rowAction} disabled={disabled} aria-label={actionLabel} title={actionLabel} onClick={stage}>
              {staged ? <IconMinus size={14} /> : <IconPlus size={14} />}
            </button>
            {!staged && <button className={rowAction + ' enabled:hover:text-danger!'} disabled={disabled} aria-label={discardLabel}
              title={discardLabel} onClick={() => void discard(file)}><IconUndo size={14} /></button>}
          </FileRow>
        )
      })}
    </section>
  )
}

type FileMenuAction = { label: string; run: () => void; destructive?: boolean }

export function FileRow({ f, children, menu, onEditFile }: { f: FileChange | GitCommitFile; children?: ReactNode; menu?: FileMenuAction[]; onEditFile?: (absPath: string) => void }) {
  const [open, setOpen] = useState(false)
  const [menuPoint, setMenuPoint] = useState<{ x: number; y: number } | null>(null)
  const slash = f.path.lastIndexOf('/')
  const name = f.path.slice(slash + 1)
  const parent = slash >= 0 ? f.path.slice(0, slash) : ''
  const openablePath = 'abs' in f && f.status !== 'D' ? f.abs : null
  const showActions = !!children || !!openablePath
  const pathTitle = 'oldPath' in f && f.oldPath ? `${f.oldPath} → ${f.path}` : f.path
  const openMenu = menu && ((e: MouseEvent) => {
    e.preventDefault()
    const row = e.currentTarget.getBoundingClientRect()
    setMenuPoint({
      x: Math.max(4, Math.min(e.clientX || row.left, window.innerWidth - 244)),
      y: Math.max(4, Math.min(e.clientY || row.bottom, window.innerHeight - menu.length * 30 - 12))
    })
  })
  return (
    <div className="min-w-0 rounded-lg">
      <div className="group flex h-8 min-w-0 items-center gap-1 rounded-lg px-2 hover:bg-black/[0.04] dark:hover:bg-white/[0.05]" onContextMenu={openMenu}>
        <button className="flex min-w-0 flex-1 items-center gap-2 text-left" onClick={() => setOpen(!open)} aria-expanded={open} title={pathTitle}>
          <IconChevronDown size={12} className={`shrink-0 text-ink-3 transition-transform ${open ? '' : '-rotate-90'}`} />
          <span className={`grid h-[18px] w-[18px] shrink-0 place-items-center rounded font-mono text-[10.5px] font-semibold ${STATUS_CLS[f.status]}`}
            title={t(`chg.st.${f.status}`)}>{f.status}</span>
          {'conflicted' in f && f.conflicted && <span className="shrink-0 text-[10.5px] font-medium text-danger">{t('git.conflictTag')}</span>}
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
                {onEditFile && (
                  <button className={rowAction} onClick={() => onEditFile(openablePath)}
                    title={t('editor.editFile')} aria-label={t('editor.editFile')}><IconEdit size={13} /></button>
                )}
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
      {menu && menuPoint && <FileContextMenu actions={menu} point={menuPoint} close={() => setMenuPoint(null)} />}
      {open && (
        <div className={`mt-0.5 mb-2 ${'abs' in f ? 'ml-6' : 'git-diff-reveal'}`}>
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

function FileContextMenu({ actions, point, close }: {
  actions: FileMenuAction[]
  point: { x: number; y: number }
  close: () => void
}) {
  useEscape(close, true)
  return createPortal(
    <div className="fixed inset-0 z-40" onMouseDown={close} onContextMenu={(e) => { e.preventDefault(); close() }}>
      <div className="absolute w-60 rounded-xl border border-hairline bg-surface p-1 shadow-lg"
        style={{ left: point.x, top: point.y }} onMouseDown={(e) => e.stopPropagation()}>
        {actions.map(({ label, run, destructive }, index) => (
          <button key={label} type="button" autoFocus={index === 0}
            className={gitButton + ` block min-h-7 w-full text-left ${destructive ? 'text-danger!' : ''}`}
            onClick={() => { close(); run() }}>{label}</button>
        ))}
      </div>
    </div>,
    document.body
  )
}

function StashPanel({ dir, tools }: { dir: string; tools: GitTools }) {
  const { toast, confirm } = useApp()
  const { status, disabled, run } = tools
  const [stashes, setStashes] = useState<GitStashEntry[] | null>(null)
  const [failed, setFailed] = useState(false)
  const [message, setMessage] = useState('')
  const [includeUntracked, setIncludeUntracked] = useState(false)
  const [keepIndex, setKeepIndex] = useState(false)
  useEffect(() => {
    let active = true
    void (async () => {
      try {
        const result = await window.agentswitch.git.stashes(dir)
        if (!active) return
        if (!result.ok) throw new Error(result.error)
        setStashes(result.stashes)
        setFailed(false)
      } catch (error) {
        if (!active) return
        setFailed(true)
        toast({ kind: 'error', title: t('git.stashReadFailed'), desc: String(error) })
      }
    })()
    return () => { active = false }
  }, [dir, status, toast])

  const create = async () => {
    const result = await run({ kind: 'stashPush', message, includeUntracked, keepIndex })
    if (result.ok) setMessage((value) => value === message ? '' : value)
  }
  const clear = async () => {
    const label = t('git.stashClear')
    if (await confirm({ title: label, message: t('git.stashClearConfirm'), confirmLabel: label, destructive: true })) {
      await run({ kind: 'stashClear' })
    }
  }
  const canStash = !!status.headCommit && (status.staged > 0 || status.unstaged > status.untracked || (includeUntracked && status.untracked > 0))
  return (
    <>
      <form className="mx-1 mb-3 space-y-2 border-b border-hairline px-1 pb-3" onSubmit={(event) => {
        event.preventDefault()
        if (canStash && !disabled) void create()
      }}>
        <input className={gitInput} value={message} onChange={(e) => setMessage(e.target.value)}
          placeholder={t('git.stashMessage')} aria-label={t('git.stashMessage')} />
        <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11.5px] text-ink-2">
          <label className="flex items-center gap-1.5"><input type="checkbox" checked={includeUntracked}
            onChange={(e) => setIncludeUntracked(e.target.checked)} />{t('git.stashUntracked')}</label>
          <label className="flex items-center gap-1.5"><input type="checkbox" checked={keepIndex}
            onChange={(e) => setKeepIndex(e.target.checked)} />{t('git.stashKeepIndex')}</label>
        </div>
        <div className="flex justify-between gap-2">
          <button className="rounded-lg bg-accent px-3 py-1.5 text-[12px] font-medium text-white disabled:opacity-45"
            disabled={disabled || !canStash}>{t('git.stashCreate')}</button>
          {!!stashes?.length && <button type="button" className={gitButton + ' enabled:hover:text-danger!'} disabled={disabled || failed}
            onClick={() => void clear()}>{t('git.stashClear')}</button>}
        </div>
      </form>
      {failed ? <Empty text={t('git.stashReadFailed')} />
        : stashes === null ? <div className="flex justify-center py-6 text-ink-3"><Spinner size={15} /></div>
        : !stashes.length ? <Empty text={t('git.noStashes')} />
        : stashes.map((entry) => <StashRow key={entry.hash + ':' + entry.index} dir={dir} entry={entry} tools={tools} />)}
    </>
  )
}

function StashRow({ dir, entry, tools }: { dir: string; entry: GitStashEntry; tools: GitTools }) {
  const { confirm, toast } = useApp()
  const { disabled, run } = tools
  const [open, setOpen] = useState(false)
  const [detail, setDetail] = useState<GitStashDetail | null>(null)
  const [detailFailed, setDetailFailed] = useState(false)
  const [branchName, setBranchName] = useState<string | null>(null)
  const { ref, hash } = entry
  useEffect(() => {
    if (!open) return
    let active = true
    setDetailFailed(false)
    void (async () => {
      try {
        const result = await window.agentswitch.git.stashDetail(dir, ref)
        if (!active) return
        if (!result.ok) throw new Error(result.error)
        setDetail(result.stash)
      } catch (error) {
        if (!active) return
        setDetailFailed(true)
        toast({ kind: 'error', title: t('git.stashReadFailed'), desc: String(error) })
      }
    })()
    return () => { active = false }
  }, [open, dir, ref, toast])

  const mutateStash = (kind: 'stashApply' | 'stashPop' | 'stashDrop') => run({ kind, ref, expectedHash: hash })
  const drop = async () => {
    const label = t('git.stashDrop')
    if (await confirm({ title: label, message: t('git.stashDropConfirm', { name: entry.message, ref }), confirmLabel: label, destructive: true })) {
      await mutateStash('stashDrop')
    }
  }
  const createBranch = async (name: string) => {
    if ((await run({ kind: 'stashBranch', ref, name, expectedHash: hash })).ok) setBranchName(null)
  }
  return (
    <section className="mb-2 min-w-0 rounded-lg border border-hairline">
      <button type="button" className="flex w-full min-w-0 items-center gap-2 rounded-t-lg px-2 py-2 text-left hover:bg-fill"
        aria-expanded={open} onClick={() => setOpen(!open)}>
        <IconChevronDown size={12} className={`shrink-0 text-ink-3 transition-transform ${open ? '' : '-rotate-90'}`} />
        <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-ink" title={entry.message}>{entry.message}</span>
        <span className="shrink-0 text-[11px] tabular-nums text-ink-3" title={ref}>{fmtAgo(entry.timestamp)}</span>
      </button>
      {open && <div className="border-t border-hairline px-1 pb-1">
        <div className="flex flex-wrap gap-x-1 py-1">
          <button className={gitButton} disabled={disabled} onClick={() => void mutateStash('stashApply')}>{t('git.stashApply')}</button>
          <button className={gitButton} disabled={disabled} onClick={() => void mutateStash('stashPop')}>{t('git.stashPop')}</button>
          <button className={gitButton} disabled={disabled} aria-expanded={branchName !== null}
            onClick={() => setBranchName(branchName === null ? '' : null)}>{t('git.stashBranch')}</button>
          <button className={gitButton + ' enabled:hover:text-danger!'} disabled={disabled} onClick={() => void drop()}>{t('git.stashDrop')}</button>
        </div>
        {branchName !== null && <form className="flex gap-1 px-1 pb-2" onSubmit={(e) => {
          e.preventDefault()
          if (branchName.trim() && !disabled) void createBranch(branchName.trim())
        }}>
          <input autoFocus className={gitInput} value={branchName} onChange={(e) => setBranchName(e.target.value)}
            placeholder={t('git.branchName')} aria-label={t('git.branchName')} />
          <button className={gitButton + ' shrink-0'} disabled={disabled || !branchName.trim()}>{t('git.createBranch')}</button>
        </form>}
        {detailFailed ? <p className="px-2 py-1.5 text-[12px] text-danger">{t('git.stashReadFailed')}</p>
          : !detail ? <div className="flex justify-center py-3 text-ink-3"><Spinner size={14} /></div>
          : detail.files.length ? detail.files.map((file, index) => <FileRow key={file.path + ':' + index} f={file} />)
          : <p className="px-2 py-1.5 text-[12px] text-ink-3">{t('chg.noDiff')}</p>}
        {!!detail?.more && <p className="px-2 py-1.5 text-[12px] text-ink-3">{t('chg.more', { n: detail.more })}</p>}
      </div>}
    </section>
  )
}

function CommitSection({ git, disabled, run }: {
  git: Extract<GitStatus, { repo: true }>
  disabled: boolean
  run: RunGit
}) {
  const [message, setMessage] = useState('')
  const [amend, setAmend] = useState(false)
  const draft = useRef('')
  if (!git.dirty && !git.headCommit) return null
  const amending = amend && !!git.headCommit
  const disabledReason = disabled ? t('git.waiting')
    : !message.trim() ? t('git.enterMessage') : !git.staged && !amending ? t('git.noStaged') : undefined
  const canStageAndCommit = !disabled && !!message.trim() && git.unstaged > 0 && !git.staged
  const commit = (kind: 'commit' | 'stageAndCommit') => {
    if (kind === 'commit' ? !!disabledReason : !canStageAndCommit) return
    const submitted = message
    void run({ kind, message: submitted, amend: amending }).then((result) => {
      if (result.ok) {
        setAmend(false)
        setMessage((current) => current === submitted ? '' : current)
      }
    })
  }
  const label = amending ? t('git.amend') : t('git.commitTo', { name: gitBranchLabel(git) })
  const undo = async () => {
    const result = await run({ kind: 'undoLastCommit' })
    if (result.ok && result.outcome?.kind === 'undoLastCommit') {
      setAmend(false)
      setMessage(result.outcome.message)
    }
  }

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
      {git.headCommit && <div className="flex flex-wrap items-center justify-between gap-1">
        <label className="flex items-center gap-1.5 px-1 text-[11.5px] text-ink-2">
          <input type="checkbox" checked={amending} disabled={disabled} onChange={(event) => {
            const checked = event.target.checked
            if (checked) draft.current = message
            setMessage(checked ? git.headCommit!.message : draft.current)
            setAmend(checked)
          }} />
          {t('git.amend')}
        </label>
        <button className={gitButton} disabled={disabled || (!git.branch && !git.headCommit.hasParent)}
          title={t('git.undoHint')} onClick={() => void undo()}>{t('git.undoLastCommit')}</button>
      </div>}
      {!git.staged && git.unstaged > 0 && (
        <button className={gitButton + ' w-full'} disabled={!canStageAndCommit}
          title={!message.trim() ? t('git.enterMessage') : undefined}
          onClick={() => commit('stageAndCommit')}>{t('git.stageAndCommit')}</button>
      )}
    </div>
  )
}
