import { Fragment, useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'
import { openSearchPanel } from '@codemirror/search'
import { EditorView } from '@codemirror/view'
import type { FileChange } from '@shared/types'
import { detectIndentInfo } from '../lib/codeEditorTheme'
import { loadWorkspaceEditorState, loadWorkspaceTreeOpen, saveWorkspaceEditorState } from '../lib/editorPersistence'
import { escLayers, useFocusCloseHandler } from '../lib/escStack'
import { resolveFileTypeMeta } from '../lib/fileTypeMeta'
import { btnPrimary, btnSecondary } from '../lib/ui'
import { isTabDirty, type EditorTab, type EditorViewMode, type PendingClosePrompt } from '../state/useCodeEditor'
import { t } from '../state/i18n'
import { FileTypeIcon } from './AttachmentBar'
import { CodeDiffView } from './CodeDiffView'
import { CodeEditor, type EditorCursorStatus, type EditorSelectionRange } from './CodeEditor'
import { EditorFileTree, TREE_DEFAULT_W, TREE_MAX_W, TREE_MIN_W } from './EditorFileTree'
import { EditorImagePreview, fmtBytes } from './EditorImagePreview'
import { Markdown, MarkdownBase } from './Markdown'
import { Modal } from './common'
import {
  IconAlert,
  IconCheck,
  IconChevronRight,
  IconDiff,
  IconExternal,
  IconFile,
  IconFolder,
  IconFolderTree,
  IconMaximize,
  IconMinimize,
  IconRefresh,
  IconX,
  Spinner
} from './icons'

const WIDTH_KEY = 'agentswitch.editorWidth'
const DEFAULT_W = 540
const MIN_W = 360
const MAX_W = 1100

const LANGUAGE_LABELS: Readonly<Record<string, string>> = {
  typescript: 'TypeScript',
  tsx: 'TypeScript JSX',
  javascript: 'JavaScript',
  jsx: 'JavaScript JSX',
  json: 'JSON',
  markdown: 'Markdown',
  html: 'HTML',
  vue: 'Vue',
  svelte: 'Svelte',
  css: 'CSS',
  scss: 'SCSS',
  sass: 'Sass',
  less: 'Less',
  python: 'Python',
  go: 'Go',
  rust: 'Rust',
  java: 'Java',
  kotlin: 'Kotlin',
  swift: 'Swift',
  c: 'C',
  cpp: 'C++',
  shell: 'Shell',
  yaml: 'YAML',
  toml: 'TOML',
  xml: 'XML',
  ini: 'INI',
  env: 'Env',
  sql: 'SQL',
  dockerfile: 'Dockerfile',
  makefile: 'Makefile',
  ruby: 'Ruby',
  php: 'PHP',
  plaintext: 'Plain Text'
}

function clampWidth(val: number | undefined): number {
  const fallback = Number(localStorage.getItem(WIDTH_KEY)) || DEFAULT_W
  const candidate = typeof val === 'number' && Number.isFinite(val) ? val : fallback
  return Math.min(MAX_W, Math.max(MIN_W, candidate))
}

function clampTreeWidth(val: number | undefined): number {
  const candidate = typeof val === 'number' && Number.isFinite(val) ? val : TREE_DEFAULT_W
  return Math.min(TREE_MAX_W, Math.max(TREE_MIN_W, candidate))
}

function breadcrumbSegments(filePath: string, projectDir: string | null): string[] {
  const normFile = filePath.replace(/\\/g, '/')
  if (projectDir) {
    const normProj = projectDir.replace(/\\/g, '/').replace(/\/+$/, '')
    if (normFile.startsWith(normProj + '/')) {
      return normFile.slice(normProj.length + 1).split('/').filter(Boolean)
    }
  }
  const parts = normFile.split('/').filter(Boolean)
  if (parts.length <= 4) return parts
  return ['…', ...parts.slice(-3)]
}

const iconBtn =
  'no-drag grid h-7 w-7 shrink-0 place-items-center rounded-lg text-ink-3 transition-colors hover:bg-black/[0.06] hover:text-ink dark:hover:bg-white/[0.08] disabled:opacity-40'

export interface CodeEditorPanelProps {
  tabs: EditorTab[]
  activeTab: EditorTab | null
  projectDir: string | null
  home: string | null
  maximized: boolean
  focusToken: number
  pendingClose: PendingClosePrompt | null
  changedFiles: readonly FileChange[]
  onToggleMaximize: () => void
  onSelectTab: (tabId: string) => void
  onSelectAdjacentTab: (delta: -1 | 1) => void
  onOpenFile: (absPath: string) => void
  onSetTabViewMode: (tabId: string, mode: EditorViewMode) => void
  onCloseTab: (tabId: string) => void
  onClosePanel: () => void
  onChangeContent: (tabId: string, content: string) => void
  onSaveTab: (tabId: string, options?: { force?: boolean }) => void
  onReloadTab: (tabId: string) => void
  onDismissExternalChange: (tabId: string) => void
  onOpenConflictDiff: (tabId: string) => void
  onToggleUnsavedDiff: (tabId: string) => void
  onExitDiff: (tabId: string) => void
  onResolvePendingClose: (action: 'save' | 'discard' | 'cancel') => void
  onReferenceToChat?: (payload: {
    path: string
    realPath: string | null
    workspaceDir: string | null
    lineRange: EditorSelectionRange | null
  }) => void
}

export function CodeEditorPanel({
  tabs,
  activeTab,
  projectDir,
  home,
  maximized,
  focusToken,
  pendingClose,
  changedFiles,
  onToggleMaximize,
  onSelectTab,
  onSelectAdjacentTab,
  onOpenFile,
  onSetTabViewMode,
  onCloseTab,
  onClosePanel,
  onChangeContent,
  onSaveTab,
  onReloadTab,
  onDismissExternalChange,
  onOpenConflictDiff,
  onToggleUnsavedDiff,
  onExitDiff,
  onResolvePendingClose,
  onReferenceToChat
}: CodeEditorPanelProps) {
  const panelRef = useRef<HTMLElement>(null)
  const [width, setWidth] = useState(() => clampWidth(loadWorkspaceEditorState(projectDir)?.width))
  const [treeOpen, setTreeOpen] = useState(() => loadWorkspaceTreeOpen(projectDir))
  const [treeWidth, setTreeWidth] = useState(() => clampTreeWidth(loadWorkspaceEditorState(projectDir)?.treeWidth))
  const [cursor, setCursor] = useState<EditorCursorStatus>({ line: 1, col: 1, selectedLines: 0, selectedChars: 0 })

  // Restore panel and tree preferences for the selected workspace.
  useEffect(() => {
    const saved = loadWorkspaceEditorState(projectDir)
    setWidth(clampWidth(saved?.width))
    setTreeWidth(clampTreeWidth(saved?.treeWidth))
    setTreeOpen(loadWorkspaceTreeOpen(projectDir))
  }, [projectDir])

  // Reset cursor readout when switching tabs.
  useEffect(() => {
    setCursor({ line: 1, col: 1, selectedLines: 0, selectedChars: 0 })
  }, [activeTab?.id])

  const toggleTree = () => {
    const next = !treeOpen
    setTreeOpen(next)
    saveWorkspaceEditorState(projectDir, { treeOpen: next })
  }

  const closeActive = () => {
    if (activeTab) onCloseTab(activeTab.id)
    else onClosePanel()
  }

  useFocusCloseHandler(() => {
    const panel = panelRef.current
    const activeEl = document.activeElement
    if (!panel || !activeEl || !panel.contains(activeEl)) return false
    closeActive()
    return true
  })

  // Keep an in-panel focus target if closing a tab removes the focused element.
  useEffect(() => {
    if (document.activeElement === document.body) {
      panelRef.current?.focus({ preventScroll: true })
    }
  }, [activeTab?.id, activeTab?.status, activeTab?.viewMode])

  useEffect(() => {
    const panel = panelRef.current
    if (focusToken && panel && !panel.contains(document.activeElement)) panel.focus({ preventScroll: true })
  }, [focusToken])

  const onPanelKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    const target = event.target
    if (event.defaultPrevented || event.nativeEvent.isComposing || !(target instanceof HTMLElement) ||
        !event.currentTarget.contains(target) || escLayers() > 0) return

    const key = event.key.toLowerCase()
    const mod = event.metaKey || event.ctrlKey
    const textInput = target.closest('input, textarea, select, [contenteditable="true"]')
    const inCodeMirror = target.closest('.cm-editor')
    if (key === 'escape') {
      event.stopPropagation()
      if (activeTab && activeTab.diffMode !== 'none') {
        event.preventDefault()
        onExitDiff(activeTab.id)
      }
      return
    }
    if (!mod || event.shiftKey) return
    if (event.altKey) {
      if (tabs.length > 1 && (key === 'arrowleft' || key === 'arrowright')) {
        event.preventDefault()
        event.stopPropagation()
        onSelectAdjacentTab(key === 'arrowleft' ? -1 : 1)
      }
      return
    }
    if ((key === 'a' && (inCodeMirror || textInput)) || (key === 'f' && inCodeMirror)) return
    if (!['a', 'b', 'f', 's', 'w'].includes(key)) return
    event.preventDefault()
    event.stopPropagation()
    switch (key) {
      case 'a': {
        const preview = target.closest('[data-editor-markdown-preview]')
        const selection = window.getSelection()
        if (preview && selection) {
          const range = document.createRange()
          range.selectNodeContents(preview)
          selection.removeAllRanges()
          selection.addRange(range)
        }
        break
      }
      case 'b': {
        if (!projectDir) break
        if (treeOpen && target.closest('[data-editor-file-tree]')) panelRef.current?.focus()
        toggleTree()
        break
      }
      case 'f': {
        const editor = panelRef.current?.querySelector<HTMLElement>('.cm-agentswitch-host')
        const view = !textInput && editor && EditorView.findFromDOM(editor)
        if (view) {
          view.focus()
          openSearchPanel(view)
        }
        break
      }
      case 's':
        if (activeTab?.status === 'ready') onSaveTab(activeTab.id)
        break
      case 'w':
        closeActive()
        break
    }
  }

  const persistWidth = (w: number) => {
    localStorage.setItem(WIDTH_KEY, String(w))
    if (projectDir) saveWorkspaceEditorState(projectDir, { width: w })
  }

  const startDrag = (e: PointerEvent) => {
    if (maximized) return
    e.preventDefault()
    const x0 = e.clientX
    const w0 = width
    let w = w0
    const move = (ev: globalThis.PointerEvent) => {
      w = Math.min(MAX_W, Math.max(MIN_W, w0 + (x0 - ev.clientX)))
      setWidth(w)
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      document.body.style.cursor = ''
      persistWidth(w)
    }
    document.body.style.cursor = 'col-resize'
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  const handleResizeTree = (nextW: number) => {
    const clamped = clampTreeWidth(nextW)
    setTreeWidth(clamped)
    if (projectDir) saveWorkspaceEditorState(projectDir, { treeWidth: clamped })
  }

  const dirty = activeTab ? isTabDirty(activeTab) : false
  const dirtyPaths = useMemo(() => {
    const set = new Set<string>()
    for (const tab of tabs) {
      if (isTabDirty(tab)) {
        set.add(tab.path)
        if (tab.realPath) set.add(tab.realPath)
      }
    }
    return set
  }, [tabs])

  const indentInfo = useMemo(
    () => (activeTab?.status === 'ready' ? detectIndentInfo(activeTab.content) : null),
    // Re-evaluate indent style when switching files or reloading from disk rather than every keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [activeTab?.id, activeTab?.status, activeTab?.syncVersion]
  )

  const canExternalAction =
    !!activeTab &&
    activeTab.error?.code !== 'OUT_OF_BOUNDS' &&
    activeTab.error?.code !== 'NOT_FOUND'
  const crumbs = activeTab ? breadcrumbSegments(activeTab.realPath ?? activeTab.path, activeTab.workspaceDir ?? projectDir) : []
  const showingDiff = activeTab?.status === 'ready' && activeTab.diffMode !== 'none'
  const isSvg = !!activeTab && /\.svg$/i.test(activeTab.realPath ?? activeTab.path)
  const isMarkdown = activeTab?.language === 'markdown'
  const canSwitchView = activeTab?.status === 'ready' && !showingDiff && (isSvg || isMarkdown)
  const showingPreview = canSwitchView && activeTab.viewMode === 'preview'
  const showingImage = activeTab?.status === 'image' || (showingPreview && isSvg)
  const markdownPath = activeTab?.realPath ?? activeTab?.path ?? ''
  const markdownPosix = markdownPath.startsWith('/') ? markdownPath : markdownPath.replace(/\\/g, '/')
  const markdownDir = markdownPosix.slice(0, markdownPosix.lastIndexOf('/')) || '/'

  const revealInFinder = () => {
    if (!activeTab) return
    void window.agentswitch.editor.revealInFinder({
      path: activeTab.path,
      workspaceDir: activeTab.workspaceDir ?? projectDir
    })
  }

  const openExternal = () => {
    if (!activeTab) return
    void window.agentswitch.editor.openExternal({
      path: activeTab.path,
      workspaceDir: activeTab.workspaceDir ?? projectDir
    })
  }

  return (
    <aside
      ref={panelRef}
      data-editor-panel
      tabIndex={-1}
      onKeyDown={onPanelKeyDown}
      className={`relative flex h-full min-w-0 flex-col border-l border-hairline bg-surface outline-none ${maximized ? 'flex-1' : 'shrink-0'}`}
      style={maximized ? undefined : { width }}
    >
      {!maximized && (
        <div
          className="absolute inset-y-0 -left-1 z-20 w-2 cursor-col-resize transition-colors hover:bg-accent/25"
          onPointerDown={startDrag}
          onDoubleClick={() => {
            setWidth(DEFAULT_W)
            persistWidth(DEFAULT_W)
          }}
          title={t('chg.resize')}
        />
      )}

      {/* Top Tab Bar + Action Controls */}
      <div className="drag flex h-11 shrink-0 items-center gap-1 border-b border-hairline bg-surface-2/80 pr-2 pl-1.5">
        <button
          type="button"
          onClick={toggleTree}
          disabled={!projectDir}
          className={`${iconBtn} ${treeOpen ? 'bg-black/[0.06] text-accent dark:bg-white/[0.08]' : ''}`}
          title={`${t('editor.toggleTree')} (⌘B)`}
          aria-label={t('editor.toggleTree')}
          aria-pressed={treeOpen}
        >
          <IconFolderTree size={15} />
        </button>

        <div className="no-drag flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto overflow-y-hidden py-1">
          {tabs.map((tab) => {
            const selected = activeTab?.id === tab.id
            const tabDirty = isTabDirty(tab)
            const meta = resolveFileTypeMeta(tab.name)
            return (
              <div
                key={tab.id}
                title={tab.path}
                onMouseDown={(e) => {
                  if (e.button === 1) {
                    e.preventDefault()
                    onCloseTab(tab.id)
                  }
                }}
                className={`group flex h-8 max-w-[180px] shrink-0 items-center gap-1.5 rounded-lg pr-1 pl-2 text-[12px] transition-colors ${
                  selected
                    ? 'bg-surface font-medium text-ink shadow-[0_0_0_1px_var(--ring)]'
                    : 'text-ink-2 hover:bg-black/[0.04] hover:text-ink dark:hover:bg-white/[0.06]'
                }`}
              >
                <button
                  type="button"
                  onClick={() => onSelectTab(tab.id)}
                  className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
                >
                  <FileTypeIcon kind={meta.icon} size={13} className={`shrink-0 ${meta.color}`} />
                  <span className="truncate">{tab.name}</span>
                </button>
                {tabDirty && (
                  <span
                    className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent group-hover:hidden"
                    title={t('editor.unsaved')}
                  />
                )}
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation()
                    onCloseTab(tab.id)
                  }}
                  title={t('common.close')}
                  aria-label={t('common.close')}
                  className={`grid h-5 w-5 shrink-0 place-items-center rounded text-ink-3 transition-opacity hover:bg-black/[0.08] hover:text-ink dark:hover:bg-white/[0.12] ${
                    tabDirty
                      ? 'hidden group-hover:grid'
                      : selected
                        ? 'opacity-70 hover:opacity-100'
                        : 'opacity-0 group-hover:opacity-80 hover:!opacity-100'
                  }`}
                >
                  <IconX size={11} />
                </button>
              </div>
            )
          })}
        </div>

        <div className="no-drag flex shrink-0 items-center gap-0.5 border-l border-hairline pl-1.5">
          {activeTab?.status === 'ready' && (
            <button
              type="button"
              onClick={() => onSaveTab(activeTab.id)}
              disabled={activeTab.saving || (!dirty && !activeTab.conflictMtimeMs)}
              title={`${t('common.save')} (⌘S)`}
              className={`flex h-7 items-center gap-1 rounded-lg px-2 text-[12px] font-medium transition-colors ${
                dirty || activeTab.conflictMtimeMs
                  ? 'bg-accent text-white hover:bg-accent-hover disabled:opacity-50'
                  : 'text-ink-3 disabled:opacity-45'
              }`}
            >
              {activeTab.saving ? <Spinner size={12} /> : <IconCheck size={12} />}
              <span>{t('common.save')}</span>
            </button>
          )}
          {activeTab?.status === 'ready' && (dirty || activeTab.diffMode === 'unsaved') && (
            <button
              type="button"
              onClick={() => onToggleUnsavedDiff(activeTab.id)}
              className={`${iconBtn} ${activeTab.diffMode === 'unsaved' ? 'bg-black/[0.06] text-accent dark:bg-white/[0.08]' : ''}`}
              title={t('editor.compareSaved')}
              aria-label={t('editor.compareSaved')}
              aria-pressed={activeTab.diffMode === 'unsaved'}
            >
              <IconDiff size={14} />
            </button>
          )}
          {canExternalAction && !showingImage && (
            <>
              <button type="button" onClick={revealInFinder} className={iconBtn} title={t('common.showInFinder')} aria-label={t('common.showInFinder')}>
                <IconFolder size={14} />
              </button>
              <button type="button" onClick={openExternal} className={iconBtn} title={t('editor.openExternal')} aria-label={t('editor.openExternal')}>
                <IconExternal size={14} />
              </button>
            </>
          )}
          <button
            type="button"
            onClick={onToggleMaximize}
            className={iconBtn}
            title={t(maximized ? 'editor.restore' : 'editor.maximize')}
            aria-label={t(maximized ? 'editor.restore' : 'editor.maximize')}
          >
            {maximized ? <IconMinimize size={14} /> : <IconMaximize size={14} />}
          </button>
          <button type="button" onClick={onClosePanel} className={iconBtn} title={t('common.close')} aria-label={t('common.close')}>
            <IconX size={14} />
          </button>
        </div>
      </div>

      {/* Relative Path Breadcrumbs */}
      {activeTab && (
        <div className="flex h-7 shrink-0 items-center gap-1 border-b border-hairline bg-surface px-3 text-[11.5px] text-ink-3">
          <div className="flex min-w-0 flex-1 items-center gap-0.5 overflow-hidden font-mono" title={activeTab.realPath ?? activeTab.path}>
            {crumbs.map((seg, i) => (
              <Fragment key={`${i}:${seg}`}>
                {i > 0 && <IconChevronRight size={10} className="shrink-0 opacity-55" />}
                <span className={`truncate ${i === crumbs.length - 1 ? 'font-medium text-ink-2' : ''}`}>{seg}</span>
              </Fragment>
            ))}
          </div>
          {canSwitchView && (
            <div className="flex shrink-0 gap-0.5 rounded-md bg-fill p-0.5">
              {(['source', 'preview'] as const).map((mode) => (
                <button key={mode} type="button" aria-pressed={activeTab.viewMode === mode}
                  onClick={() => onSetTabViewMode(activeTab.id, mode)}
                  className={`rounded px-2 text-[11px] ${activeTab.viewMode === mode ? 'bg-surface font-medium text-ink shadow-sm' : 'text-ink-3 hover:text-ink'}`}>
                  {t(mode === 'source' ? 'editor.modeSource' : 'editor.modePreview')}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Save Conflict Banner */}
      {activeTab?.conflictMtimeMs !== null && activeTab?.status === 'ready' && activeTab.diffMode !== 'conflict' && (
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-danger/25 bg-danger-soft px-3 py-2 text-[12px] text-danger">
          <IconAlert size={14} className="shrink-0" />
          <span className="min-w-0 flex-1 font-medium">{t('editor.conflictBanner')}</span>
          <button
            type="button"
            disabled={activeTab.loadingDiff}
            onClick={() => onOpenConflictDiff(activeTab.id)}
            className="inline-flex items-center gap-1 rounded-md bg-surface px-2.5 py-1 text-[11.5px] font-medium text-ink shadow-[0_0_0_1px_var(--ring)] hover:bg-surface-2 disabled:opacity-50"
          >
            {activeTab.loadingDiff ? <Spinner size={11} /> : <IconDiff size={12} />}
            {t('editor.viewDiff')}
          </button>
          <button
            type="button"
            onClick={() => onReloadTab(activeTab.id)}
            className="rounded-md bg-surface px-2.5 py-1 text-[11.5px] font-medium text-ink shadow-[0_0_0_1px_var(--ring)] hover:bg-surface-2"
          >
            {t('editor.loadDisk')}
          </button>
          <button
            type="button"
            onClick={() => onSaveTab(activeTab.id, { force: true })}
            className="rounded-md bg-danger px-2.5 py-1 text-[11.5px] font-medium text-white hover:opacity-90"
          >
            {t('editor.forceOverwrite')}
          </button>
        </div>
      )}

      {/* External Modification / Deletion Banner */}
      {activeTab && activeTab.conflictMtimeMs === null && activeTab.externalChange && activeTab.status === 'ready' && activeTab.diffMode !== 'conflict' && (
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-warn/30 bg-warn-soft px-3 py-2 text-[12px] text-warn">
          <IconAlert size={14} className="shrink-0" />
          <span className="min-w-0 flex-1 font-medium">
            {t(activeTab.externalChange === 'deleted' ? 'editor.externalDeleted' : 'editor.externalModified')}
          </span>
          {activeTab.externalChange === 'modified' && (
            <>
              <button
                type="button"
                disabled={activeTab.loadingDiff}
                onClick={() => onOpenConflictDiff(activeTab.id)}
                className="inline-flex items-center gap-1 rounded-md bg-surface px-2.5 py-1 text-[11.5px] font-medium text-ink shadow-[0_0_0_1px_var(--ring)] hover:bg-surface-2 disabled:opacity-50"
              >
                {activeTab.loadingDiff ? <Spinner size={11} /> : <IconDiff size={12} />}
                {t('editor.viewDiff')}
              </button>
              <button
                type="button"
                onClick={() => onReloadTab(activeTab.id)}
                className="flex items-center gap-1 rounded-md bg-surface px-2.5 py-1 text-[11.5px] font-medium text-ink shadow-[0_0_0_1px_var(--ring)] hover:bg-surface-2"
              >
                <IconRefresh size={11} />
                {t('editor.reload')}
              </button>
            </>
          )}
          <button
            type="button"
            onClick={() => onDismissExternalChange(activeTab.id)}
            className="rounded-md px-2 py-1 text-[11.5px] font-medium text-warn hover:bg-black/[0.06] dark:hover:bg-white/[0.08]"
          >
            {t('editor.keepMine')}
          </button>
        </div>
      )}

      {/* Main Workspace Split: Optional File Tree + Code/Diff Editor */}
      <div className="flex min-h-0 flex-1 overflow-hidden">
        {treeOpen && projectDir && (
          <EditorFileTree
            projectDir={projectDir}
            activeFilePath={activeTab?.path ?? null}
            activeRealPath={activeTab?.realPath ?? null}
            dirtyPaths={dirtyPaths}
            changedFiles={changedFiles}
            width={treeWidth}
            onResizeWidth={handleResizeTree}
            onOpenFile={onOpenFile}
          />
        )}

        <div className="min-h-0 min-w-0 flex-1 overflow-hidden">
          {!activeTab ? (
            <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center text-[13px] text-ink-3">
              <IconFile size={24} className="opacity-50" />
              <span>{t(projectDir ? 'editor.empty' : 'editor.treeNoWorkspace')}</span>
            </div>
          ) : activeTab.status === 'loading' ? (
            <div className="flex h-full items-center justify-center gap-2 text-[13px] text-ink-3">
              <Spinner size={16} />
              <span>{t('ext.loading')}</span>
            </div>
          ) : activeTab.status === 'error' ? (
            <EditorBlockedState
              tab={activeTab}
              canExternalAction={canExternalAction}
              onReveal={revealInFinder}
              onOpenExternal={openExternal}
            />
          ) : showingDiff ? (
            <CodeDiffView
              mode={activeTab.diffMode === 'conflict' ? 'conflict' : 'unsaved'}
              original={activeTab.diffMode === 'conflict' ? (activeTab.diskContent ?? activeTab.savedContent) : activeTab.savedContent}
              modified={activeTab.content}
              language={activeTab.language}
              saving={activeTab.saving}
              onAcceptDisk={activeTab.diffMode === 'conflict' ? () => onReloadTab(activeTab.id) : undefined}
              onKeepMineAndSave={activeTab.diffMode === 'conflict' ? () => onSaveTab(activeTab.id, { force: true }) : undefined}
              onExit={() => onExitDiff(activeTab.id)}
            />
          ) : showingImage ? (
            <EditorImagePreview
              key={activeTab.id}
              path={activeTab.path}
              realPath={activeTab.realPath}
              name={activeTab.name}
              size={activeTab.size}
              syncVersion={activeTab.syncVersion}
              onReveal={revealInFinder}
              onOpenExternal={openExternal}
            />
          ) : showingPreview ? (
            <div data-editor-markdown-preview tabIndex={0} className="h-full overflow-auto p-4 text-[13px] outline-none select-text">
              <MarkdownBase.Provider value={{ baseDir: markdownDir, home, projectDir, onOpenEditorFile: onOpenFile }}>
                <Markdown text={activeTab.content} />
              </MarkdownBase.Provider>
            </div>
          ) : (
            <CodeEditor
              fileKey={activeTab.id}
              value={activeTab.content}
              language={activeTab.language}
              syncVersion={activeTab.syncVersion}
              focusToken={focusToken}
              onChange={(next) => onChangeContent(activeTab.id, next)}
              onSave={() => onSaveTab(activeTab.id)}
              onCursorChange={setCursor}
              addToChatLabel={t('editor.addToChat')}
              onReferenceToChat={onReferenceToChat && ((lineRange) => onReferenceToChat({
                path: activeTab.path,
                realPath: activeTab.realPath,
                workspaceDir: activeTab.workspaceDir,
                lineRange
              }))}
            />
          )}
        </div>
      </div>

      {/* Compact Single-Row Bottom Status Bar (25px) */}
      {activeTab?.status === 'ready' && !showingImage && (
        <div className="flex h-[25px] shrink-0 items-center justify-between gap-3 border-t border-hairline bg-surface-2/75 px-3 text-[11px] text-ink-3 select-none">
          <div className="flex min-w-0 items-center gap-2 tabular-nums">
            {!showingDiff && !showingPreview && (
              <>
                <span className="truncate">{t('editor.statusCursor', { line: cursor.line, col: cursor.col })}</span>
                {cursor.selectedChars > 0 && (
                  <span className="truncate text-ink-2">
                    · {t('editor.statusSelection', { lines: cursor.selectedLines, chars: cursor.selectedChars })}
                  </span>
                )}
              </>
            )}
            {showingDiff && (
              <span className="truncate font-medium text-accent">{t('editor.statusDiff')}</span>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-2.5 tabular-nums">
            {activeTab.conflictMtimeMs !== null && (
              <span className="rounded bg-danger-soft px-1.5 py-px font-medium text-danger">{t('editor.statusConflict')}</span>
            )}
            {activeTab.conflictMtimeMs === null && activeTab.externalChange && (
              <span className="rounded bg-warn-soft px-1.5 py-px font-medium text-warn">{t('editor.statusModified')}</span>
            )}
            {(showingDiff || showingPreview) && (
              <span className="rounded bg-fill px-1.5 py-px text-ink-2">{t('editor.statusReadOnly')}</span>
            )}
            <span>{LANGUAGE_LABELS[activeTab.language] ?? activeTab.language}</span>
            {indentInfo && (
              <span>{indentInfo.kind === 'tabs' ? `Tabs: ${indentInfo.size}` : `Spaces: ${indentInfo.size}`}</span>
            )}
            <span>{activeTab.eol}</span>
          </div>
        </div>
      )}

      {/* Unsaved Changes Confirmation Modal */}
      {pendingClose && (
        <Modal onClose={() => onResolvePendingClose('cancel')} width={420}>
          <div role="alertdialog" aria-label={t('editor.unsavedTitle')} className="space-y-4 p-6">
            <div className="space-y-1.5">
              <h2 className="text-[15px] font-semibold text-ink">{t('editor.unsavedTitle')}</h2>
              <p className="text-[13px] leading-relaxed text-ink-2">
                {pendingClose.names.length === 1
                  ? t('editor.unsavedSingle', { name: pendingClose.names[0] })
                  : t('editor.unsavedMulti', { n: pendingClose.names.length })}
              </p>
            </div>
            <div className="flex items-center justify-end gap-2">
              <button type="button" className={btnSecondary} onClick={() => onResolvePendingClose('cancel')}>
                {t('common.cancel')}
              </button>
              <button
                type="button"
                className="h-9 rounded-xl px-3.5 text-[13px] font-medium text-danger transition-colors hover:bg-danger-soft"
                onClick={() => onResolvePendingClose('discard')}
              >
                {t('editor.discardChanges')}
              </button>
              <button type="button" autoFocus className={btnPrimary} onClick={() => onResolvePendingClose('save')}>
                {t('editor.saveAndClose')}
              </button>
            </div>
          </div>
        </Modal>
      )}
    </aside>
  )
}

function EditorBlockedState({
  tab,
  canExternalAction,
  onReveal,
  onOpenExternal
}: {
  tab: EditorTab
  canExternalAction: boolean
  onReveal: () => void
  onOpenExternal: () => void
}) {
  const code = tab.error?.code
  const title =
    code === 'FILE_TOO_LARGE'
      ? t('editor.errTooLargeTitle')
      : code === 'BINARY_FILE'
        ? t('editor.errBinaryTitle')
        : code === 'OUT_OF_BOUNDS'
          ? t('editor.errOutOfBoundsTitle')
          : code === 'NOT_FOUND'
            ? t('editor.errNotFoundTitle')
            : t('editor.errGenericTitle')

  const desc =
    code === 'FILE_TOO_LARGE'
      ? t('editor.errTooLargeDesc', { size: tab.error?.size ? fmtBytes(tab.error.size) : '> 2 MB' })
      : code === 'BINARY_FILE'
        ? tab.error?.size !== undefined
          ? t('editor.errBinaryDescWithSize', { size: fmtBytes(tab.error.size) })
          : t('editor.errBinaryDesc')
        : code === 'OUT_OF_BOUNDS'
          ? t('editor.errOutOfBoundsDesc')
          : code === 'NOT_FOUND'
            ? t('editor.errNotFoundDesc')
            : tab.error?.message || t('editor.errGenericDesc')

  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-8 text-center">
      <div className="grid h-11 w-11 place-items-center rounded-2xl bg-fill text-ink-2">
        <IconFile size={22} />
      </div>
      <div className="max-w-[340px] space-y-1">
        <div className="text-[14px] font-semibold text-ink">{title}</div>
        <p className="text-[12.5px] leading-relaxed text-ink-3">{desc}</p>
      </div>
      {canExternalAction && (
        <div className="mt-1 flex flex-wrap items-center justify-center gap-2">
          <button type="button" onClick={onOpenExternal} className={btnPrimary + ' flex items-center gap-1.5'}>
            <IconExternal size={13} />
            {t('editor.openExternal')}
          </button>
          <button type="button" onClick={onReveal} className={btnSecondary + ' flex items-center gap-1.5'}>
            <IconFolder size={13} />
            {t('common.showInFinder')}
          </button>
        </div>
      )}
    </div>
  )
}
