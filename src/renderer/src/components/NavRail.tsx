import { useEffect, useMemo, useRef, useState } from 'react'
import { useApp } from '../state/AppContext'
import { activeThread, deleteThread, isThreadBusy, renameThread, selectThread, useChat, type Thread } from '../state/chat'
import { useStartThread } from '../state/threads'
import { IconEngine, IconFolder, IconPlus, IconTerminal, Spinner } from './icons'

const baseName = (p: string) => p.split('/').filter(Boolean).pop() ?? p

function ago(ts: number): string {
  const s = (Date.now() - ts) / 1000
  if (s < 60) return '刚刚'
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`
  if (s < 86400 * 7) return `${Math.floor(s / 86400)} 天前`
  return new Date(ts).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })
}

/** Frosted sidebar; the native `vibrancy: 'sidebar'` material shows through the translucent fill. */
export function NavRail() {
  const { page, navigate, profiles, drawer, openDrawer, closeDrawer, info, confirm } = useApp()
  const chat = useChat()
  const start = useStartThread()
  const attention = profiles.filter((p) => p.status === 'uninstalled' || p.status === 'not_logged_in').length
  const current = activeThread(chat)

  // group by project; groups ordered by their most recent thread
  const groups = useMemo(() => {
    const map = new Map<string, Thread[]>()
    for (const t of [...chat.threads].sort((a, b) => b.updatedAt - a.updatedAt)) {
      const k = t.projectDir ?? ''
      map.set(k, [...(map.get(k) ?? []), t])
    }
    return [...map.entries()]
  }, [chat.threads])

  const remove = async (t: Thread) => {
    const ok = await confirm({
      title: `删除「${t.title}」？`,
      message: '只会删除这条对话记录，不会改动项目文件夹里的任何文件。',
      confirmLabel: '删除对话',
      destructive: true
    })
    if (ok) deleteThread(t.id)
  }

  return (
    <nav className="drag flex w-[248px] shrink-0 flex-col border-r border-black/[0.06] bg-[#F3F3F5]/85 backdrop-blur-2xl">
      {/* traffic-light zone */}
      <div className="h-[52px] shrink-0" />

      <div className="flex items-center gap-2.5 px-5 pb-4">
        <div className="flex h-8 w-8 items-center justify-center rounded-[9px] bg-gradient-to-b from-[#3A8DFF] to-[#0066D6] shadow-[inset_0_1px_0_rgba(255,255,255,0.35),0_1px_3px_rgba(0,102,214,0.35)]">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="6" cy="12" r="2.2" />
            <circle cx="18" cy="6" r="2.2" />
            <circle cx="18" cy="18" r="2.2" />
            <path d="M8.2 11 15.8 7M8.2 13l7.6 4" />
          </svg>
        </div>
        <div className="text-[15px] leading-5 font-semibold tracking-tight text-ink">AgentMux</div>
      </div>

      <div className="px-3 pb-3">
        <button
          onClick={() => start(current?.projectDir ?? null)}
          className="no-drag flex h-9 w-full items-center justify-center gap-1.5 rounded-[10px] bg-white text-[14px] font-medium text-ink shadow-[0_0_0_1px_rgba(0,0,0,0.07),0_1px_2px_rgba(0,0,0,0.05)] transition-all hover:bg-[#FAFAFB] active:scale-[0.98]"
        >
          <IconPlus size={16} className="text-accent" /> 新建对话
        </button>
      </div>

      <div className="no-drag min-h-0 flex-1 overflow-y-auto px-3 pb-3">
        {groups.length === 0 && <div className="px-3 pt-6 text-center text-[13px] leading-relaxed text-ink-3">还没有对话</div>}
        {groups.map(([dir, threads]) => (
          <div key={dir || '_'} className="mb-3">
            <div className="flex h-7 items-center gap-1.5 px-2.5 text-[12px] font-medium text-ink-3" title={dir || undefined}>
              <IconFolder size={13} className="shrink-0" />
              <span className="truncate">{dir ? baseName(dir) : '未选择项目'}</span>
            </div>
            {threads.map((t) => (
              <ThreadRow
                key={t.id}
                t={t}
                active={page === 'workbench' && t.id === current?.id}
                onOpen={() => {
                  selectThread(t.id)
                  navigate('workbench')
                }}
                onDelete={() => void remove(t)}
              />
            ))}
          </div>
        ))}
      </div>

      <div className="border-t border-black/[0.05] px-3 pt-2 pb-4">
        <button
          onClick={() => navigate('engines')}
          className={`no-drag flex h-9 w-full items-center gap-3 rounded-lg px-3 text-[14px] font-medium transition-colors ${
            page === 'engines' ? 'bg-black/[0.06] text-ink' : 'text-ink/80 hover:bg-black/[0.035]'
          }`}
        >
          <IconEngine size={18} className={page === 'engines' ? 'text-accent' : 'text-ink-2'} />
          <span className="flex-1 text-left">模型引擎</span>
          {attention > 0 && (
            <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-[#FF9F0A] px-1.5 text-[12px] font-semibold text-white" title={`${attention} 个账号未就绪`}>
              {attention}
            </span>
          )}
        </button>
        <button
          onClick={() => (drawer.open ? closeDrawer() : openDrawer())}
          className={`no-drag mt-0.5 flex h-8 w-full items-center gap-2 rounded-lg px-3 text-[13px] transition-colors ${
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

function ThreadRow({ t, active, onOpen, onDelete }: { t: Thread; active: boolean; onOpen: () => void; onDelete: () => void }) {
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState(t.title)
  const [menu, setMenu] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const busy = isThreadBusy(t)
  useEffect(() => setName(t.title), [t.title])
  useEffect(() => {
    if (!menu) return
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setMenu(false)
    window.addEventListener('mousedown', close)
    return () => window.removeEventListener('mousedown', close)
  }, [menu])

  const commit = () => {
    setEditing(false)
    if (name.trim() && name.trim() !== t.title) renameThread(t.id, name)
    else setName(t.title)
  }

  return (
    <div ref={ref} className="group relative">
      {editing ? (
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit()
            if (e.key === 'Escape') {
              setName(t.title)
              setEditing(false)
            }
          }}
          className="h-[46px] w-full rounded-lg bg-white px-2.5 text-[13px] text-ink ring-2 ring-accent/40 outline-none"
        />
      ) : (
        <button
          onClick={onOpen}
          onDoubleClick={() => setEditing(true)}
          className={`flex h-[46px] w-full flex-col justify-center rounded-lg pr-8 pl-2.5 text-left transition-colors ${active ? 'bg-black/[0.07]' : 'hover:bg-black/[0.035]'}`}
        >
          <span className={`w-full truncate text-[13px] leading-[18px] ${active ? 'font-medium text-ink' : 'text-ink/85'}`}>{t.title}</span>
          <span className="flex items-center gap-1 text-[11px] leading-4 text-ink-3">
            {busy && <Spinner size={10} className="text-accent" />}
            {busy ? '回复中' : ago(t.updatedAt)}
          </span>
        </button>
      )}
      {!editing && (
        <button
          onClick={() => setMenu((m) => !m)}
          className={`absolute top-1/2 right-1.5 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-md text-ink-3 transition-opacity hover:bg-black/[0.06] hover:text-ink ${
            menu ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
          }`}
          title="更多"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
            <circle cx="5.5" cy="12" r="1.7" />
            <circle cx="12" cy="12" r="1.7" />
            <circle cx="18.5" cy="12" r="1.7" />
          </svg>
        </button>
      )}
      {menu && (
        <div className="absolute top-9 right-0 z-30 w-36 rounded-xl bg-white/95 p-1.5 shadow-[0_0_0_1px_rgba(0,0,0,0.07),0_12px_32px_rgba(0,0,0,0.16)] backdrop-blur-xl">
          <button
            className="flex h-8 w-full items-center rounded-md px-2.5 text-left text-[13px] text-ink hover:bg-accent hover:text-white"
            onClick={() => {
              setMenu(false)
              setEditing(true)
            }}
          >
            重命名
          </button>
          <div className="mx-2 my-1 h-px bg-hairline" />
          <button
            className="flex h-8 w-full items-center rounded-md px-2.5 text-left text-[13px] text-[#D70015] hover:bg-[#FDECEC]"
            onClick={() => {
              setMenu(false)
              onDelete()
            }}
          >
            删除对话…
          </button>
        </div>
      )}
    </div>
  )
}
