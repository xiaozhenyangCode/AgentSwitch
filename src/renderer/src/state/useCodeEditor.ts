import { useCallback, useEffect, useRef, useState } from 'react'
import type { EditorEol, EditorErrorCode, EditorFileChangedEvent, EditorReadResult, EditorSaveResult } from '@shared/editor'
import { t } from '../state/i18n'
import { useApp } from './AppContext'

export interface EditorTab {
  id: string
  path: string
  realPath: string | null
  workspaceDir: string | null
  name: string
  status: 'loading' | 'ready' | 'error'
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
  const parts = filePath.split(/[/\\]/)
  return parts[parts.length - 1] || filePath
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
  const watchedPathsRef = useRef(new Set<string>())
  const prevProjectDirRef = useRef<string | null>(projectDir)

  const watchPath = useCallback((path: string, workspaceDir: string | null) => {
    if (watchedPathsRef.current.has(path)) return
    watchedPathsRef.current.add(path)
    void window.agentswitch.editor.watchFile({ path, workspaceDir }).then((res) => {
      if (!res.ok) watchedPathsRef.current.delete(path)
    }).catch(() => {
      watchedPathsRef.current.delete(path)
    })
  }, [])

  const unwatchPath = useCallback((path: string) => {
    if (!watchedPathsRef.current.delete(path)) return
    void window.agentswitch.editor.unwatchFile(path).catch(() => {})
  }, [])

  // Cleanup all active watchers on unmount.
  useEffect(() => {
    const watched = watchedPathsRef.current
    return () => {
      for (const path of watched) {
        void window.agentswitch.editor.unwatchFile(path).catch(() => {})
      }
      watched.clear()
    }
  }, [])

