import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { SessionId, SessionInfo } from '@shared/types'
import { useApp } from '../state/AppContext'
import { terminals } from '../lib/terminals'
import { XtermView } from './XtermView'
import { IconPlus, IconTerminal, IconX } from './icons'
import { t } from '../state/i18n'
import { activeThread, useChat } from '../state/chat'
import { useDraft } from '../state/draft'

/** /Users/name/x -> ~/x (display only). */
const tilde = (p: string) => p.replace(/^\/(?:Users|home)\/[^/]+(?=\/|$)/, '~')

export const DRAWER_HEIGHT = 340
const DRAWER_MIN = 180
const DRAWER_KEY = 'agentswitch.drawer.height'
const drawerMax = () => Math.max(DRAWER_MIN + 120, Math.min(720, Math.round(window.innerHeight * 0.72)))
const clampHeight = (h: number) => Math.round(Math.min(drawerMax(), Math.max(DRAWER_MIN, h)))

// Shared drawer height + dragging state so App.tsx's paddingBottom animates in lockstep with the drawer
interface DrawerLayout {
  height: number
  dragging: boolean
}
let drawerLayout: DrawerLayout = {
  height: clampHeight(Number(localStorage.getItem(DRAWER_KEY)) || DRAWER_HEIGHT),
  dragging: false
}
const drawerListeners = new Set<() => void>()
const emitLayout = () => drawerListeners.forEach((l) => l())
function setDrawerLayout(patch: Partial<DrawerLayout>) {
  drawerLayout = { ...drawerLayout, ...patch }
  if (patch.height !== undefined) localStorage.setItem(DRAWER_KEY, String(drawerLayout.height))
  emitLayout()
}
export function useDrawerLayout(): DrawerLayout {
  return useSyncExternalStore(
    (cb) => {
      drawerListeners.add(cb)
      return () => drawerListeners.delete(cb)
    },
    () => drawerLayout
  )
}

/**
 * Bottom slide-out drawer with raw xterm sessions.
 * Opening the drawer with no active sessions spawns a default shell in the current project's
 * folder (or the system home directory when no project is selected).
 */
