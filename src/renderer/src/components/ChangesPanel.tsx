import { useCallback, useEffect, useRef, useState } from 'react'
import type { FileChange, FileChanges } from '@shared/types'
import type { Thread } from '../state/chat'
import { t } from '../state/i18n'
import { DiffView } from './Process'
import { IconChevronDown, IconExternal, IconFile, IconFolder, IconRefresh, IconX, Spinner } from './icons'

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
export function useFileChanges(thread: Thread | null, dir: string | null, busy: boolean) {
  const [git, setGit] = useState<FileChanges | null>(null)
  const [loading, setLoading] = useState(false)
  const seq = useRef(0)

  const refresh = useCallback(() => {
    if (!dir) return setGit(null)
    const n = ++seq.current
    setLoading(true)
    window.agentswitch.git
      .changes(dir)
      .then((r) => n === seq.current && setGit(r))
      .catch(() => n === seq.current && setGit(EMPTY))
      .finally(() => n === seq.current && setLoading(false))
  }, [dir])

  useEffect(() => {
    setGit(null)
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

export function ChangesPanel({
  changes,
  loading,
  dir,
  onRefresh,
  onClose
}: {
  changes: FileChanges | null
  loading: boolean
  dir: string | null
  onRefresh: () => void
  onClose: () => void
}) {
  const [width, setWidth] = useState(() => Math.min(MAX_W, Math.max(MIN_W, Number(localStorage.getItem(WIDTH_KEY)) || 400)))
  const [open, setOpen] = useState<Set<string>>(new Set())
  const toggle = (p: string) =>
    setOpen((s) => {
      const n = new Set(s)
      if (n.has(p)) n.delete(p)
      else n.add(p)
      return n
    })

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

      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
        {!dir ? (
          <Empty text={t('chg.noProject')} />
        ) : changes === null ? (
          <div className="flex justify-center py-10 text-ink-3">
            <Spinner size={16} />
          </div>
        ) : files.length === 0 ? (
          <Empty text={changes.repo ? t('chg.clean') : t('chg.notRepo')} />
        ) : (
          <>
            {files.map((f) => (
              <FileRow key={f.abs} f={f} open={open.has(f.abs)} onToggle={() => toggle(f.abs)} />
            ))}
            {!!changes.more && <div className="px-2 py-2 text-[12px] text-ink-3">{t('chg.more', { n: changes.more })}</div>}
          </>
        )}
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

function FileRow({ f, open, onToggle }: { f: FileChange; open: boolean; onToggle: () => void }) {
  const slash = f.path.lastIndexOf('/')
  const name = f.path.slice(slash + 1)
  const parent = slash >= 0 ? f.path.slice(0, slash) : ''
  const exists = f.status !== 'D'
  return (
    <div className="rounded-lg">
      <div className="group flex h-8 cursor-default items-center gap-2 rounded-lg px-2 hover:bg-black/[0.04]" onClick={onToggle} title={f.path}>
        <IconChevronDown size={12} className={`shrink-0 text-ink-3 transition-transform ${open ? '' : '-rotate-90'}`} />
        <span
          className={`grid h-[18px] w-[18px] shrink-0 place-items-center rounded font-mono text-[10.5px] font-semibold ${STATUS_CLS[f.status]}`}
          title={t(`chg.st.${f.status}` as 'chg.st.M')}
        >
          {f.status}
        </span>
        <span className="min-w-0 flex-1 truncate text-[12.5px]">
          <span className={`text-ink ${f.status === 'D' ? 'line-through opacity-70' : ''}`}>{name}</span>
          {parent && <span className="ml-1.5 text-ink-3">{parent}</span>}
        </span>
        <span className="hidden shrink-0 items-center gap-0.5 group-hover:flex" onClick={(e) => e.stopPropagation()}>
          {exists && (
            <>
              <button
                className="grid h-6 w-6 place-items-center rounded text-ink-3 hover:bg-black/[0.06] hover:text-ink"
                onClick={() => void window.agentswitch.sys.showInFolder(f.abs)}
                title={t('common.showInFinder')}
              >
                <IconFolder size={13} />
              </button>
              <button
                className="grid h-6 w-6 place-items-center rounded text-ink-3 hover:bg-black/[0.06] hover:text-ink"
                onClick={() => void window.agentswitch.sys.openPath(f.abs).catch(() => {})}
                title={t('att.open')}
              >
                <IconExternal size={13} />
              </button>
            </>
          )}
        </span>
        <Counts added={f.added} removed={f.removed} className="text-[11.5px] group-hover:hidden" />
      </div>
      {open && (
        <div className="mt-0.5 mb-2 ml-6">
          {f.binary ? (
            <div className="px-2 py-1.5 text-[12px] text-ink-3">{t('chg.binary')}</div>
          ) : f.diff ? (
            <DiffView diff={f.diff} />
          ) : (
            <div className="px-2 py-1.5 text-[12px] text-ink-3">{t('chg.noDiff')}</div>
          )}
        </div>
      )}
    </div>
  )
}