  const removeTabsNow = useCallback((ids: string[], closePanelWhenEmpty = true) => {
    const removeSet = new Set(ids)
    const current = tabsRef.current
    for (const tab of current) {
      if (removeSet.has(tab.id)) unwatchPath(tab.path)
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

  const loadTabContent = useCallback(async (tabId: string, path: string, workspaceDir: string | null, silentReload = false) => {
    const res: EditorReadResult = await window.agentswitch.editor.readFile({ path, workspaceDir }).catch((err: unknown): EditorReadResult => ({
      ok: false,
      code: 'IO_ERROR',
      message: err instanceof Error ? err.message : String(err)
    }))

    if (!res.ok) {
      unwatchPath(path)
      setTabs((prev) => prev.map((tab) => {
        if (tab.id !== tabId) return tab
        return {
          ...tab,
          realPath: res.realPath ?? tab.realPath,
          status: 'error',
          externalChange: null,
          conflictMtimeMs: null,
          error: { code: res.code, message: res.message, size: res.size }
        }
      }))
      return
    }

    // Deduplicate if another tab already holds the same canonical realPath (e.g. symlink).
    const existingDuplicate = tabsRef.current.find((tab) => tab.id !== tabId && tab.realPath === res.realPath)
    if (existingDuplicate) {
      unwatchPath(path)
      setTabs((prev) => prev.filter((tab) => tab.id !== tabId))
      setActiveId(existingDuplicate.id)
      setFocusToken((n) => n + 1)
      return
    }

    setTabs((prev) => prev.map((tab) => {
      if (tab.id !== tabId) return tab
      // If a silent reload raced with the user typing, avoid clobbering their draft.
      if (silentReload && isTabDirty(tab)) {
        return { ...tab, externalChange: 'modified' }
      }
      return {
        ...tab,
        realPath: res.realPath,
        status: 'ready',
        content: res.content,
        savedContent: res.content,
        mtimeMs: res.mtimeMs,
        size: res.size,
        eol: res.eol,
        language: res.language,
        syncVersion: tab.syncVersion + 1,
        externalChange: null,
        conflictMtimeMs: null,
        error: undefined
      }
    }))
    watchPath(path, workspaceDir)
  }, [unwatchPath, watchPath])

  const openFile = useCallback((path: string, workspaceOverride?: string | null) => {
    const trimmed = path.trim()
    if (!trimmed) return
    const ws = workspaceOverride !== undefined ? workspaceOverride : projectDir

    const existing = tabsRef.current.find((tab) => tab.path === trimmed || tab.realPath === trimmed)
    if (existing) {
      setOpen(true)
      setActiveId(existing.id)
      setFocusToken((n) => n + 1)
      if (existing.status === 'error') {
        void loadTabContent(existing.id, existing.path, ws)
      }
      return
    }

    const id = trimmed
    const newTab: EditorTab = {
      id,
      path: trimmed,
      realPath: null,
      workspaceDir: ws,
      name: fileNameOf(trimmed),
      status: 'loading',
      content: '',
      savedContent: '',
      mtimeMs: 0,
      size: 0,
      eol: 'LF',
      language: 'plaintext',
      syncVersion: 0,
      saving: false,
      externalChange: null,
      conflictMtimeMs: null
    }
    setTabs((prev) => [...prev, newTab])
    setActiveId(id)
    setOpen(true)
    setFocusToken((n) => n + 1)
    void loadTabContent(id, trimmed, ws)
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
        ...item,
        saving: false,
        savedContent: contentToSave,
        mtimeMs: res.mtimeMs,
        size: res.size,
        externalChange: null,
        conflictMtimeMs: null
      }
    }))
    return true
  }, [toast])

  const reloadTab = useCallback((tabId: string) => {
    const tab = tabsRef.current.find((item) => item.id === tabId)
    if (!tab) return
    void loadTabContent(tab.id, tab.path, tab.workspaceDir, false)
  }, [loadTabContent])

  const dismissExternalChange = useCallback((tabId: string) => {
    setTabs((prev) => prev.map((item) => (item.id === tabId ? { ...item, externalChange: null } : item)))
  }, [])

  // Subscribe to main-process file watcher notifications.
  useEffect(() => {
    return window.agentswitch.editor.onFileChanged((event: EditorFileChangedEvent) => {
      const matched = tabsRef.current.filter((tab) =>
        tab.path === event.path || (tab.realPath && tab.realPath === event.realPath)
      )
      for (const tab of matched) {
        if (event.deleted) {
          setTabs((prev) => prev.map((item) => (item.id === tab.id ? { ...item, externalChange: 'deleted' } : item)))
          continue
        }
        if (tab.status !== 'ready') continue
        if (!isTabDirty(tab) && !tab.saving) {
          void loadTabContent(tab.id, tab.path, tab.workspaceDir, true)
        } else {
          setTabs((prev) => prev.map((item) => (item.id === tab.id ? { ...item, externalChange: 'modified' } : item)))
        }
      }
    })
  }, [loadTabContent])

  // Handle project workspace switches cleanly without leaking fs.watch handles.
  useEffect(() => {
    const prev = prevProjectDirRef.current
    prevProjectDirRef.current = projectDir
    if (prev === projectDir) return
    const stale = tabsRef.current.filter((tab) => tab.workspaceDir !== projectDir)
    if (!stale.length) return
    const cleanIds = stale.filter((tab) => !isTabDirty(tab)).map((tab) => tab.id)
    const dirtyTabs = stale.filter(isTabDirty)
    if (cleanIds.length) removeTabsNow(cleanIds, dirtyTabs.length === 0)
    if (dirtyTabs.length) {
      setPendingClose({
        kind: 'workspace',
        tabIds: dirtyTabs.map((tab) => tab.id),
        names: dirtyTabs.map((tab) => tab.name)
      })
    }
  }, [projectDir, removeTabsNow])

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
    removeTabsNow(prompt.tabIds, true)
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
    openFile,
    updateContent,
    saveTab,
    reloadTab,
    dismissExternalChange,
    requestCloseTab,
    requestClosePanel,
    resolvePendingClose
  }
}
