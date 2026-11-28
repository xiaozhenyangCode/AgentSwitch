import { AppProvider, useApp } from './state/AppContext'
import { Modal } from './components/common'
import { EDITOR_CHAT_MIN_H, EDITOR_PANEL_MIN_H, TRAFFIC_LIGHT_SAFE_LEFT_PX } from './lib/editorLayout'
import { btnPrimary, btnSecondary } from './lib/ui'
import { IconSidebar } from './components/icons'
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
import { activeThread, clearUnread, onTurnFinished, resolveUnsavedChatClose, selectThread, useChat, useChatStatus, useUnsavedChatClose } from './state/chat'

/** Native menu bar → navigation (About / Settings… ⌘, / New Chat ⌘N / Search ⌘K). */
function MenuBridge({ chatsAvailable }: { chatsAvailable: boolean }) {
  const { openSettings, toggleSettings, closeSettings, settingsOpen, navigate, toggleSidebar, setSidebarOpen } = useApp()
  const start = useStartThread()
  const chat = useChat()
  useEffect(
    () =>
      window.agentswitch.onMenu((cmd) => {
        if (cmd === 'about') openSettings('about')
        else if (cmd === 'settings') toggleSettings()
        else if (cmd === 'toggleSidebar') toggleSidebar()
        else if (chatsAvailable) {
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
    [openSettings, toggleSettings, closeSettings, settingsOpen, navigate, toggleSidebar, setSidebarOpen, start, chat, chatsAvailable]
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

function Shell({ chatStatus }: { chatStatus: ReturnType<typeof useChatStatus> }) {
  const { drawer, loginId, configId, byId, info, openConfig, cliConfigKind, addRequest, confirmState, removeAccount, kindState, page, sidebarOpen, toggleSidebar, editorMaximized, trafficLightOwner, workspaceEditorOpen, editorLayout } = useApp()
  const { height: drawerHeight, dragging: drawerDragging } = useDrawerLayout()
  const configProfile = configId ? byId(configId) : undefined
  const onboarding = useOnboarding()
  const chatsAvailable = chatStatus === 'ready' || chatStatus === 'saveFailed'
  const bottomEditor = page === 'workbench' && workspaceEditorOpen && editorLayout.dockPosition === 'bottom'
  const visibleDrawerHeight = bottomEditor
    ? `min(${drawerHeight}px, max(0px, calc(100cqh - ${EDITOR_CHAT_MIN_H + EDITOR_PANEL_MIN_H}px)))`
    : drawerHeight

  return (
    <div className="flex h-full">
      {onboarding ? (
        <OnboardingPage />
      ) : (
        <>
          <NavRail chatsAvailable={chatsAvailable} hiddenByMaximize={editorMaximized}
            needsTrafficLightSafeArea={trafficLightOwner === 'sidebar'} />
          <main className="relative flex min-w-0 flex-1 flex-col overflow-clip bg-canvas"
            style={bottomEditor ? { containerType: 'size' } : undefined}>
            <div
              className={`min-h-0 flex-1 overflow-clip ${
                drawerDragging ? '' : 'transition-[padding-bottom] duration-[260ms] ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none'
              }`}
              style={{ paddingBottom: drawer.open ? visibleDrawerHeight : 0 }}
            >
              {chatsAvailable ? <WorkbenchPage /> : (
                <div className="grid h-full place-items-center px-8 text-center text-sm text-ink-2">
                  {!sidebarOpen && (
                    <div className="drag absolute inset-x-0 top-0 flex h-[52px] items-center pl-3"
                      style={trafficLightOwner === 'chat' ? { paddingLeft: TRAFFIC_LIGHT_SAFE_LEFT_PX } : undefined}>
                      <button className="no-drag rounded-lg p-1.5 hover:bg-surface-2" onClick={toggleSidebar}
                        aria-label={t('nav.showSidebar')}>
                        <IconSidebar size={16} />
                      </button>
                    </div>
                  )}
                  {chatStatus === 'loading' ? <p role="status">{t('chat.loading')}</p> : <p role="alert">{t('chat.loadFailed')}</p>}
                </div>
              )}
            </div>
            <DebugDrawer visibleHeight={visibleDrawerHeight} />
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
      <MenuBridge chatsAvailable={chatsAvailable} />
    </div>
  )
}

function UnsavedChatDialog() {
  const cancel = () => resolveUnsavedChatClose(false)
  return (
    <Modal onClose={cancel} width={420}>
      <div className="p-7" role="alertdialog" aria-modal="true" aria-labelledby="chat-close-title" aria-describedby="chat-close-detail">
        <h2 id="chat-close-title" className="text-[17px] font-semibold text-ink">{t('chat.closeTitle')}</h2>
        <p id="chat-close-detail" className="mt-2 text-[14px] leading-relaxed text-ink-2">{t('chat.closeUnsaved')}</p>
        <div className="mt-7 flex justify-end gap-2.5">
          <button autoFocus className={btnSecondary} onClick={cancel}>{t('common.cancel')}</button>
          <button className={btnPrimary} onClick={() => resolveUnsavedChatClose(true)}>{t('chat.closeAnyway')}</button>
        </div>
      </div>
    </Modal>
  )
}

function ChatShell({ locale }: { locale: string }) {
  const { trafficLightOwner } = useApp()
  const status = useChatStatus()
  const confirmClose = useUnsavedChatClose()
  return (
    <>
      <div className="flex h-full flex-col" inert={confirmClose}>
        <div className="min-h-0 flex-1">
          <Shell key={locale} chatStatus={status} />
        </div>
        {status === 'saveFailed' && (
          <div role="alert" className="shrink-0 bg-warn-soft py-2 pr-4 pl-3 text-sm text-ink"
            style={trafficLightOwner !== 'none' ? { paddingLeft: TRAFFIC_LIGHT_SAFE_LEFT_PX } : undefined}>
            {t('chat.saveFailed')}
          </div>
        )}
      </div>
      {confirmClose && <UnsavedChatDialog />}
    </>
  )
}

export default function App() {
  // A language switch remounts the shell so every t() call uses the new language.
  const { locale } = useI18n()
  return (
    <AppProvider>
      <ChatShell locale={locale} />
    </AppProvider>
  )
}
