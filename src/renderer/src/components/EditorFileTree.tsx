import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { EditorDirEntry } from '@shared/editor'
import type { FileChange } from '@shared/types'
import { normalizedFilePathKey } from '@shared/fileResolve'
import { useEscape } from '../lib/escStack'
import { resolveFileTypeMeta } from '../lib/fileTypeMeta'
import { useApp } from '../state/AppContext'
import { t } from '../state/i18n'
import type { EditorFileTreePosition } from '../lib/editorLayout'
import { EditorResizeHandle } from './EditorResizeHandle'
import { FileTypeIcon } from './AttachmentBar'
import { IconChevronRight, IconCopy, IconExternal, IconFolder, IconRefresh, IconSearch, IconX, Spinner } from './icons'

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
  changedFiles: readonly FileChange[]
  width: number
  position: EditorFileTreePosition
  onResetWidth: () => void
  onResizeWidth: (width: number) => void
  onOpenFile: (absPath: string) => void
}

type TreeMenu = { entry: EditorDirEntry; x: number; y: number; trigger: HTMLElement }
const rowClass = 'flex h-6.5 w-full min-w-0 items-center gap-1.5 rounded-md pr-1 text-left text-[12px] transition-colors'
const rowHover = 'text-ink-2 hover:bg-fill hover:text-ink'
const menuItem = 'flex min-h-8 w-full items-center gap-2 rounded-md px-2.5 text-left text-[12px] text-ink hover:bg-fill focus:bg-fill focus:outline-none'

