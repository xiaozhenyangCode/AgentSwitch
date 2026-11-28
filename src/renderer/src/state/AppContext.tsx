import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  installSessionId,
  type AppInfo,
  type KindState,
  type ProfileId,
  type ProfileKind,
  type ProfileState,
  type SessionId,
  type Snapshot
} from '@shared/types'
import { loadEditorLayoutPrefs, resolveTrafficLightOwner, saveEditorLayoutPrefs, toggleEditorMaximized, type EditorLayoutPrefs, type TrafficLightOwner } from '../lib/editorLayout'
import { KIND_META, isReady, isSignedIn } from '../lib/ui'
import { canUseOAuthLogin } from '@shared/providerCapabilities'
import { t } from './i18n'
import { forgetAccountModels, loadModels, reloadAccountModels } from './models'

export type Page = 'workbench' | 'engines' | 'usage'
export type SettingsSection = 'general' | 'appearance' | 'usage' | 'extensions' | 'data' | 'developer' | 'shortcuts' | 'about'

export interface Toast {
  id: number
  kind: 'success' | 'error' | 'info' | 'warn'
  title: string
  desc?: string
  action?: { label: string; run: () => void }
}

export interface ConfirmOptions {
  title: string
  message: string
  confirmLabel: string
  destructive?: boolean
  native?: boolean
  /** Optional checkbox (unchecked by default); its value is reported through onChange. */
  option?: { label: string; hint?: string; onChange: (checked: boolean) => void }
}

interface AddAccountRequest {
  kind: ProfileKind
  /** Called with the new id after creation (e.g. bind it to a workflow node). */
  onCreated?: (id: ProfileId) => void
}

interface AppState {
  info: AppInfo | null
  loaded: boolean
  profiles: ProfileState[]
  kinds: KindState[]
  cliVersions: Partial<Record<ProfileKind, string | null>>
  byId: (id: ProfileId) => ProfileState | undefined
  kindState: (k: ProfileKind) => KindState | undefined
  refresh: () => Promise<Snapshot>

  page: Page
  navigate: (page: Page, focus?: ProfileId | ProfileKind) => void
  engineFocus: { target: ProfileId | ProfileKind; at: number } | null
  sidebarOpen: boolean
  setSidebarOpen: (open: boolean) => void
  toggleSidebar: () => void
  platform: string
  isFullScreen: boolean
  trafficLightOwner: TrafficLightOwner
  editorLayout: EditorLayoutPrefs
  setEditorLayout: (update: (prefs: EditorLayoutPrefs) => EditorLayoutPrefs) => void
  editorMaximized: boolean
  setEditorMaximized: (maximized: boolean) => void
  workspaceEditorOpen: boolean
  setWorkspaceEditorOpen: (open: boolean) => void
  settingsSection: SettingsSection
  /** Settings is a dialog over the current page (which keeps its state). */
  settingsOpen: boolean
  openSettings: (section?: SettingsSection) => void
  closeSettings: () => void
  /** ⌘, : opens, or closes when already open. */
  toggleSettings: () => void

  drawer: { open: boolean; session: SessionId | null }
  openDrawer: (session?: SessionId) => void
  closeDrawer: () => void
  setDrawerSession: (session: SessionId | null) => void

  loginId: ProfileId | null
  openLogin: (id: ProfileId) => void
  closeLogin: () => void

  configId: ProfileId | null
  openConfig: (id: ProfileId | null) => void
  cliConfigKind: ProfileKind | null
  openCliConfig: (k: ProfileKind | null) => void

  addRequest: AddAccountRequest | null
  openAddAccount: (kind: ProfileKind, onCreated?: (id: ProfileId) => void) => void
  closeAddAccount: () => void

  confirmState: (ConfirmOptions & { resolve: (ok: boolean) => void }) | null
  confirm: (o: ConfirmOptions) => Promise<boolean>

  removeAccount: (id: ProfileId) => Promise<void>

  toasts: Toast[]
  toast: (t: Omit<Toast, 'id'>) => void
  dismissToast: (id: number) => void

  install: (kind: ProfileKind, update?: boolean) => Promise<InstallResult>
}

/** ok: the CLI is on PATH afterwards. error: why it could not start / failed (for inline help). */
export interface InstallResult {
  ok: boolean
  cancelled?: boolean
  error?: string
}

