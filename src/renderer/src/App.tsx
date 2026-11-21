import { AppProvider, useApp } from './state/AppContext'
import { NavRail } from './components/NavRail'
import { DebugDrawer, DRAWER_HEIGHT } from './components/DebugDrawer'
import { LoginModal } from './components/LoginModal'
import { Toasts } from './components/Toasts'
import { ProfileConfigModal } from './components/ProfileConfigModal'
import { AddAccountModal, CliConfigModal, ConfirmDialog } from './components/dialogs'
import { WorkflowsPage } from './pages/WorkflowsPage'
import { EnginesPage } from './pages/EnginesPage'

function Shell() {
  const { page, drawer, loginId, configId, byId, info, openConfig, cliConfigKind, addRequest, confirmState, removeAccount, kindState } = useApp()
  const configProfile = configId ? byId(configId) : undefined

  return (
    <div className="flex h-full">
      <NavRail />
      <main className="relative flex min-w-0 flex-1 flex-col overflow-hidden bg-canvas">
        <div className="min-h-0 flex-1" style={{ paddingBottom: drawer.open ? DRAWER_HEIGHT : 0 }}>
          {page === 'workflows' ? <WorkflowsPage /> : <EnginesPage />}
        </div>
        <DebugDrawer />
      </main>

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
    </div>
  )
}

export default function App() {
  return (
    <AppProvider>
      <Shell />
    </AppProvider>
  )
}
