import { AppProvider, useApp } from './state/AppContext'
import { NavRail } from './components/NavRail'
import { DebugDrawer, DRAWER_HEIGHT } from './components/DebugDrawer'
import { LoginModal } from './components/LoginModal'
import { Toasts } from './components/Toasts'
import { ProfileConfigModal } from './components/ProfileConfigModal'
import { AddAccountModal, CliConfigModal, ConfirmDialog } from './components/dialogs'
import { WorkbenchPage } from './pages/WorkbenchPage'
import { EnginesPage } from './pages/EnginesPage'
import { UsagePage } from './pages/UsagePage'
import { SettingsDialog } from './components/SettingsDialog'
import { OnboardingPage } from './pages/OnboardingPage'
import { useOnboarding } from './state/onboarding'
import { useEffect } from 'react'
import { useI18n } from './state/i18n'
import { useStartThread } from './state/threads'
import { activeThread, useChat } from './state/chat'

/** Native menu bar → navigation (About / Settings… ⌘, / New Chat ⌘N / Search ⌘K). */
function MenuBridge() {
  const { openSettings, toggleSettings, closeSettings, settingsOpen } = useApp()
  const start = useStartThread()
  const chat = useChat()
  useEffect(
    () =>
      window.agentswitch.onMenu((cmd) => {
        if (cmd === 'about') openSettings('about')
        else if (cmd === 'settings') toggleSettings()
        else {
          // chat commands act on the page under the dialog
          if (settingsOpen) closeSettings()
          if (cmd === 'newThread') start(activeThread(chat)?.projectDir ?? null)
          else if (cmd === 'search') window.dispatchEvent(new Event('agentswitch:focus-search'))
        }
      }),
    [openSettings, toggleSettings, closeSettings, settingsOpen, start, chat]
  )
  return null
}

function Shell() {
  const { page, drawer, loginId, configId, byId, info, openConfig, cliConfigKind, addRequest, confirmState, removeAccount, kindState } = useApp()
  const configProfile = configId ? byId(configId) : undefined
  const onboarding = useOnboarding()

  return (
    <div className="flex h-full">
      {onboarding ? (
        <OnboardingPage />
      ) : (
        <>
          <NavRail />
          <main className="relative flex min-w-0 flex-1 flex-col overflow-hidden bg-canvas">
            <div className="min-h-0 flex-1" style={{ paddingBottom: drawer.open ? DRAWER_HEIGHT : 0 }}>
              {page === 'workbench' ? <WorkbenchPage /> : page === 'usage' ? <UsagePage /> : <EnginesPage />}
            </div>
            <DebugDrawer />
          </main>
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
