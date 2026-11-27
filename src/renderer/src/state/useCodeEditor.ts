import { useCallback, useEffect, useRef, useState } from 'react'
import { isPreviewableEditorImage, type EditorEol, type EditorErrorCode, type EditorFileChangedEvent, type EditorReadResult, type EditorSaveResult } from '@shared/editor'
import {
  applyAcceptDiskVersion,
  applyKeepMineSaved,
  enterConflictDiff,
  exitDiffState,
  toggleUnsavedDiffState,
  type EditorDiffMode
} from '../lib/editorDiffState'
import {
  loadWorkspaceEditorState,
  resolveRestoredWorkspaceTabs,
  saveWorkspaceEditorState
} from '../lib/editorPersistence'
import { t } from '../state/i18n'
import { useApp } from './AppContext'

export type EditorViewMode = 'source' | 'preview'

export interface EditorTab {
  id: string
  path: string
  realPath: string | null
  workspaceDir: string | null
  name: string
  status: 'loading' | 'ready' | 'image' | 'error'
  viewMode: EditorViewMode
  content: string
  savedContent: string
  mtimeMs: number
  size: number
  eol: EditorEol
  language: string
  syncVersion: number
  saving: boolean
  externalChange: 'modified' | 'deleted' | null
  conflictMtimeMs: number | null
  diffMode: EditorDiffMode
  diskContent: string | null
  loadingDiff: boolean
  error?: {
    code: EditorErrorCode
    message: string
    size?: number
  }
}

export interface PendingClosePrompt {
  kind: 'tab' | 'panel' | 'workspace'
  tabIds: string[]
  names: string[]
}

export const isTabDirty = (tab: EditorTab): boolean => tab.status === 'ready' && tab.content !== tab.savedContent

function fileNameOf(filePath: string): string {
  const parts = filePath.split(filePath.startsWith('/') ? '/' : /[/\\]/)
  return parts[parts.length - 1] || filePath
}

function makeLoadingTab(path: string, workspaceDir: string | null): EditorTab {
  return {
    id: path,
    path,
    realPath: null,
    workspaceDir,
    name: fileNameOf(path),
    status: 'loading',
    viewMode: /\.svg$/i.test(path) ? 'preview' : 'source',
    content: '',
    savedContent: '',
    mtimeMs: 0,
    size: 0,
    eol: 'LF',
    language: 'plaintext',
    syncVersion: 0,
    saving: false,
    externalChange: null,
    conflictMtimeMs: null,
    diffMode: 'none',
    diskContent: null,
    loadingDiff: false
  }
}

