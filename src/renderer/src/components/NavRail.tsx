import { useApp, type Page } from '../state/AppContext'
import { IconEngine, IconTerminal, IconWorkflow } from './icons'

const ITEMS: { page: Page; label: string; Icon: typeof IconWorkflow }[] = [
  { page: 'workflows', label: '工作流', Icon: IconWorkflow },
  { page: 'engines', label: '模型引擎', Icon: IconEngine }
]

/** Frosted sidebar; the native `vibrancy: 'sidebar'` material shows through the translucent fill. */
export function NavRail() {
  const { page, navigate, profiles, drawer, openDrawer, closeDrawer, info } = useApp()
  const attention = profiles.filter((p) => p.status === 'uninstalled' || p.status === 'not_logged_in').length

  return (
    <nav className="drag flex w-[228px] shrink-0 flex-col border-r border-black/[0.06] bg-[#F3F3F5]/85 backdrop-blur-2xl">
      {/* traffic-light zone */}
      <div className="h-[52px] shrink-0" />

      <div className="flex items-center gap-2.5 px-5 pb-6">
        <div className="flex h-8 w-8 items-center justify-center rounded-[9px] bg-gradient-to-b from-[#3A8DFF] to-[#0066D6] shadow-[inset_0_1px_0_rgba(255,255,255,0.35),0_1px_3px_rgba(0,102,214,0.35)]">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="6" cy="12" r="2.2" />
            <circle cx="18" cy="6" r="2.2" />
            <circle cx="18" cy="18" r="2.2" />
            <path d="M8.2 11 15.8 7M8.2 13l7.6 4" />
          </svg>
        </div>
        <div>
          <div className="text-[15px] leading-5 font-semibold tracking-tight text-ink">AgentMux</div>
          <div className="text-[12px] leading-4 text-ink-2">多模型工作流</div>
        </div>
      </div>

      <div className="flex flex-col gap-0.5 px-3">
        {ITEMS.map(({ page: p, label, Icon }) => {
          const active = page === p
          return (
            <button
              key={p}
              onClick={() => navigate(p)}
              className={`no-drag flex h-9 items-center gap-3 rounded-lg px-3 text-[14px] font-medium transition-colors duration-150 ${
                active ? 'bg-black/[0.06] text-ink' : 'text-ink/80 hover:bg-black/[0.035]'
              }`}
            >
              <Icon size={18} className={active ? 'text-accent' : 'text-ink-2'} />
              <span className="flex-1 text-left">{label}</span>
              {p === 'engines' && attention > 0 && (
                <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-[#FF9F0A] px-1.5 text-[12px] font-semibold text-white">
                  {attention}
                </span>
              )}
            </button>
          )
        })}
      </div>

      <div className="flex-1" />

      <div className="px-3 pb-4">
        <button
          onClick={() => (drawer.open ? closeDrawer() : openDrawer())}
          className={`no-drag flex h-8 w-full items-center gap-2 rounded-lg px-3 text-[13px] transition-colors ${
            drawer.open ? 'bg-black/[0.06] text-ink' : 'text-ink-3 hover:bg-black/[0.035] hover:text-ink-2'
          }`}
        >
          <IconTerminal size={15} />
          <span className="flex-1 text-left">调试日志</span>
          {info && (
            <span
              className={`h-1.5 w-1.5 rounded-full ${info.shellEnvSource === 'fallback' ? 'bg-[#FF9F0A]' : 'bg-[#34C759]'}`}
              title={
                (info.shellEnvSource === 'login' ? 'Shell 环境已加载' : info.shellEnvSource === 'cache' ? 'Shell 环境（缓存）' : 'Shell 环境回退：' + info.shellEnvError) +
                '\n\n' +
                info.path.split(':').join('\n')
              }
            />
          )}
        </button>
      </div>
    </nav>
  )
}
