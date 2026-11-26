import { useEffect, useState, type ReactNode } from 'react'
import { useApp } from '../state/AppContext'
import { t } from '../state/i18n'
import { useDrawerLayout } from './DebugDrawer'
import { SheetCloseButton, WorkspaceSheetModal } from './WorkspaceSheetModal'
import { UsagePage } from '../pages/UsagePage'
import { EnginesPage } from '../pages/EnginesPage'

/**
 * 用量限额 / 模型引擎 as centred dialogs over the chat (like Settings): the conversation keeps
 * its scroll and draft. The scrim covers the whole window; the terminal drawer is lifted above
 * it (see DebugDrawer) so it stays usable (install / login), and the sheet centres above it.
 */
export function PageDialog() {
  const { page, navigate, drawer } = useApp()
  const { height: drawerHeight } = useDrawerLayout()
  const open = page !== 'workbench'
  const [shown, setShown] = useState<Exclude<typeof page, 'workbench'>>('usage')
  useEffect(() => {
    if (page !== 'workbench') setShown(page)
  }, [page])
  const close = () => navigate('workbench')
  const which = open ? page : shown
  return (
    <WorkspaceSheetModal
      open={open}
      onClose={close}
      bottomOffset={drawer.open ? drawerHeight : 0}
      panelClassName="bg-canvas"
      ariaLabel={t(which === 'usage' ? 'usage.title' : 'eng.title')}
    >
      {which === 'usage' ? <UsagePage onClose={close} /> : <EnginesPage onClose={close} />}
    </WorkspaceSheetModal>
  )
}

/** Fixed dialog header: title, description, actions and ×. */
export function DialogHeader({ title, desc, actions, onClose }: { title: string; desc: string; actions?: ReactNode; onClose: () => void }) {
  return (
    <header className="flex shrink-0 items-start gap-3 border-b border-hairline pt-4 pr-3 pb-3 pl-8">
      <div className="min-w-0 flex-1">
        <h1 className="text-[22px] leading-tight font-semibold tracking-tight text-ink">{title}</h1>
        <p className="mt-1.5 text-[13px] leading-relaxed text-ink-3">{desc}</p>
      </div>
      {actions}
      <div className="-mt-2"><SheetCloseButton onClick={onClose} /></div>
    </header>
  )
}