export function useCodeEditor(projectDir: string | null) {
  const { toast } = useApp()
  const [tabs, setTabs] = useState<EditorTab[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  const [maximized, setMaximized] = useState(false)
  const [focusToken, setFocusToken] = useState(0)
  const [pendingClose, setPendingClose] = useState<PendingClosePrompt | null>(null)

  const tabsRef = useRef<EditorTab[]>(tabs)
  tabsRef.current = tabs
  const activeIdRef = useRef<string | null>(activeId)
  activeIdRef.current = activeId
  const openRef = useRef<boolean>(open)
  openRef.current = open
  const watchedPathsRef = useRef(new Map<string, symbol>())
  const readsByTab = useRef(new Map<string, symbol>())
  const prevProjectDirRef = useRef<string | null | undefined>(undefined)
  const restoredWorkspaceRef = useRef<string | null>(null)
  const restoreSeqRef = useRef(0)

  const watchPath = useCallback((path: string, workspaceDir: string | null) => {
    if (watchedPathsRef.current.has(path)) return
    const request = Symbol()
    watchedPathsRef.current.set(path, request)
    const forgetFailedWatch = () => {
      if (watchedPathsRef.current.get(path) === request) watchedPathsRef.current.delete(path)
    }
    void window.agentswitch.editor.watchFile({ path, workspaceDir }).then((res) => {
      if (!res.ok) forgetFailedWatch()
    }).catch(forgetFailedWatch)
  }, [])

  const unwatchPath = useCallback((path: string) => {
    if (!watchedPathsRef.current.delete(path)) return
    void window.agentswitch.editor.unwatchFile(path).catch(() => {})
  }, [])

  // Cleanup all active watchers on unmount.
  useEffect(() => {
    const watched = watchedPathsRef.current
    const reads = readsByTab.current
    return () => {
      reads.clear()
      for (const path of watched.keys()) {
        void window.agentswitch.editor.unwatchFile(path).catch(() => {})
      }
      watched.clear()
    }
  }, [])

  const removeTabsNow = useCallback((ids: string[], closePanelWhenEmpty = false) => {
    const removeSet = new Set(ids)
    const current = tabsRef.current
    for (const tab of current) {
      if (removeSet.has(tab.id)) {
        readsByTab.current.delete(tab.id)
        unwatchPath(tab.path)
      }
    }
    const next = current.filter((tab) => !removeSet.has(tab.id))
    setTabs(next)
    if (!next.length) {
      setActiveId(null)
      if (closePanelWhenEmpty) {
        setOpen(false)
        setMaximized(false)
      }
      return
    }
    if (activeIdRef.current && removeSet.has(activeIdRef.current)) {
      const closedIdx = current.findIndex((tab) => tab.id === activeIdRef.current)
      const fallback = next[Math.min(Math.max(closedIdx, 0), next.length - 1)]
      setActiveId(fallback?.id ?? null)
    }
  }, [unwatchPath])

  const loadTabContent = useCallback(async (
    tabId: string,
    path: string,
    workspaceDir: string | null,
    silentReload = false,
    skipIfMissing = false
  ) => {
    const request = Symbol()
    readsByTab.current.set(tabId, request)
    const res: EditorReadResult = await window.agentswitch.editor.readFile({ path, workspaceDir }).catch((err: unknown): EditorReadResult => ({
      ok: false,
      code: 'IO_ERROR',
      message: err instanceof Error ? err.message : String(err)
    }))
    if (readsByTab.current.get(tabId) !== request) return
    readsByTab.current.delete(tabId)

    const image = !res.ok && res.code === 'BINARY_FILE' && isPreviewableEditorImage(res.realPath ?? path)
    if (!res.ok && !image) {
      if (skipIfMissing && (res.code === 'NOT_FOUND' || res.code === 'OUT_OF_BOUNDS')) {
        removeTabsNow([tabId], true)
        return
      }
      const current = tabsRef.current.find((tab) => tab.id === tabId)
      const deleted = res.code === 'NOT_FOUND'
      const preserveWatch = silentReload && (deleted || (current && (current.saving || isTabDirty(current))))
      if (!preserveWatch) unwatchPath(path)
      setTabs((prev) => prev.map((tab) => {
        if (tab.id !== tabId) return tab
        if (silentReload && (deleted || isTabDirty(tab) || tab.saving)) {
          return {
            ...tab,
            externalChange: deleted ? 'deleted' : 'modified',
            syncVersion: deleted && tab.viewMode === 'preview' ? tab.syncVersion + 1 : tab.syncVersion
          }
        }
        return {
          ...tab,
          realPath: res.realPath ?? tab.realPath,
          status: 'error',
          externalChange: null,
          conflictMtimeMs: null,
          diffMode: 'none',
          diskContent: null,
          loadingDiff: false,
          error: { code: res.code, message: res.message, size: res.size }
        }
      }))
      return
    }

    // Deduplicate if another tab already holds the same canonical realPath (e.g. symlink).
    const existingDuplicate = res.realPath && tabsRef.current.find((tab) => tab.id !== tabId && tab.realPath === res.realPath)
    if (existingDuplicate) {
      unwatchPath(path)
      setTabs((prev) => prev.filter((tab) => tab.id !== tabId))
      if (activeIdRef.current === tabId) {
        setActiveId(existingDuplicate.id)
        setFocusToken((n) => n + 1)
      }
      return
    }

    setTabs((prev) => prev.map((tab) => {
      if (tab.id !== tabId) return tab
      // If a silent reload raced with the user typing, avoid clobbering their draft.
      if (silentReload && (isTabDirty(tab) || tab.saving)) {
        return { ...tab, externalChange: 'modified' }
      }
      if (!res.ok) {
        return {
          ...exitDiffState(tab),
          status: 'image',
          viewMode: 'preview',
          realPath: res.realPath ?? null,
          size: res.size ?? 0,
          syncVersion: tab.syncVersion + 1,
          externalChange: null,
          conflictMtimeMs: null,
          loadingDiff: false,
          error: undefined
        }
      }
      return {
        ...applyAcceptDiskVersion(tab, {
          content: res.content,
          mtimeMs: res.mtimeMs,
          size: res.size
        }),
        realPath: res.realPath,
        viewMode: tab.status === 'loading' || tab.status === 'image'
          ? (/\.svg$/i.test(res.realPath) ? 'preview' : 'source')
          : tab.viewMode,
        eol: res.eol,
        language: res.language,
        loadingDiff: false,
        error: undefined
      }
    }))
    watchPath(path, workspaceDir)
  }, [removeTabsNow, unwatchPath, watchPath])

  const openFile = useCallback((path: string, workspaceOverride?: string | null) => {
    if (!path.trim()) return
    const ws = workspaceOverride !== undefined ? workspaceOverride : projectDir

    const existing = tabsRef.current.find((tab) => tab.path === path || tab.realPath === path)
    if (existing) {
      setOpen(true)
      setActiveId(existing.id)
      setFocusToken((n) => n + 1)
      if (existing.status === 'error') {
        void loadTabContent(existing.id, existing.path, ws)
      }
      return
    }

    const newTab = makeLoadingTab(path, ws)
    setTabs((prev) => [...prev, newTab])
    setActiveId(newTab.id)
    setOpen(true)
    setFocusToken((n) => n + 1)
    void loadTabContent(newTab.id, path, ws)
  }, [projectDir, loadTabContent])

  const updateContent = useCallback((tabId: string, nextContent: string) => {
    setTabs((prev) => prev.map((tab) => {
      if (tab.id !== tabId || tab.content === nextContent) return tab
      return { ...tab, content: nextContent }
    }))
  }, [])

  const saveTab = useCallback(async (tabId: string, options?: { force?: boolean }): Promise<boolean> => {
    const tab = tabsRef.current.find((item) => item.id === tabId)
    if (!tab || tab.status !== 'ready' || tab.saving) return false
    if (!options?.force && !isTabDirty(tab) && !tab.conflictMtimeMs && !tab.externalChange) return true

    const contentToSave = tab.content
    setTabs((prev) => prev.map((item) => (item.id === tabId ? { ...item, saving: true } : item)))

    const res: EditorSaveResult = await window.agentswitch.editor.saveFile({
      path: tab.path,
      workspaceDir: tab.workspaceDir,
      content: contentToSave,
      expectedMtimeMs: tab.mtimeMs,
      eol: tab.eol,
      force: options?.force === true
    }).catch((err: unknown): EditorSaveResult => ({
      ok: false,
      code: 'IO_ERROR',
      message: err instanceof Error ? err.message : String(err)
    }))

    if (!res.ok) {
      if (res.code === 'CONFLICT') {
        setTabs((prev) => prev.map((item) => (item.id === tabId ? {
          ...item,
          saving: false,
          conflictMtimeMs: res.currentMtimeMs ?? Date.now()
        } : item)))
        return false
      }
      setTabs((prev) => prev.map((item) => (item.id === tabId ? { ...item, saving: false } : item)))
      toast({ kind: 'error', title: t('editor.saveFailed'), desc: res.message })
      return false
    }

    setTabs((prev) => prev.map((item) => {
      if (item.id !== tabId) return item
      return {
        ...applyKeepMineSaved(item, {
          content: contentToSave,
          mtimeMs: res.mtimeMs,
          size: res.size
        }),
        saving: false,
        syncVersion: /\.svg$/i.test(item.realPath ?? item.path) ? item.syncVersion + 1 : item.syncVersion
      }
    }))
    return true
  }, [toast])

  const reloadTab = useCallback((tabId: string) => {
    const tab = tabsRef.current.find((item) => item.id === tabId)
    if (!tab) return
    void loadTabContent(tab.id, tab.path, tab.workspaceDir, false)
  }, [loadTabContent])

  const setTabViewMode = useCallback((tabId: string, viewMode: EditorViewMode) => {
    setTabs((prev) => prev.map((tab) => tab.id === tabId && tab.status === 'ready' ? { ...tab, viewMode } : tab))
  }, [])

  const dismissExternalChange = useCallback((tabId: string) => {
    setTabs((prev) => prev.map((item) => (item.id === tabId ? { ...item, externalChange: null } : item)))
  }, [])

  const openConflictDiff = useCallback(async (tabId: string) => {
    const tab = tabsRef.current.find((item) => item.id === tabId)
    if (!tab || tab.status !== 'ready' || tab.loadingDiff) return
    setTabs((prev) => prev.map((item) => (item.id === tabId ? { ...item, loadingDiff: true } : item)))
    const res: EditorReadResult = await window.agentswitch.editor.readFile({
      path: tab.path,
      workspaceDir: tab.workspaceDir
    }).catch((err: unknown): EditorReadResult => ({
      ok: false,
      code: 'IO_ERROR',
      message: err instanceof Error ? err.message : String(err)
    }))

    if (!res.ok) {
      setTabs((prev) => prev.map((item) => (item.id === tabId ? { ...item, loadingDiff: false } : item)))
      toast({ kind: 'error', title: t('editor.diffLoadFailed'), desc: res.message })
      return
    }
    setTabs((prev) => prev.map((item) => {
      if (item.id !== tabId) return item
      return {
        ...enterConflictDiff(item, res.content),
        loadingDiff: false
      }
    }))
  }, [toast])

  const toggleUnsavedDiff = useCallback((tabId: string) => {
    setTabs((prev) => prev.map((item) => (item.id === tabId ? toggleUnsavedDiffState(item) : item)))
  }, [])

  const exitDiff = useCallback((tabId: string) => {
    setTabs((prev) => prev.map((item) => (item.id === tabId ? exitDiffState(item) : item)))
    setFocusToken((n) => n + 1)
  }, [])

  const selectAdjacentTab = useCallback((delta: -1 | 1) => {
    const list = tabsRef.current
    if (list.length <= 1) return
    const curIdx = list.findIndex((item) => item.id === activeIdRef.current)
    const base = curIdx < 0 ? 0 : curIdx
    const next = list[(base + delta + list.length) % list.length]
    if (next) {
      setActiveId(next.id)
      setFocusToken((n) => n + 1)
    }
  }, [])

  // Subscribe to main-process file watcher notifications.
  useEffect(() => {
    return window.agentswitch.editor.onFileChanged((event: EditorFileChangedEvent) => {
      const matched = tabsRef.current.filter((tab) =>
        tab.path === event.path || (tab.realPath && tab.realPath === event.realPath)
      )
      for (const tab of matched) {
        if (event.deleted) {
          setTabs((prev) => prev.map((item) => item.id === tab.id ? {
            ...item, externalChange: 'deleted', syncVersion: item.viewMode === 'preview' ? item.syncVersion + 1 : item.syncVersion
          } : item))
          continue
        }
        if (tab.status !== 'ready' && tab.status !== 'image') continue
        if (!isTabDirty(tab) && !tab.saving) {
          void loadTabContent(tab.id, tab.path, tab.workspaceDir, true)
        } else {
          setTabs((prev) => prev.map((item) => (item.id === tab.id ? { ...item, externalChange: 'modified' } : item)))
          // If the user already has conflict diff open, refresh diskContent live too.
          if (tab.diffMode === 'conflict') {
            void openConflictDiff(tab.id)
          }
        }
      }
    })
  }, [loadTabContent, openConflictDiff])

  // Restore saved workspace tabs cleanly (skipping deleted files) and handle workspace switches.
  useEffect(() => {
    const prev = prevProjectDirRef.current
    if (prev === projectDir) return
    prevProjectDirRef.current = projectDir

    // Persist outgoing workspace before switching away.
    if (prev && restoredWorkspaceRef.current === prev) {
      const prevTabs = tabsRef.current.filter((tab) => tab.workspaceDir === prev)
      const prevActive = prevTabs.find((tab) => tab.id === activeIdRef.current)
      saveWorkspaceEditorState(prev, {
        tabs: prevTabs.map((tab) => tab.path),
        activePath: prevActive?.path ?? prevTabs[0]?.path ?? null,
        open: openRef.current
      })
    }

    // Close clean tabs from the previous workspace; prompt for dirty ones.
    let hasDirtyStale = false
    if (prev !== undefined) {
      const stale = tabsRef.current.filter((tab) => tab.workspaceDir !== projectDir)
      if (stale.length) {
        const cleanIds = stale.filter((tab) => !isTabDirty(tab)).map((tab) => tab.id)
        const dirtyTabs = stale.filter(isTabDirty)
        hasDirtyStale = dirtyTabs.length > 0
        if (cleanIds.length) removeTabsNow(cleanIds, !hasDirtyStale)
        if (dirtyTabs.length) {
          setOpen(true)
          setPendingClose({
            kind: 'workspace',
            tabIds: dirtyTabs.map((tab) => tab.id),
            names: dirtyTabs.map((tab) => tab.name)
          })
        }
      }
      if (!hasDirtyStale) {
        setOpen(false)
        setMaximized(false)
      }
    }

    restoredWorkspaceRef.current = null
    const seq = ++restoreSeqRef.current
    if (!projectDir) return

    const saved = loadWorkspaceEditorState(projectDir)
    if (!saved || !saved.tabs.length) {
      restoredWorkspaceRef.current = projectDir
      if (saved?.open) setOpen(true)
      return
    }

    const restore = async () => {
      const existingMap = await window.agentswitch.sys.pathsExist(saved.tabs).catch(() => {
        const fallback: Record<string, boolean> = {}
        for (const p of saved.tabs) fallback[p] = true
        return fallback
      })
      if (restoreSeqRef.current !== seq) return
      const resolved = resolveRestoredWorkspaceTabs(saved, existingMap)
      restoredWorkspaceRef.current = projectDir
      if (!resolved.tabs.length) {
        saveWorkspaceEditorState(projectDir, { tabs: [], activePath: null, open: false })
        return
      }
      const existingIds = new Set(tabsRef.current.map((tab) => tab.path))
      const toCreate = resolved.tabs.filter((p) => !existingIds.has(p)).map((p) => makeLoadingTab(p, projectDir))
      if (toCreate.length) {
        setTabs((cur) => [...cur, ...toCreate])
      }
      if (!hasDirtyStale && resolved.activePath) {
        setActiveId(resolved.activePath)
      }
      if (resolved.open) {
        setOpen(true)
      }
      for (const tab of toCreate) {
        void loadTabContent(tab.id, tab.path, projectDir, false, true)
      }
    }
    void restore()
  }, [projectDir, loadTabContent, removeTabsNow])

  // Persist current workspace's tabs & open state whenever they change.
  useEffect(() => {
    if (!projectDir || restoredWorkspaceRef.current !== projectDir) return
    const wsTabs = tabs.filter((tab) => tab.workspaceDir === projectDir)
    const active = wsTabs.find((tab) => tab.id === activeId)
    saveWorkspaceEditorState(projectDir, {
      tabs: wsTabs.map((tab) => tab.path),
      activePath: active?.path ?? wsTabs[0]?.path ?? null,
      open
    })
  }, [projectDir, tabs, activeId, open])

  const requestCloseTab = useCallback((tabId: string) => {
    const tab = tabsRef.current.find((item) => item.id === tabId)
    if (!tab) return
    if (isTabDirty(tab)) {
      setPendingClose({ kind: 'tab', tabIds: [tab.id], names: [tab.name] })
      return
    }
    removeTabsNow([tab.id])
  }, [removeTabsNow])

  const requestClosePanel = useCallback(() => {
    const dirtyTabs = tabsRef.current.filter(isTabDirty)
    if (dirtyTabs.length) {
      setPendingClose({
        kind: 'panel',
        tabIds: tabsRef.current.map((tab) => tab.id),
        names: dirtyTabs.map((tab) => tab.name)
      })
      return
    }
    removeTabsNow(tabsRef.current.map((tab) => tab.id), true)
    setOpen(false)
    setMaximized(false)
  }, [removeTabsNow])

  const togglePanel = useCallback(() => {
    if (openRef.current) {
      setOpen(false)
      setMaximized(false)
    } else {
      setOpen(true)
      setFocusToken((n) => n + 1)
    }
  }, [])

  const resolvePendingClose = useCallback(async (action: 'save' | 'discard' | 'cancel') => {
    const prompt = pendingClose
    if (!prompt) return
    if (action === 'cancel') {
      setPendingClose(null)
      return
    }
    if (action === 'save') {
      for (const id of prompt.tabIds) {
        const tab = tabsRef.current.find((item) => item.id === id)
        if (tab && isTabDirty(tab)) {
          const ok = await saveTab(id)
          if (!ok) {
            setActiveId(id)
            setPendingClose(null)
            return
          }
        }
      }
    }
    setPendingClose(null)
    removeTabsNow(prompt.tabIds, prompt.kind !== 'tab')
    if (prompt.kind === 'panel') {
      setOpen(false)
      setMaximized(false)
    }
  }, [pendingClose, saveTab, removeTabsNow])

  const activeTab = tabs.find((tab) => tab.id === activeId) ?? tabs[0] ?? null

  return {
    tabs,
    activeTab,
    open,
    maximized,
    focusToken,
    pendingClose,
    setOpen,
    setMaximized,
    selectTab: (tabId: string) => {
      setActiveId(tabId)
      setFocusToken((n) => n + 1)
    },
    selectAdjacentTab,
    openFile,
    updateContent,
    saveTab,
    reloadTab,
    dismissExternalChange,
    openConflictDiff,
    toggleUnsavedDiff,
    exitDiff,
    setTabViewMode,
    togglePanel,
    requestCloseTab,
    requestClosePanel,
    resolvePendingClose
  }
}
