import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent, type ReactNode } from 'react'
import type { EditorDirEntry } from '@shared/editor'
import type { FileChange } from '@shared/types'
import { resolveFileTypeMeta } from '../lib/fileTypeMeta'
import { t } from '../state/i18n'
import { FileTypeIcon } from './AttachmentBar'
import { IconChevronRight, IconFolder, IconRefresh, IconSearch, IconX, Spinner } from './icons'

export const TREE_MIN_W = 160
export const TREE_MAX_W = 340
export const TREE_DEFAULT_W = 216

const GIT_STATUS_STYLE: Partial<Record<FileChange['status'], { label: string; cls: string }>> = {
  M: { label: 'M', cls: 'text-info' },
  A: { label: 'A', cls: 'text-ok' },
  U: { label: 'U', cls: 'text-ok' },
  R: { label: 'R', cls: 'text-accent' },
  C: { label: 'C', cls: 'text-accent' },
  D: { label: 'D', cls: 'text-danger' }
}

export interface EditorFileTreeProps {
  projectDir: string | null
  activeFilePath: string | null
  activeRealPath?: string | null
  dirtyPaths: ReadonlySet<string>
  gitStatusByRelPath?: ReadonlyMap<string, FileChange['status']>
  width: number
  onResizeWidth: (width: number) => void
  onOpenFile: (absPath: string) => void
}

function normPath(p: string): string {
  return p.replace(/\\/g, '/')
}