export function EditorFileTree({
  projectDir,
  activeFilePath,
  activeRealPath,
  dirtyPaths,
  changedFiles,
  width,
  position,
  onResetWidth,
  onResizeWidth,
  onOpenFile
}: EditorFileTreeProps) {
  const { toast } = useApp()
  const [entriesByDir, setEntriesByDir] = useState<Map<string, EditorDirEntry[]>>(() => new Map())
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(() => new Set())
  const [loadingDirs, setLoadingDirs] = useState<Set<string>>(() => new Set())
  const [rootRealDir, setRootRealDir] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState('')
  const [mode, setMode] = useState<'all' | 'modified'>('all')
  const [menu, setMenu] = useState<TreeMenu | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const seqRef = useRef(0)
  const expandedRef = useRef(expandedDirs)
  expandedRef.current = expandedDirs

  const closeMenu = useCallback((restoreFocus = true) => {
    if (restoreFocus) menu?.trigger.focus({ preventScroll: true })
    setMenu(null)
  }, [menu])
  useEscape(() => closeMenu(), menu !== null)

  useLayoutEffect(() => {
    const el = menuRef.current
    if (!menu || !el) return
    const margin = 6
    el.style.left = Math.max(margin, Math.min(menu.x, window.innerWidth - el.offsetWidth - margin)) + 'px'
    el.style.top = Math.max(margin, Math.min(menu.y, window.innerHeight - el.offsetHeight - margin)) + 'px'
    el.querySelector('button')?.focus({ preventScroll: true })
  }, [menu])

  useEffect(() => {
    if (!menu) return
    const outside = (event: globalThis.PointerEvent) => {
      if (event.target instanceof Node && !menuRef.current?.contains(event.target) && !menu.trigger.contains(event.target)) closeMenu(false)
    }
    const off = () => closeMenu()
    window.addEventListener('pointerdown', outside)
    window.addEventListener('resize', off)
    window.addEventListener('blur', off)
    return () => {
      window.removeEventListener('pointerdown', outside)
      window.removeEventListener('resize', off)
      window.removeEventListener('blur', off)
    }
  }, [menu, closeMenu])

  const runMenuAction = async (action: 'copy' | 'revealInFinder' | 'openExternal') => {
    if (!menu || !projectDir) return
    const { entry } = menu
    closeMenu()
    try {
      if (action === 'copy') {
        await window.agentswitch.sys.copy(entry.relPath)
        toast({ kind: 'success', title: t('common.copied') })
      } else {
        const result = await window.agentswitch.editor[action]({ path: entry.path, workspaceDir: projectDir })
        if (!result.ok) toast({ kind: 'error', title: t('editor.fileActionFailed'), desc: result.message })
      }
    } catch (error) {
      toast({ kind: 'error', title: t('editor.fileActionFailed'), desc: String(error) })
    }
  }

  const openContextMenu = (event: MouseEvent<HTMLDivElement>, entry: EditorDirEntry) => {
    event.preventDefault()
    const trigger = event.currentTarget.querySelector('button')
    if (!trigger) return
    const rect = trigger.getBoundingClientRect()
    setMenu({ entry, trigger, x: event.clientX || rect.left, y: event.clientY || rect.bottom })
  }

  const menuButton = (entry: EditorDirEntry) => (
    <button
      type="button" aria-haspopup="menu" aria-label={t('editor.fileActions')} title={t('editor.fileActions')}
      className="mr-1 grid size-6 shrink-0 place-items-center rounded text-ink-3 opacity-0 group-hover:opacity-100 hover:bg-fill focus-visible:opacity-100"
      onClick={(event) => {
        const trigger = event.currentTarget
        const r = trigger.getBoundingClientRect()
        if (menu?.trigger === trigger) closeMenu()
        else setMenu({ entry, trigger, x: r.left, y: r.bottom })
      }}
    >
      <span aria-hidden="true">⋯</span>
    </button>
  )

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
    setMode('all')
    setMenu(null)
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
    const next = new Set(expandedRef.current)
    if (next.has(dirPath)) next.delete(dirPath)
    else {
      next.add(dirPath)
      if (!entriesByDir.has(dirPath) && !loadingDirs.has(dirPath)) void loadDir(dirPath, seqRef.current)
    }
    expandedRef.current = next
    setExpandedDirs(next)
  }, [entriesByDir, loadingDirs, loadDir])

  const rootKey = rootRealDir ?? projectDir ?? ''
  const rootEntries = rootKey ? (entriesByDir.get(rootKey) ?? []) : []
  const query = filter.trim().toLowerCase()

  const normActive = activeFilePath ? normalizedFilePathKey(activeFilePath) : null
  const normActiveReal = activeRealPath ? normalizedFilePathKey(activeRealPath) : null

  const normalizedDirty = useMemo(() => {
    return new Set(Array.from(dirtyPaths, normalizedFilePathKey))
  }, [dirtyPaths])

  const gitStatusByRelPath = useMemo(() => new Map(changedFiles.map((file) => [file.path, file.status])), [changedFiles])
  // Aggregate git change indicators onto parent directories for quick scanning.
  const dirHasGitChange = useMemo(() => {
    const set = new Set<string>()
    for (const rel of gitStatusByRelPath.keys()) {
      const parts = rel.split('/')
      for (let i = 1; i < parts.length; i++) {
        set.add(parts.slice(0, i).join('/'))
      }
    }
    return set
  }, [gitStatusByRelPath])

  const matchesFilter = (entry: EditorDirEntry, parents: readonly string[]): boolean => {
    if (!query) return true
    if (entry.name.toLowerCase().includes(query) || entry.relPath.toLowerCase().includes(query)) return true
    if (!entry.isDirectory || parents.includes(entry.path)) return false
    const children = entriesByDir.get(entry.path)
    return !!children?.some((child) => matchesFilter(child, [...parents, entry.path]))
  }

  const fileRow = (entry: EditorDirEntry, depth: number, parentDir?: string, gitStatus = gitStatusByRelPath.get(entry.relPath)) => {
    const normEntry = normalizedFilePathKey(entry.path)
    const isActive = normEntry === normActive || normEntry === normActiveReal
    const meta = resolveFileTypeMeta(entry.name)
    const badge = gitStatus && GIT_STATUS_STYLE[gitStatus]
    return (
      <div key={entry.relPath} className="group flex items-center" onContextMenu={(event) => openContextMenu(event, entry)}>
        <button
          type="button" onClick={() => onOpenFile(entry.path)} title={entry.relPath}
          style={{ paddingLeft: (parentDir === undefined ? 20 : 8) + depth * 13 }}
          className={rowClass + (isActive ? ' bg-accent/12 font-medium text-ink dark:bg-accent/20' : ' ' + rowHover)}
          aria-current={isActive || undefined}
        >
          <FileTypeIcon kind={meta.icon} size={13} className={`shrink-0 ${meta.color}`} />
          <span className="min-w-0 truncate">{entry.name}</span>
          {parentDir && <span className="min-w-0 truncate text-[10.5px] text-ink-3">{parentDir}</span>}
          <span className="flex-1" />
          {normalizedDirty.has(normEntry) && (
            <span className="size-1.5 shrink-0 rounded-full bg-accent" title={t('editor.unsaved')} />
          )}
          {badge && <span className={`shrink-0 font-mono text-[10.5px] font-semibold ${badge.cls}`}>{badge.label}</span>}
        </button>
        {menuButton(entry)}
      </div>
    )
  }

  const renderNodes = (entries: EditorDirEntry[], parents: readonly string[]): ReactNode => {
    const visible = query ? entries.filter((entry) => matchesFilter(entry, parents)) : entries
    const depth = parents.length
    return visible.map((entry) => {
      if (entry.isDirectory) {
        const cycle = parents.includes(entry.path)
        const expanded = !cycle && (expandedDirs.has(entry.path) || (!!query && entriesByDir.has(entry.path)))
        const loading = loadingDirs.has(entry.path)
        const children = entriesByDir.get(entry.path) ?? []
        const hasChanges = dirHasGitChange.has(entry.relPath)
        return (
          <div key={entry.path}>
            <div className="group flex items-center" onContextMenu={(event) => openContextMenu(event, entry)}>
              <button
                type="button"
                onClick={() => toggleDir(entry.path)}
                style={{ paddingLeft: 8 + depth * 13 }}
                className={rowClass + ' ' + rowHover}
                title={entry.relPath}
                disabled={cycle}
                aria-expanded={expanded}
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
              {menuButton(entry)}
            </div>
            {expanded && children.length > 0 && renderNodes(children, [...parents, entry.path])}
          </div>
        )
      }

      return fileRow(entry, depth)
    })
  }

  const rootLoading = !!projectDir && loadingDirs.has(projectDir) && rootEntries.length === 0
  const modifiedFiles = mode === 'modified' ? changedFiles.filter((file) => file.path.toLowerCase().includes(query)) : []

  return (
    <div
      data-editor-file-tree
      className={`relative flex h-full min-w-0 shrink-0 flex-col border-hairline bg-surface-2/40 select-none ${position === 'left' ? 'border-r' : 'order-1 border-l'}`}
      style={{ width }}
    >
      <div className="mx-2 mt-2 flex shrink-0 gap-0.5 rounded-md bg-fill p-0.5">
        {(['all', 'modified'] as const).map((item) => (
          <button
            key={item} type="button" onClick={() => setMode(item)} aria-pressed={mode === item}
            className={`flex min-w-0 flex-1 items-center justify-center gap-1 rounded px-1 py-0.5 text-[11px] ${mode === item ? 'bg-surface font-medium text-ink shadow-sm' : 'text-ink-3 hover:text-ink'}`}
          >
            <span className="truncate">{t(item === 'all' ? 'editor.treeAll' : 'editor.treeModified')}</span>
            {item === 'modified' && changedFiles.length > 0 && (
              <span className="rounded bg-fill px-1 font-mono text-[10px]">{changedFiles.length}</span>
            )}
          </button>
        ))}
      </div>
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
        {mode === 'all' && <button
          type="button"
          onClick={refreshTree}
          disabled={!projectDir}
          title={t('editor.treeRefresh')}
          aria-label={t('editor.treeRefresh')}
          className="grid h-6 w-6 shrink-0 place-items-center rounded-md text-ink-3 transition-colors hover:bg-black/[0.06] hover:text-ink disabled:opacity-40 dark:hover:bg-white/[0.08]"
        >
          <IconRefresh size={12} />
        </button>}
      </div>

      {/* Tree body */}
      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-1 py-1.5">
        {!projectDir ? (
          <div className="px-2.5 py-6 text-center text-[11.5px] text-ink-3">{t('editor.treeNoWorkspace')}</div>
        ) : mode === 'modified' ? (
          modifiedFiles.length ? modifiedFiles.map((file) => {
            const split = file.path.lastIndexOf('/')
            return fileRow({ path: file.abs, relPath: file.path, name: file.path.slice(split + 1), isDirectory: false },
              0, split < 0 ? '' : file.path.slice(0, split), file.status)
          }) : (
            <div className="px-2.5 py-6 text-center text-[11.5px] text-ink-3">
              {t(query && changedFiles.length ? 'editor.treeNoMatches' : 'editor.treeModifiedEmpty')}
            </div>
          )
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
          renderNodes(rootEntries, [])
        )}
      </div>

      <EditorResizeHandle edge={position === 'left' ? 'right' : 'left'} size={width}
        onResize={onResizeWidth} onReset={onResetWidth} />
      {menu && createPortal(
        <div ref={menuRef} role="menu" aria-label={t('editor.fileActions')} data-editor-panel
          className="fixed z-[80] w-52 rounded-lg bg-surface p-1 shadow-[0_0_0_1px_var(--ring),0_8px_24px_rgba(0,0,0,0.2)]"
          onContextMenu={(event) => event.preventDefault()}
          onBlur={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget)) closeMenu(false)
          }}
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && ['a', 'f', 's'].includes(event.key.toLowerCase())) {
              event.preventDefault()
              event.stopPropagation()
              return
            }
            if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
            event.preventDefault()
            const items = Array.from(event.currentTarget.querySelectorAll('button'))
            const index = items.indexOf(document.activeElement as HTMLButtonElement)
            items[(index + items.length + (event.key === 'ArrowDown' ? 1 : -1)) % items.length]?.focus()
          }}
        >
          <button type="button" role="menuitem" className={menuItem} onClick={() => void runMenuAction('copy')}>
            <IconCopy size={13} />{t('editor.copyRelPath')}
          </button>
          <button type="button" role="menuitem" className={menuItem} onClick={() => void runMenuAction('revealInFinder')}>
            <IconFolder size={13} />{t('common.showInFinder')}
          </button>
          {!menu.entry.isDirectory && <button type="button" role="menuitem" className={menuItem} onClick={() => void runMenuAction('openExternal')}>
            <IconExternal size={13} />{t('editor.openExternal')}
          </button>}
        </div>,
        document.body
      )}
    </div>
  )
}
