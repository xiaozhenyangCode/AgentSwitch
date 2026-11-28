import { useApp } from '../state/AppContext'
import { IconAlert, IconCheck, IconX } from './icons'

const ICON = {
  success: (
    <span className="flex h-6 w-6 items-center justify-center rounded-full bg-ok-soft text-ok">
      <IconCheck size={14} strokeWidth={2.4} />
    </span>
  ),
  error: (
    <span className="flex h-6 w-6 items-center justify-center rounded-full bg-danger-soft text-danger">
      <IconAlert size={14} />
    </span>
  ),
  warn: (
    <span className="flex h-6 w-6 items-center justify-center rounded-full bg-warn-soft text-warn">
      <IconAlert size={14} />
    </span>
  ),
  info: (
    <span className="flex h-6 w-6 items-center justify-center rounded-full bg-info-soft text-accent">
      <span className="text-[13px] font-bold">i</span>
    </span>
  )
}

export function Toasts() {
  const { toasts, dismissToast } = useApp()
  return (
    <div className="pointer-events-none fixed top-[68px] right-5 z-[60] flex w-[340px] flex-col gap-2.5">
      {toasts.map((t) => (
        <div
          key={t.id}
          className="pointer-events-auto flex items-start gap-3 rounded-xl border border-editor-hairline bg-elevated px-4 py-3.5 shadow-[0_10px_30px_rgba(0,0,0,0.12)]"
        >
          {ICON[t.kind]}
          <div className="min-w-0 flex-1 pt-0.5">
            <div className="text-[14px] leading-5 font-semibold break-words text-ink">{t.title}</div>
            {t.desc && <div className="mt-0.5 max-h-48 overflow-y-auto text-[13px] leading-relaxed break-words whitespace-pre-wrap text-ink-2">{t.desc}</div>}
            {t.action && (
              <button
                className="mt-1.5 text-[13px] font-medium text-accent hover:text-accent-hover"
                onClick={() => {
                  t.action!.run()
                  dismissToast(t.id)
                }}
              >
                {t.action.label}
              </button>
            )}
          </div>
          <button className="mt-0.5 rounded-full p-1 text-ink-3 hover:bg-black/[0.05] hover:text-ink" onClick={() => dismissToast(t.id)}>
            <IconX size={13} />
          </button>
        </div>
      ))}
    </div>
  )
}
