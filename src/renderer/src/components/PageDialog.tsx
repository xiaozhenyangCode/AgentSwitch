import { useEffect, useState, type ReactNode } from 'react'
import { useApp } from '../state/AppContext'
import { useEscape } from '../lib/escStack'
import { t } from '../state/i18n'
import { useDrawerLayout } from './DebugDrawer'
import { IconX } from './icons'
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
  const [shown, setShown] = useState<typeof page>(page)
  useEffect(() => {
    if (open) return setShown(page)
    const h = setTimeout(() => setShown('workbench'), 150)
    return () => clearTimeout(h)
  }, [open, page])
  const close = () => navigate('workbench')
  useEscape(close, open)
  const which = open ? page : shown
  if (which === 'workbench') return null
  return (
    <div
      className={`no-drag fixed inset-0 z-40 bg-(--scrim-soft) backdrop-blur-[3px] ${open ? 'scrim-in' : 'scrim-out'}`}
      onMouseDown={(e) => e.target === e.currentTarget && close()}
      role="presentation"
    >
      <div
        className="pointer-events-none absolute inset-x-0 top-0 flex items-center justify-center"
        style={{ bottom: drawer.open ? drawerHeight : 0 }}
      >
        <div
          role="dialog"
          aria-modal="true"
          className={`pointer-events-auto flex h-[680px] max-h-[88%] w-[980px] max-w-[92vw] flex-col overflow-hidden rounded-2xl bg-canvas shadow-[0_0_0_1px_var(--ring),0_24px_64px_rgba(0,0,0,0.22),0_8px_24px_rgba(0,0,0,0.10)] ${open ? 'sheet-in' : 'sheet-out'}`}
        >
          {which === 'usage' ? <UsagePage onClose={close} /> : <EnginesPage onClose={close} />}
        </div>
      </div>
    </div>
  )
}

/** Fixed dialog header: title, description, actions and ×. */
export function DialogHeader({ title, desc, actions, onClose }: { title: string; desc: string; actions?: ReactNode; onClose: () => void }) {
  return (
    <div className="flex shrink-0 items-start gap-4 border-b border-hairline px-8 pt-6 pb-4">
      <div className="min-w-0 flex-1">
        <h1 className="text-[22px] leading-tight font-semibold tracking-tight text-ink">{title}</h1>
        <p className="mt-1.5 text-[13px] leading-relaxed text-ink-3">{desc}</p>
      </div>
      {actions}
      <button onClick={onClose} className="-mr-2 flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-ink-3 hover:bg-black/[0.06] hover:text-ink" title={t('common.close')}>
        <IconX size={16} />
      </button>
    </div>
  )
}
