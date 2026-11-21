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
import { KIND_META } from '../lib/ui'

export type Page = 'workbench' | 'engines'

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
  byId: (id: ProfileId) => ProfileState | undefined
  kindState: (k: ProfileKind) => KindState | undefined
  refresh: () => Promise<Snapshot>

  page: Page
  navigate: (page: Page, focus?: ProfileId | ProfileKind) => void
  engineFocus: { target: ProfileId | ProfileKind; at: number } | null

  drawer: { open: boolean; session: SessionId | null }
  openDrawer: (session?: SessionId) => void
  closeDrawer: () => void
  setDrawerSession: (session: SessionId) => void

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

  install: (kind: ProfileKind, update?: boolean) => Promise<void>
}

const Ctx = createContext<AppState | null>(null)

export const useApp = (): AppState => {
  const v = useContext(Ctx)
  if (!v) throw new Error('useApp outside provider')
  return v
}

export function AppProvider({ children }: { children: ReactNode }) {
  const [info, setInfo] = useState<AppInfo | null>(null)
  const [snap, setSnap] = useState<Snapshot | null>(null)
  const [page, setPage] = useState<Page>('workbench')
  const [engineFocus, setEngineFocus] = useState<AppState['engineFocus']>(null)
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
    // Logins/installs happen out-of-band (CLIs write files) -> re-check on focus.
    const onFocus = () => void refresh()
    window.addEventListener('focus', onFocus)
    return () => {
      off()
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
  const openDrawer = useCallback(
    (session?: SessionId) => setDrawer((d) => ({ open: true, session: session ?? d.session })),
    []
  )
  const closeDrawer = useCallback(() => setDrawer((d) => ({ ...d, open: false })), [])
  const setDrawerSession = useCallback((session: SessionId) => setDrawer((d) => ({ ...d, session })), [])

  // ---- accounts ---------------------------------------------------------------------
  const openAddAccount = useCallback((kind: ProfileKind, onCreated?: (id: ProfileId) => void) => setAddRequest({ kind, onCreated }), [])

  const removeAccount = useCallback(
    async (id: ProfileId) => {
      const p = profiles.find((x) => x.id === id)
      if (!p) return
      const ok = await confirm({
        title: `删除「${p.name}」？`,
        message: p.imported
          ? `只会从 AgentSwitch 中移除这个账号，${p.configDir} 里的配置和登录信息会原样保留，命令行中仍可继续使用。`
          : '只会从 AgentSwitch 中移除这个账号。它的独立配置目录会保留在磁盘上，不会被删除。',
        confirmLabel: '删除账号',
        destructive: true
      })
      if (!ok) return
      if (loginId === id) setLoginId(null)
      if (configId === id) setConfigId(null)
      await window.agentswitch.profiles.remove(id)
      toast({ kind: 'success', title: `已删除「${p.name}」` })
    },
    [profiles, confirm, toast, loginId, configId]
  )

  // ---- silent install ---------------------------------------------------------------
  const install = useCallback(
    async (kind: ProfileKind, update = false) => {
      const sid = installSessionId(kind)
      const name = KIND_META[kind].cli
      const verb = update ? '更新' : '安装'
      const done = new Promise<number>((resolve) => {
        const off = window.agentswitch.pty.onExit((e) => {
          if (e.sessionId === sid) {
            off()
            resolve(e.exitCode)
          }
        })
      })
      try {
        await window.agentswitch.cli.install(kind, update)
      } catch (e) {
        toast({ kind: 'error', title: `${name} ${verb}启动失败`, desc: String(e) })
        return
      }
      const code = await done
      const s = await refresh()
      const ok = !!s.kinds.find((k) => k.kind === kind)?.binaryPath
      if (code === 0 && ok) toast({ kind: 'success', title: `${name} ${verb}完成` })
      else if (code === -1) toast({ kind: 'info', title: `${name} ${verb}已取消` })
      else
        toast({
          kind: 'error',
          title: `${name} ${verb}失败`,
          desc: ok ? `${verb}命令退出码 ${code}` : `退出码 ${code}，仍未找到可执行文件`,
          action: { label: '查看日志', run: () => openDrawer(sid) }
        })
    },
    [refresh, toast, openDrawer]
  )

  const value = useMemo<AppState>(
    () => ({
      info,
      loaded: snap !== null,
      profiles,
      kinds,
      byId,
      kindState,
      refresh,
      page,
      navigate,
      engineFocus,
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
    [info, snap, profiles, kinds, byId, kindState, refresh, page, navigate, engineFocus, drawer, openDrawer, closeDrawer, setDrawerSession, loginId, configId, cliConfigKind, addRequest, openAddAccount, confirmState, confirm, removeAccount, toasts, toast, dismissToast, install]
  )

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}