export function EditorFileTree({
  projectDir,
  activeFilePath,
  activeRealPath,
  dirtyPaths,
  gitStatusByRelPath,
  width,
  onResizeWidth,
  onOpenFile
}: EditorFileTreeProps) {
  const [entriesByDir, setEntriesByDir] = useState<Map<string, EditorDirEntry[]>>(() => new Map())
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(() => new Set())
  const [loadingDirs, setLoadingDirs] = useState<Set<string>>(() => new Set())
  const [rootRealDir, setRootRealDir] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState('')
  const seqRef = useRef(0)
  const expandedRef = useRef(expandedDirs)
  expandedRef.current = expandedDirs

  const loadDir = useCallback(async (dirPath: string | null, expectedSeq: number) => {
    if (!projectDir) return
    const key = dirPath ?? projectDir
    setLoadingDirs((prev) => {
      const next = new Set(prev)
      next.add(key)
      return next
    })
    try {
      const res = await window.agentswitch.editor.listDir({
        workspaceDir: projectDir,
        dirPath: dirPath ?? undefined
      })
      if (seqRef.current !== expectedSeq) return
      if (!res.ok) {
        if (!dirPath || dirPath === projectDir) setError(res.message)
        return
      }
      setError(null)
      if (!dirPath || dirPath === projectDir) {
        setRootRealDir(res.dirPath)
      }
      setEntriesByDir((prev) => {
        const next = new Map(prev)
        next.set(res.dirPath, res.entries)
        if (dirPath && dirPath !== res.dirPath) next.set(dirPath, res.entries)
        return next
      })
    } catch (err) {
      if (seqRef.current !== expectedSeq) return
      if (!dirPath || dirPath === projectDir) {
        setError(err instanceof Error ? err.message : String(err))
      }
    } finally {
      if (seqRef.current === expectedSeq) {
        setLoadingDirs((prev) => {
          if (!prev.has(key)) return prev
          const next = new Set(prev)
          next.delete(key)
          return next
        })
      }
    }
  }, [projectDir])

  // Load workspace root whenever projectDir changes.
  useEffect(() => {
    const seq = ++seqRef.current
    setEntriesByDir(new Map())
    setExpandedDirs(new Set())
    setLoadingDirs(new Set())
    setRootRealDir(null)
    setError(null)
    setFilter('')
    if (!projectDir) return
    void loadDir(null, seq)
  }, [projectDir, loadDir])

  const refreshTree = useCallback(() => {
    if (!projectDir) return
    const seq = ++seqRef.current
    const dirsToReload = [null, ...expandedRef.current]
    for (const dir of dirsToReload) {
      void loadDir(dir, seq)
    }
  }, [projectDir, loadDir])

  const toggleDir = useCallback((dirPath: string) => {
    setExpandedDirs((prev) => {
      const next = new Set(prev)
      if (next.has(dirPath)) {
        next.delete(dirPath)
      } else {
        next.add(dirPath)
        if (!entriesByDir.has(dirPath)) {
          void loadDir(dirPath, seqRef.current)
        }
      }
      return next
    })
  }, [entriesByDir, loadDir])

  const startResize = (e: PointerEvent) => {
    e.preventDefault()
    const x0 = e.clientX
    const w0 = width
    let w = w0
    const move = (ev: globalThis.PointerEvent) => {
      w = Math.min(TREE_MAX_W, Math.max(TREE_MIN_W, w0 + (ev.clientX - x0)))
      onResizeWidth(w)
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      document.body.style.cursor = ''
    }
    document.body.style.cursor = 'col-resize'
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  const rootKey = rootRealDir ?? projectDir ?? ''
  const rootEntries = rootKey ? (entriesByDir.get(rootKey) ?? []) : []
  const query = filter.trim().toLowerCase()

  const normActive = activeFilePath ? normPath(activeFilePath) : null
  const normActiveReal = activeRealPath ? normPath(activeRealPath) : null

  const normalizedDirty = useMemo(() => {
    const out = new Set<string>()
    for (const p of dirtyPaths) out.add(normPath(p))
    return out
  }, [dirtyPaths])

  // Aggregate git change indicators onto parent directories for quick scanning.
  const dirHasGitChange = useMemo(() => {
    const set = new Set<string>()
    if (!gitStatusByRelPath?.size) return set
    for (const rel of gitStatusByRelPath.keys()) {
      const parts = rel.split('/')
      for (let i = 1; i < parts.length; i++) {
        set.add(parts.slice(0, i).join('/'))
      }
    }
    return set
  }, [gitStatusByRelPath])

  const matchesFilter = useCallback((entry: EditorDirEntry): boolean => {
    if (!query) return true
    if (entry.name.toLowerCase().includes(query) || entry.relPath.toLowerCase().includes(query)) return true
    if (!entry.isDirectory) return false
    const children = entriesByDir.get(entry.path)
    return !!children?.some((child) => matchesFilter(child))
  }, [entriesByDir, query])

  const renderNodes = (entries: EditorDirEntry[], depth: number): ReactNode => {
    const visible = query ? entries.filter(matchesFilter) : entries
    return visible.map((entry) => {
      if (entry.isDirectory) {
        const expanded = expandedDirs.has(entry.path) || (!!query && entriesByDir.has(entry.path))
        const loading = loadingDirs.has(entry.path)
        const children = entriesByDir.get(entry.path) ?? []
        const hasChanges = dirHasGitChange.has(entry.relPath)
        return (
          <div key={entry.path}>
            <button
              type="button"
              onClick={() => toggleDir(entry.path)}
              style={{ paddingLeft: 8 + depth * 13 }}
              className="group flex h-6.5 w-full items-center gap-1 rounded-md pr-2 text-left text-[12px] text-ink-2 transition-colors hover:bg-black/[0.045] hover:text-ink dark:hover:bg-white/[0.06]"
              title={entry.relPath}
            >
              {loading ? (
                <Spinner size={11} className="shrink-0 text-ink-3" />
              ) : (
                <IconChevronRight
                  size={11}
                  className={`shrink-0 text-ink-3 transition-transform duration-100 ${expanded ? 'rotate-90' : ''}`}
                />
              )}
              <IconFolder size={13} className="shrink-0 text-ink-3" />
              <span className="min-w-0 flex-1 truncate">{entry.name}</span>
              {hasChanges && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-info/70" />}
            </button>
            {expanded && children.length > 0 && renderNodes(children, depth + 1)}
          </div>
        )
      }

      const normEntry = normPath(entry.path)
      const isActive = normEntry === normActive || normEntry === normActiveReal
      const isDirty = normalizedDirty.has(normEntry)
      const meta = resolveFileTypeMeta(entry.name)
      const gitStatus = gitStatusByRelPath?.get(entry.relPath)
      const gitBadge = gitStatus ? GIT_STATUS_STYLE[gitStatus] : undefined

      return (
        <button
          key={entry.path}
          type="button"
          onClick={() => onOpenFile(entry.path)}
          style={{ paddingLeft: 20 + depth * 13 }}
          title={entry.relPath}
          className={`flex h-6.5 w-full items-center gap-1.5 rounded-md pr-2 text-left text-[12px] transition-colors ${
            isActive
              ? 'bg-accent/12 font-medium text-ink dark:bg-accent/20'
              : 'text-ink-2 hover:bg-black/[0.045] hover:text-ink dark:hover:bg-white/[0.06]'
          }`}
        >
          <FileTypeIcon kind={meta.icon} size={13} className={`shrink-0 ${meta.color}`} />
          <span className="min-w-0 flex-1 truncate">{entry.name}</span>
          {isDirty && (
            <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" title={t('editor.unsaved')} />
          )}
          {gitBadge && (
            <span className={`shrink-0 font-mono text-[10.5px] font-semibold ${gitBadge.cls}`}>{gitBadge.label}</span>
          )}
        </button>
      )
    })
  }

  const rootLoading = !!projectDir && loadingDirs.has(projectDir) && rootEntries.length === 0

  return (
    <div
      className="relative flex h-full shrink-0 flex-col border-r border-hairline bg-surface-2/40 select-none"
      style={{ width }}
    >
      {/* Compact filter bar */}
      <div className="flex h-8 shrink-0 items-center gap-1 border-b border-hairline px-2">
        <div className="flex min-w-0 flex-1 items-center gap-1 rounded-md bg-surface px-1.5 py-0.5 shadow-[inset_0_0_0_1px_var(--ring)] focus-within:shadow-[inset_0_0_0_1px_var(--accent)]">
          <IconSearch size={11} className="shrink-0 text-ink-3" />
          <input
            type="text"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder={t('editor.treeFilterPlaceholder')}
            className="min-w-0 flex-1 bg-transparent text-[11.5px] text-ink outline-none placeholder:text-ink-3"
          />
          {filter && (
            <button
              type="button"
              onClick={() => setFilter('')}
              className="grid h-4 w-4 shrink-0 place-items-center rounded text-ink-3 hover:text-ink"
              aria-label={t('common.close')}
            >
              <IconX size={10} />
            </button>
          )}
        </div>
        <button
          type="button"
          onClick={refreshTree}
          disabled={!projectDir}
          title={t('editor.treeRefresh')}
          aria-label={t('editor.treeRefresh')}
          className="grid h-6 w-6 shrink-0 place-items-center rounded-md text-ink-3 transition-colors hover:bg-black/[0.06] hover:text-ink disabled:opacity-40 dark:hover:bg-white/[0.08]"
        >
          <IconRefresh size={12} />
        </button>
      </div>

      {/* Tree body */}
      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-1 py-1.5">
        {!projectDir ? (
          <div className="px-2.5 py-6 text-center text-[11.5px] text-ink-3">{t('editor.treeNoWorkspace')}</div>
        ) : rootLoading ? (
          <div className="flex items-center justify-center gap-1.5 py-6 text-[11.5px] text-ink-3">
            <Spinner size={12} />
            <span>{t('ext.loading')}</span>
          </div>
        ) : error ? (
          <div className="px-2.5 py-4 text-[11.5px] text-danger">{error}</div>
        ) : rootEntries.length === 0 ? (
          <div className="px-2.5 py-6 text-center text-[11.5px] text-ink-3">{t('editor.treeEmpty')}</div>
        ) : (
          renderNodes(rootEntries, 0)
        )}
      </div>

      {/* Right resize handle */}
      <div
        className="absolute inset-y-0 -right-1 z-10 w-2 cursor-col-resize transition-colors hover:bg-accent/25"
        onPointerDown={startResize}
        onDoubleClick={() => onResizeWidth(TREE_DEFAULT_W)}
        title={t('chg.resize')}
      />
    </div>
  )
}
