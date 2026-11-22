import { AppProvider, useApp } from './state/AppContext'
import { NavRail } from './components/NavRail'
import { DebugDrawer, useDrawerLayout } from './components/DebugDrawer'
import { LoginModal } from './components/LoginModal'
import { Toasts } from './components/Toasts'
import { ProfileConfigModal } from './components/ProfileConfigModal'
import { AddAccountModal, CliConfigModal, ConfirmDialog } from './components/dialogs'
import { WorkbenchPage } from './pages/WorkbenchPage'
import { PageDialog } from './components/PageDialog'
import { SettingsDialog } from './components/SettingsDialog'
import { OnboardingPage } from './pages/OnboardingPage'
import { useOnboarding } from './state/onboarding'
import { useEffect } from 'react'
import { useI18n, t } from './state/i18n'
import { useStartThread } from './state/threads'
import { activeThread, clearUnread, onTurnFinished, selectThread, useChat } from './state/chat'

/** Native menu bar → navigation (About / Settings… ⌘, / New Chat ⌘N / Search ⌘K). */
function MenuBridge() {
  const { openSettings, toggleSettings, closeSettings, settingsOpen, navigate, toggleSidebar, setSidebarOpen } = useApp()
  const start = useStartThread()
  const chat = useChat()
  useEffect(
    () =>
      window.agentswitch.onMenu((cmd) => {
        if (cmd === 'about') openSettings('about')
        else if (cmd === 'settings') toggleSettings()
        else if (cmd === 'toggleSidebar') toggleSidebar()
        else {
          // chat commands act on the page under the dialog
          if (settingsOpen) closeSettings()
          navigate('workbench')
          if (cmd === 'newThread') start(activeThread(chat)?.projectDir ?? null)
          else if (cmd === 'search') {
            if (document.activeElement?.closest('.xterm')) {
              window.dispatchEvent(new Event('agentswitch:xterm-clear'))
              return
            }
            setSidebarOpen(true)
            requestAnimationFrame(() => window.dispatchEvent(new Event('agentswitch:focus-search')))
          }
        }
      }),
    [openSettings, toggleSettings, closeSettings, settingsOpen, navigate, toggleSidebar, setSidebarOpen, start, chat]
  )
  return null
}

/** Subtle two-note completion chime synthesized via Web Audio (no external audio assets). */
function playChime(outcome: 'done' | 'error' | 'paused') {
  try {
    const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
    if (!AudioCtx) return
    const ctx = new AudioCtx()
    const now = ctx.currentTime
    const notes = outcome === 'done' ? [587.33, 880] : outcome === 'paused' ? [523.25, 659.25] : [392, 311.13]
    notes.forEach((freq, i) => {
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.type = 'sine'
      osc.frequency.setValueAtTime(freq, now + i * 0.09)
      gain.gain.setValueAtTime(0.0001, now + i * 0.09)
      gain.gain.exponentialRampToValueAtTime(0.055, now + i * 0.09 + 0.015)
      gain.gain.exponentialRampToValueAtTime(0.0001, now + i * 0.09 + 0.24)
      osc.connect(gain)
      gain.connect(ctx.destination)
      osc.start(now + i * 0.09)
      osc.stop(now + i * 0.09 + 0.26)
    })
    setTimeout(() => void ctx.close().catch(() => {}), 700)
  } catch {
    // audio may be blocked before first user gesture
  }
}

/** Notifies when a turn finishes: in-app toast for background chats, native OS notification when unfocused, and a gentle chime. */
function TurnNotifier() {
  const { toast, navigate } = useApp()
  const chat = useChat()
  const activeId = chat.activeId

  useEffect(
    () =>
      onTurnFinished(({ threadId, title, outcome, background }) => {
        playChime(outcome)
        const label =
          outcome === 'done'
            ? t('nav.notifyDone', { title })
            : outcome === 'paused'
              ? t('nav.notifyPaused', { title })
              : t('nav.notifyFailed', { title })
        if (background) {
          toast({
            kind: outcome === 'done' ? 'success' : outcome === 'paused' ? 'warn' : 'error',
            title: label,
            action: {
              label: t('nav.viewChat'),
              run: () => {
                selectThread(threadId)
                navigate('workbench')
              }
            }
          })
        }
        if (typeof Notification !== 'undefined' && !document.hasFocus()) {
          const show = () => {
            const n = new Notification('AgentSwitch', { body: label, silent: true })
            n.onclick = () => {
              window.focus()
              selectThread(threadId)
              navigate('workbench')
            }
          }
          if (Notification.permission === 'granted') show()
          else if (Notification.permission === 'default') void Notification.requestPermission().then((p) => p === 'granted' && show())
        }
      }),
    [toast, navigate]
  )

  // clear the active thread's unread badge shortly after returning focus to the window
  useEffect(() => {
    const onFocus = () => {
      if (!activeId) return
      setTimeout(() => clearUnread(activeId), 1200)
    }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [activeId])

  return null
}

function Shell() {
  const { drawer, loginId, configId, byId, info, openConfig, cliConfigKind, addRequest, confirmState, removeAccount, kindState } = useApp()
  const { height: drawerHeight, dragging: drawerDragging } = useDrawerLayout()
  const configProfile = configId ? byId(configId) : undefined
  const onboarding = useOnboarding()

  return (
    <div className="flex h-full">
      {onboarding ? (
        <OnboardingPage />
      ) : (
        <>
          <NavRail />
          <main className="relative flex min-w-0 flex-1 flex-col overflow-clip bg-canvas">
            <div
              className={`min-h-0 flex-1 overflow-clip ${
                drawerDragging ? '' : 'transition-[padding-bottom] duration-[260ms] ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none'
              }`}
              style={{ paddingBottom: drawer.open ? drawerHeight : 0 }}
            >
              <WorkbenchPage />
            </div>
            <DebugDrawer />
          </main>
          <PageDialog />
          <SettingsDialog />
        </>
      )}

      {loginId && byId(loginId) && <LoginModal key={loginId} profileId={loginId} />}
      {configProfile && info && (
        <ProfileConfigModal
          key={configProfile.id}
          profile={configProfile}
          userData={info.userData}
          onClose={() => openConfig(null)}
          onDelete={() => void removeAccount(configProfile.id)}
        />
      )}
      {cliConfigKind && kindState(cliConfigKind) && <CliConfigModal key={cliConfigKind} kind={cliConfigKind} />}
      {addRequest && <AddAccountModal key={addRequest.kind} />}
      {confirmState && <ConfirmDialog />}
      <Toasts />
      <TurnNotifier />
      <MenuBridge />
    </div>
  )
}

export default function App() {
  // a language switch re-mounts the shell so every t() call re-renders in the new language
  const { locale } = useI18n()
  return (
    <AppProvider>
      <Shell key={locale} />
    </AppProvider>
  )
}
