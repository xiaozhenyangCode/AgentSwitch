import { useApp } from '../state/AppContext'
import { IconAlert, IconCheck, IconX } from './icons'

const ICON = {
  success: (
    <span className="flex h-6 w-6 items-center justify-center rounded-full bg-[#E6F6EC] text-[#1A7F45]">
      <IconCheck size={14} strokeWidth={2.4} />
    </span>
  ),
  error: (
    <span className="flex h-6 w-6 items-center justify-center rounded-full bg-[#FDECEC] text-[#C2352B]">
      <IconAlert size={14} />
    </span>
  ),
  warn: (
    <span className="flex h-6 w-6 items-center justify-center rounded-full bg-[#FFF4E0] text-[#9A5B13]">
      <IconAlert size={14} />
    </span>
  ),
  info: (
    <span className="flex h-6 w-6 items-center justify-center rounded-full bg-[#E8F1FF] text-accent">
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
          className="pointer-events-auto flex items-start gap-3 rounded-2xl bg-white/95 px-4 py-3.5 shadow-[0_0_0_1px_rgba(0,0,0,0.06),0_10px_30px_rgba(0,0,0,0.12)] backdrop-blur-xl"
        >
          {ICON[t.kind]}
          <div className="min-w-0 flex-1 pt-0.5">
            <div className="text-[14px] leading-5 font-semibold text-ink">{t.title}</div>
            {t.desc && <div className="mt-0.5 text-[13px] leading-relaxed break-words text-ink-2">{t.desc}</div>}
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