export function DebugDrawer() {
  const { drawer, closeDrawer, setDrawerSession, toast } = useApp()
  const [sessions, setSessions] = useState<SessionInfo[]>([])
  const [loaded, setLoaded] = useState(false)
  const known = useRef(new Set<SessionId>())
  const spawning = useRef(false)
  // shells open in the current chat/draft's project folder (system home when none)
  const chat = useChat()
  const draft = useDraft()
  const projectDir = (activeThread(chat) ?? draft).projectDir ?? null

  const load = useCallback(() => {
    void window.agentswitch.pty.sessions().then((list) => {
      known.current = new Set(list.map((s) => s.sessionId))
      setSessions(list)
      setLoaded(true)
    })
  }, [])

  useEffect(() => {
    load()
    const offExit = window.agentswitch.pty.onExit(load)
    const offState = window.agentswitch.state.onChanged(load)
    // first output of a brand-new session -> add its tab
    const offData = window.agentswitch.pty.onData((e) => {
      if (!known.current.has(e.sessionId)) {
        known.current.add(e.sessionId)
        load()
      }
    })
    return () => {
      offExit()
      offState()
      offData()
    }
  }, [load])

  const active: SessionId | null =
    drawer.session && sessions.some((s) => s.sessionId === drawer.session) ? drawer.session : (sessions[0]?.sessionId ?? null)
  const activeInfo = sessions.find((s) => s.sessionId === active)

  const openShell = useCallback(async () => {
    if (spawning.current) return
    spawning.current = true
    try {
      const id = await window.agentswitch.pty.shell(projectDir, 100, 18)
      setDrawerSession(id)
      load()
      requestAnimationFrame(() => terminals.get(id)?.focus())
    } catch (e) {
      toast({ kind: 'error', title: t('dbg.startFailed'), desc: String(e) })
    } finally {
      spawning.current = false
    }
  }, [projectDir, setDrawerSession, load, toast])

  // Auto-open 1 default terminal window in the current project cwd (or system home) when drawer opens empty
  const autoOpened = useRef(false)
  useEffect(() => {
    if (!drawer.open) {
      autoOpened.current = false
      return
    }
    if (loaded && sessions.length === 0 && !autoOpened.current) {
      autoOpened.current = true
      void openShell()
    }
  }, [drawer.open, loaded, sessions.length, openShell])

  useEffect(() => {
    if (drawer.open && active) requestAnimationFrame(() => terminals.get(active)?.focus())
  }, [drawer.open, active])

  /** Closes a tab: ends its process, drops its scrollback, moves to the neighbouring tab. */
  const remove = async (id: SessionId) => {
    const i = sessions.findIndex((s) => s.sessionId === id)
    const rest = sessions.filter((s) => s.sessionId !== id)
    if (id === active) setDrawerSession(rest[Math.min(i, rest.length - 1)]?.sessionId ?? null)
    known.current.delete(id)
    setSessions(rest)
    try {
      await window.agentswitch.pty.forget(id)
    } finally {
      load()
    }
  }

  const { height, dragging } = useDrawerLayout()
  const onResize = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    e.preventDefault()
    const el = e.currentTarget
    el.setPointerCapture(e.pointerId)
    const startY = e.clientY
    const startH = drawerLayout.height
    const prevCursor = document.body.style.cursor
    document.body.style.cursor = 'row-resize'
    document.body.style.userSelect = 'none'
    setDrawerLayout({ dragging: true })
    const move = (ev: PointerEvent) => setDrawerLayout({ height: clampHeight(startH + (startY - ev.clientY)) })
    const up = () => {
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', up)
      el.removeEventListener('pointercancel', up)
      document.body.style.cursor = prevCursor
      document.body.style.userSelect = ''
      setDrawerLayout({ dragging: false })
    }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
    el.addEventListener('pointercancel', up)
  }, [])

  const chip =
    'h-7 shrink-0 rounded-md px-2.5 text-[12px] font-medium text-white/70 hover:bg-white/10 hover:text-white disabled:opacity-30 disabled:pointer-events-none transition-colors'

  return (
    <div
      aria-hidden={!drawer.open}
      className={`dark-scroll absolute inset-x-3 bottom-0 z-30 flex flex-col overflow-hidden rounded-t-[14px] bg-[#1C1C1E] shadow-[0_-1px_0_rgba(0,0,0,0.08),0_-16px_48px_rgba(0,0,0,0.18)] ${
        dragging ? '' : 'transition-[transform,opacity] duration-[260ms] ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none'
      } ${drawer.open ? 'pointer-events-auto opacity-100' : 'pointer-events-none opacity-0'}`}
      style={{
        height,
        transform: drawer.open ? 'translateY(0)' : 'translateY(100%)'
      }}
    >
      {/* top drag-to-resize handle (double-click resets height) */}
      <div
        className="group absolute inset-x-0 top-0 z-20 h-[7px] cursor-row-resize"
        onPointerDown={onResize}
        onDoubleClick={() => setDrawerLayout({ height: DRAWER_HEIGHT })}
      >
        <div className="mx-auto h-[2px] w-full bg-transparent transition-colors duration-150 group-hover:bg-accent/60 group-active:bg-accent" />
      </div>
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-white/[0.06] bg-[#2C2C2E] px-3">
        <span className="shrink-0 font-mono text-[12px] font-medium text-white/50">&gt;_ {t('nav.debugLog')}</span>

        {/* tabs: scroll horizontally, never squeeze the toolbar */}
        <div className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto [&::-webkit-scrollbar]:hidden">
          {sessions.map((s) => (
            <div
              key={s.sessionId}
              role="tab"
              onClick={() => setDrawerSession(s.sessionId)}
              onAuxClick={(e) => e.button === 1 && void remove(s.sessionId)}
              className={`group flex h-7 shrink-0 cursor-default items-center gap-1.5 rounded-md pr-1 pl-2.5 text-[12px] whitespace-nowrap transition-colors ${
                s.sessionId === active ? 'bg-white/[0.12] text-white' : 'text-white/50 hover:text-white/85'
              }`}
              title={`${s.sessionId}${s.mode ? ` · ${s.mode}` : ''}${s.alive ? t('dbg.alive') : t('dbg.ended')}${s.cwd ? `\n${s.cwd}` : ''}`}
            >
              <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${s.alive ? 'bg-green' : 'bg-white/25'}`} />
              {s.label}
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  void remove(s.sessionId)
                }}
                className={`grid h-4 w-4 place-items-center rounded text-white/50 transition-opacity hover:bg-white/15 hover:text-white ${
                  s.sessionId === active ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
                }`}
                title={s.alive ? t('dbg.closeRunning') : t('dbg.closeTab')}
                aria-label={t('dbg.closeTab')}
              >
                <IconX size={10} />
              </button>
            </div>
          ))}
          <button
            onClick={() => void openShell()}
            className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-white/55 transition-colors hover:bg-white/10 hover:text-white"
            title={t('dbg.newShell')}
            aria-label={t('dbg.newShell')}
          >
            <IconPlus size={14} />
          </button>
        </div>

        {/* toolbar: fixed width, never truncated */}
        <div className="flex shrink-0 items-center gap-1">
          <span
            className="max-w-[240px] shrink truncate font-mono text-[11px] text-white/40"
            title={activeInfo?.cwd ? t('dbg.cwd', { path: activeInfo.cwd }) : t('dbg.newShellCwd', { path: projectDir ?? '~' })}
          >
            {activeInfo?.cwd ? tilde(activeInfo.cwd) : tilde(projectDir ?? '~')}
          </span>
          <button className={chip} disabled={!activeInfo?.alive} onClick={() => active && void window.agentswitch.pty.kill(active)}>
            {t('dbg.end')}
          </button>
          <button className={chip} disabled={!active} onClick={() => active && terminals.get(active)?.clear()}>
            {t('dbg.clear')}
          </button>
          <button className="ml-0.5 shrink-0 rounded-md p-1.5 text-white/50 hover:bg-white/10 hover:text-white" onClick={closeDrawer} title={t('common.collapse')}>
            <IconX size={14} />
          </button>
        </div>
      </div>

      <div className="relative min-h-0 flex-1 bg-[#0B0D10]">
        {sessions.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-white/40">
            <IconTerminal size={22} />
            <div className="text-[13px]">{t('dbg.empty')}</div>
          </div>
        ) : (
          sessions.map((s) => <XtermView key={s.sessionId} sessionId={s.sessionId} visible={drawer.open && s.sessionId === active} />)
        )}
      </div>
    </div>
  )
}