/** `Error invoking remote method 'x': Error: msg` → `msg` */
export const ipcError = (e: unknown): string => String(e instanceof Error ? e.message : e).replace(/^Error invoking remote method '[^']+': (?:\w*Error: )?/, '')

const Ctx = createContext<AppState | null>(null)

export const useApp = (): AppState => {
  const v = useContext(Ctx)
  if (!v) throw new Error('useApp outside provider')
  return v
}

export function AppProvider({ children }: { children: ReactNode }) {
  const [info, setInfo] = useState<AppInfo | null>(null)
  const [snap, setSnap] = useState<Snapshot | null>(null)
  const [cliVersions, setCliVersions] = useState<AppState['cliVersions']>({})
  const versionProbes = useRef(new Map<ProfileKind, { binaryPath: string | null }>())
  const [page, setPage] = useState<Page>('workbench')
  const [engineFocus, setEngineFocus] = useState<AppState['engineFocus']>(null)
  const [sidebarOpen, setSidebarOpenState] = useState<boolean>(() => localStorage.getItem('agentswitch.sidebar.open') !== '0')
  const { platform } = window.agentswitch.sys
  const [isFullScreen, setIsFullScreen] = useState(() => window.agentswitch.sys.isFullScreen())
  const [editorLayout, setEditorLayout] = useState(() => loadEditorLayoutPrefs())
  const [workspaceEditorOpen, setWorkspaceEditorOpen] = useState(false)
  const editorMaximized = workspaceEditorOpen && editorLayout.dockPosition === 'maximized'
  const trafficLightOwner = resolveTrafficLightOwner({
    platform, isFullScreen, sidebarOpen, editorOpen: workspaceEditorOpen, dockPosition: editorLayout.dockPosition
  })
  useEffect(() => {
    const off = window.agentswitch.sys.onFullScreenChanged(setIsFullScreen)
    setIsFullScreen(window.agentswitch.sys.isFullScreen())
    return off
  }, [])
  useEffect(() => saveEditorLayoutPrefs(editorLayout), [editorLayout])
  const setEditorMaximized = useCallback((maximized: boolean) => {
    setEditorLayout((prefs) => (prefs.dockPosition === 'maximized') === maximized ? prefs : toggleEditorMaximized(prefs))
  }, [])
  const [settingsSection, setSettingsSection] = useState<SettingsSection>('general')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [drawer, setDrawer] = useState<AppState['drawer']>({ open: false, session: null })
  const [loginId, setLoginId] = useState<ProfileId | null>(null)
  const [configId, setConfigId] = useState<ProfileId | null>(null)
  const [cliConfigKind, setCliConfigKind] = useState<ProfileKind | null>(null)
  const [addRequest, setAddRequest] = useState<AddAccountRequest | null>(null)
  const [confirmState, setConfirmState] = useState<AppState['confirmState']>(null)
  const [toasts, setToasts] = useState<Toast[]>([])
  const toastSeq = useRef(0)

  const profiles = snap?.profiles ?? []
  const kinds = snap?.kinds ?? []
  const profilesRef = useRef(profiles)
  profilesRef.current = profiles

  const refresh = useCallback(async () => {
    const s = await window.agentswitch.state.get()
    setSnap(s)
    return s
  }, [])
  const byId = useCallback((id: ProfileId) => profiles.find((p) => p.id === id), [profiles])
  const kindState = useCallback((k: ProfileKind) => kinds.find((x) => x.kind === k), [kinds])

  useEffect(() => {
    void window.agentswitch.sys.info().then(setInfo)
    void refresh()
    const off = window.agentswitch.state.onChanged((s) => {
      setSnap(s)
      void window.agentswitch.sys.info().then(setInfo) // shell env may have refreshed
    })
    const offLogin = window.agentswitch.profiles.onLoginSuccess(({ profileId }) => {
      forgetAccountModels(profileId)
      void loadModels(profileId)
    })
    // Logins/installs happen out-of-band (CLIs write files) -> re-check on focus.
    const onFocus = () => void refresh()
    window.addEventListener('focus', onFocus)
    return () => {
      off()
      offLogin()
      window.removeEventListener('focus', onFocus)
    }
  }, [refresh])

  // ---- toasts / confirm ---------------------------------------------------------
  const dismissToast = useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), [])
  const toast = useCallback(
    (t: Omit<Toast, 'id'>) => {
      const id = ++toastSeq.current
      setToasts((prev) => [...prev.slice(-3), { ...t, id }])
      setTimeout(() => dismissToast(id), t.kind === 'error' ? 9000 : 4500)
    },
    [dismissToast]
  )

  useEffect(() => window.agentswitch.cli.onUpdated((event) => {
    const { kind, binaryPath, version, source, affectedProfileIds, hasRunningTasks } = event
    versionProbes.current.set(kind, { binaryPath })
    setCliVersions((previous) => ({ ...previous, [kind]: version }))
    const ids = new Set(affectedProfileIds)
    for (const profile of profilesRef.current) if (profile.kind === kind) ids.add(profile.id)
    for (const id of ids) void reloadAccountModels(id)

    if (source === 'config') return
    const verb = t(source === 'update' ? 'install.verbUpdate' : 'install.verbInstall')
    const title = t('install.done', { name: KIND_META[kind].cli, verb })
    const desc = version
      ? t(hasRunningTasks ? 'install.updatedDeferred' : 'install.updatedReady', { v: version.replace(/^v/i, '') })
      : t(hasRunningTasks ? 'install.updatedDeferredNoVer' : 'install.updatedReadyNoVer')
    toast({ kind: 'success', title, desc })
  }), [toast])

  useEffect(() => {
    for (const { kind, binaryPath } of snap?.kinds ?? []) {
      if (versionProbes.current.get(kind)?.binaryPath === binaryPath) continue
      const probe = { binaryPath }
      versionProbes.current.set(kind, probe)
      setCliVersions((previous) => ({ ...previous, [kind]: binaryPath ? undefined : null }))
      if (!binaryPath) continue
      const setVersion = (version: string | null) => {
        if (versionProbes.current.get(kind) === probe) {
          setCliVersions((previous) => ({ ...previous, [kind]: version }))
        }
      }
      void window.agentswitch.cli.version(kind).then(setVersion, () => setVersion(null))
    }
  }, [snap?.kinds])

  const confirm = useCallback(
    (o: ConfirmOptions) =>
      new Promise<boolean>((resolve) =>
        setConfirmState({
          ...o,
          resolve: (ok) => {
            setConfirmState(null)
            resolve(ok)
          }
        })
      ),
    []
  )

  // ---- navigation / drawer ---------------------------------------------------------
  const navigate = useCallback((p: Page, focus?: ProfileId | ProfileKind) => {
    setPage(p)
    if (focus) setEngineFocus({ target: focus, at: Date.now() })
  }, [])
  const setSidebarOpen = useCallback((open: boolean) => {
    if (open && editorMaximized) setEditorMaximized(false)
    localStorage.setItem('agentswitch.sidebar.open', open ? '1' : '0')
    setSidebarOpenState(open)
  }, [editorMaximized, setEditorMaximized])
  const toggleSidebar = useCallback(() => {
    if (editorMaximized) {
      setSidebarOpen(true)
      return
    }
    setSidebarOpenState((o) => {
      const next = !o
      localStorage.setItem('agentswitch.sidebar.open', next ? '1' : '0')
      return next
    })
  }, [editorMaximized, setSidebarOpen])
  const openSettings = useCallback((section?: SettingsSection) => {
    if (section) setSettingsSection(section)
    setSettingsOpen(true)
  }, [])
  const closeSettings = useCallback(() => setSettingsOpen(false), [])
  const toggleSettings = useCallback(() => setSettingsOpen((o) => !o), [])
  const openDrawer = useCallback(
    (session?: SessionId) => setDrawer((d) => ({ open: true, session: session ?? d.session })),
    []
  )
  const closeDrawer = useCallback(() => setDrawer((d) => ({ ...d, open: false })), [])
  const setDrawerSession = useCallback((session: SessionId | null) => setDrawer((d) => ({ ...d, session })), [])

  // ---- accounts ---------------------------------------------------------------------
  const openAddAccount = useCallback((kind: ProfileKind, onCreated?: (id: ProfileId) => void) => setAddRequest({ kind, onCreated }), [])

  const removeAccount = useCallback(
    async (id: ProfileId) => {
      const p = profiles.find((x) => x.id === id)
      if (!p) return
      const ok = await confirm({
        title: t('acct.removeTitle', { name: p.name }),
        message: p.kind === 'reasonix' && !p.imported
          ? t('reasonix.removeManaged')
          : p.isManagedDir ? t('acct.removeOwn') : t('acct.removeImported', { dir: p.resolvedConfigDir }),
        confirmLabel: t('acct.removeConfirm'),
        destructive: true
      })
      if (!ok) return
      if (loginId === id) setLoginId(null)
      if (configId === id) setConfigId(null)
      await window.agentswitch.profiles.remove(id)
      forgetAccountModels(id)
      toast({
        kind: 'success',
        title: t('acct.removed', { name: p.name }),
        desc: canUseOAuthLogin(p.kind) && !p.isManagedDir ? t('acct.removedGlobalHint') : undefined
      })
    },
    [profiles, confirm, toast, loginId, configId]
  )

  // ---- silent install ---------------------------------------------------------------
  const install = useCallback(
    async (kind: ProfileKind, update = false): Promise<InstallResult> => {
      const sid = installSessionId(kind)
      const name = KIND_META[kind].cli
      const verb = update ? t('install.verbUpdate') : t('install.verbInstall')
      let off = () => {}
      const done = new Promise<number>((resolve) => {
        off = window.agentswitch.pty.onExit((e) => {
          if (e.sessionId === sid) {
            off()
            resolve(e.exitCode)
          }
        })
      })
      try {
        await window.agentswitch.cli.install(kind, update)
      } catch (e) {
        off()
        const error = ipcError(e)
        toast({ kind: 'error', title: t('install.startFailed', { name, verb }), desc: error })
        return { ok: false, error }
      }
      const code = await done
      const s = await refresh()
      const ok = !!s.kinds.find((k) => k.kind === kind)?.binaryPath
      if (code === 0 && ok) return { ok: true }
      if (code === -1) {
        toast({ kind: 'info', title: t('install.cancelled', { name, verb }) })
        return { ok: false, cancelled: true }
      }
      const error = ok ? t('install.exitCode', { verb, code }) : t('install.notFound', { code })
      toast({ kind: 'error', title: t('install.failed', { name, verb }), desc: error, action: { label: t('install.viewLog'), run: () => openDrawer(sid) } })
      return { ok: false, error }
    },
    [refresh, toast, openDrawer]
  )

  const value = useMemo<AppState>(
    () => ({
      info,
      loaded: snap !== null,
      profiles,
      kinds,
      cliVersions,
      byId,
      kindState,
      refresh,
      page,
      navigate,
      engineFocus,
      sidebarOpen,
      setSidebarOpen,
      toggleSidebar,
      platform,
      isFullScreen,
      trafficLightOwner,
      editorLayout,
      setEditorLayout,
      editorMaximized,
      setEditorMaximized,
      workspaceEditorOpen,
      setWorkspaceEditorOpen,
      settingsSection,
      settingsOpen,
      openSettings,
      closeSettings,
      toggleSettings,
      drawer,
      openDrawer,
      closeDrawer,
      setDrawerSession,
      loginId,
      openLogin: setLoginId,
      closeLogin: () => setLoginId(null),
      configId,
      openConfig: setConfigId,
      cliConfigKind,
      openCliConfig: setCliConfigKind,
      addRequest,
      openAddAccount,
      closeAddAccount: () => setAddRequest(null),
      confirmState,
      confirm,
      removeAccount,
      toasts,
      toast,
      dismissToast,
      install
    }),
    [info, snap, profiles, kinds, cliVersions, byId, kindState, refresh, page, navigate, engineFocus, sidebarOpen, setSidebarOpen, toggleSidebar, platform, isFullScreen, trafficLightOwner, editorLayout, editorMaximized, setEditorMaximized, workspaceEditorOpen, settingsSection, settingsOpen, openSettings, closeSettings, toggleSettings, drawer, openDrawer, closeDrawer, setDrawerSession, loginId, configId, cliConfigKind, addRequest, openAddAccount, confirmState, confirm, removeAccount, toasts, toast, dismissToast, install]
  )

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

/** Accounts sorted: ready first, then kind order, then creation. */
export function useSortedAccounts(): ProfileState[] {
  const { profiles } = useApp()
  return useMemo(() => {
    const order = { claude: 0, codex: 1, gemini: 2, reasonix: 3 } as const
    return [...profiles].sort(
      (a, b) => Number(isReady(b)) - Number(isReady(a)) || Number(isSignedIn(b)) - Number(isSignedIn(a)) || order[a.kind] - order[b.kind] || a.createdAt - b.createdAt
    )
  }, [profiles])
}
