import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { HistoryEntry } from '@shared/types'
import { useApp } from '../state/AppContext'
import { activeThread, deleteThread, importedThreadOf, isThreadBusy, openHistory, renameThread, selectThread, useChat, type Thread } from '../state/chat'
import { useStartThread } from '../state/threads'
import { isReady } from '../lib/ui'
import { KindAvatar, Segmented } from './common'
import { UsageSummaryButton } from './Usage'
import { IconEngine, IconFolder, IconPlus, IconRefresh, IconSearch, IconTerminal, IconX, Spinner } from './icons'

const SIDEBAR_KEY = 'agentswitch.sidebar.width'
const SIDEBAR_DEFAULT = 248
const SIDEBAR_MIN = 220
const SIDEBAR_MAX = 420
const clampWidth = (w: number) => Math.round(Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, w)))

/** Drag-to-resize sidebar width, clamped to [220, 420] and remembered across launches. */
function useSidebarWidth(): [number, (e: React.PointerEvent<HTMLDivElement>) => void, () => void] {
  const [width, setWidth] = useState(() => clampWidth(Number(localStorage.getItem(SIDEBAR_KEY)) || SIDEBAR_DEFAULT))
  useEffect(() => localStorage.setItem(SIDEBAR_KEY, String(width)), [width])
  const onResize = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (e.button !== 0) return
      e.preventDefault()
      const el = e.currentTarget
      el.setPointerCapture(e.pointerId)
      const startX = e.clientX
      const startW = width
      const prevCursor = document.body.style.cursor
      document.body.style.cursor = 'col-resize'
      document.body.style.userSelect = 'none'
      const move = (ev: PointerEvent) => setWidth(clampWidth(startW + ev.clientX - startX))
      const up = () => {
        el.removeEventListener('pointermove', move)
        el.removeEventListener('pointerup', up)
        el.removeEventListener('pointercancel', up)
        document.body.style.cursor = prevCursor
        document.body.style.userSelect = ''
      }
      el.addEventListener('pointermove', move)
      el.addEventListener('pointerup', up)
      el.addEventListener('pointercancel', up)
    },
    [width]
  )
  return [width, onResize, () => setWidth(SIDEBAR_DEFAULT)]
}

const baseName = (p: string) => p.split('/').filter(Boolean).pop() ?? p

function ago(ts: number): string {
  const s = (Date.now() - ts) / 1000
  if (s < 60) return '刚刚'
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`
  if (s < 86400 * 7) return `${Math.floor(s / 86400)} 天前`
  return new Date(ts).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })
}

const pad = (n: number) => String(n).padStart(2, '0')
/** today HH:mm · 昨天 HH:mm · MM-DD */
function shortTime(ts: number): string {
  const d = new Date(ts)
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`
  if (ts >= today.getTime()) return hm
  if (ts >= today.getTime() - 86400_000) return `昨天 ${hm}`
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}
const fullTime = (ts: number) => {
  const d = new Date(ts)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

/** Frosted sidebar; the native `vibrancy: 'sidebar'` material shows through the translucent fill. */
export function NavRail() {
  const { page, navigate, profiles, drawer, openDrawer, closeDrawer, info, confirm, toast } = useApp()
  const chat = useChat()
  const start = useStartThread()
  const attention = profiles.filter((p) => p.status === 'uninstalled' || p.status === 'not_logged_in').length
  const current = activeThread(chat)
  const [tab, setTab] = useState<'threads' | 'history'>('threads')
  const [query, setQuery] = useState('')
  const q = query.trim().toLowerCase()

  // group by project; groups ordered by their most recent thread
  const groups = useMemo(() => {
    const map = new Map<string, Thread[]>()
    for (const t of [...chat.threads].sort((a, b) => b.updatedAt - a.updatedAt)) {
      if (t.preview) continue
      if (q && !t.title.toLowerCase().includes(q) && !(t.projectDir ?? '').toLowerCase().includes(q)) continue
      const k = t.projectDir ?? ''
      map.set(k, [...(map.get(k) ?? []), t])
    }
    return [...map.entries()]
  }, [chat.threads, q])

  const remove = async (t: Thread) => {
    let purgeCli = false
    const ok = await confirm({
      title: `删除「${t.title}」？`,
      message: '会删除这条对话及 AgentSwitch 为它保存的运行记录（项目里 .agentswitch 下的附件副本与产物），不会改动你的项目文件。用量统计会保留。',
      confirmLabel: '删除对话',
      destructive: true,
      option: {
        label: '同时删除 CLI 里的原始会话',
        hint: t.imported
          ? '这条对话是从「本机历史」导入的：会把你在终端里的那条原始会话也移到废纸篓，CLI 里将无法再 resume。'
          : '把 Claude / Codex / Gemini CLI 为这条对话保存的会话文件移到废纸篓（可从废纸篓恢复）。',
        onChange: (v) => (purgeCli = v)
      }
    })
    if (!ok) return
    const r = await deleteThread(t.id, purgeCli).catch((e: unknown) => {
      toast({ kind: 'warn', title: '对话已移除，但清理文件失败', desc: e instanceof Error ? e.message : String(e) })
      return null
    })
    if (r?.failed.length) toast({ kind: 'warn', title: `有 ${r.failed.length} 个 CLI 会话文件没能移到废纸篓` })
    else if (r?.trashed.length) toast({ kind: 'success', title: `已删除，CLI 会话文件 ${r.trashed.length} 个已移到废纸篓` })
  }

  const [width, onResize, resetWidth] = useSidebarWidth()

  return (
    <nav className="drag relative flex shrink-0 flex-col border-r border-black/[0.06] bg-[#F3F3F5]/85 backdrop-blur-2xl" style={{ width }}>
      {/* resize handle on the right edge (double-click resets) */}
      <div
        className="no-drag group absolute top-0 -right-px bottom-0 z-20 w-[7px] cursor-col-resize"
        onPointerDown={onResize}
        onDoubleClick={resetWidth}
        title="拖动调整宽度，双击恢复默认"
      >
        <div className="ml-auto h-full w-px bg-transparent transition-colors duration-150 group-hover:bg-accent/50 group-active:bg-accent" />
      </div>
      {/* traffic-light zone */}
      <div className="h-[52px] shrink-0" />

      <div className="flex items-center gap-2.5 px-5 pb-4">
        <div className="flex h-8 w-8 items-center justify-center rounded-[9px] bg-gradient-to-b from-[#3A8DFF] to-[#0066D6] shadow-[inset_0_1px_0_rgba(255,255,255,0.35),0_1px_3px_rgba(0,102,214,0.35)]">
          {/* switch: two opposing routes */}
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M4.5 8h14.5M15.5 4.5 19 8l-3.5 3.5" />
            <path d="M19.5 16H5M8.5 12.5 5 16l3.5 3.5" />
          </svg>
        </div>
        <div className="text-[15px] leading-5 font-semibold tracking-tight text-ink">AgentSwitch</div>
      </div>

      <div className="px-3 pb-3">
        <button
          onClick={() => start(current?.projectDir ?? null)}
          className="no-drag flex h-9 w-full items-center justify-center gap-1.5 rounded-[10px] bg-white text-[14px] font-medium text-ink shadow-[0_0_0_1px_rgba(0,0,0,0.07),0_1px_2px_rgba(0,0,0,0.05)] transition-all hover:bg-[#FAFAFB] active:scale-[0.98]"
        >
          <IconPlus size={16} className="text-accent" /> 新建对话
        </button>
      </div>

      <div className="no-drag space-y-2 px-3 pb-2">
        <Segmented
          size="sm"
          value={tab}
          onChange={(v) => setTab(v as 'threads' | 'history')}
          options={[
            { value: 'threads', label: '对话' },
            { value: 'history', label: '本机历史', title: '各 CLI 在本机留下的会话（只读导入）' }
          ]}
        />
        <div className="flex h-7 items-center gap-1.5 rounded-lg bg-black/[0.04] px-2 text-ink-3 focus-within:bg-white focus-within:ring-1 focus-within:ring-accent/40">
          <IconSearch size={13} className="shrink-0" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === 'Escape' && setQuery('')}
            placeholder={tab === 'threads' ? '搜索对话' : '搜索本机历史'}
            className="min-w-0 flex-1 bg-transparent text-[12.5px] text-ink outline-none placeholder:text-ink-3"
          />
          {query && (
            <button onClick={() => setQuery('')} className="rounded p-0.5 hover:bg-black/[0.06]" title="清除">
              <IconX size={11} />
            </button>
          )}
        </div>
      </div>

      {tab === 'history' ? (
        <HistoryList query={q} />
      ) : (
      <div className="no-drag min-h-0 flex-1 overflow-y-auto px-3 pb-3">
        {groups.length === 0 && <div className="px-3 pt-6 text-center text-[13px] leading-relaxed text-ink-3">{q ? '没有匹配的对话' : '还没有对话'}</div>}
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
      )}

      <div className="border-t border-black/[0.05] px-3 pt-2 pb-4">
        <div className="relative">
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
          <span className="w-14" />
        </button>
        <div className="absolute top-1/2 right-2 -translate-y-1/2">
          <UsageSummaryButton />
        </div>
        </div>
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

// ---- local CLI history ---------------------------------------------------------------------

let historyCache: HistoryEntry[] | null = null

function HistoryList({ query }: { query: string }) {
  const { profiles, byId, navigate, toast } = useApp()
  const chat = useChat()
  const current = activeThread(chat)
  const [items, setItems] = useState<HistoryEntry[] | null>(historyCache)
  const [loading, setLoading] = useState(false)
  const [opening, setOpening] = useState<string | null>(null)

  const load = useCallback(async (force: boolean) => {
    setLoading(true)
    try {
      historyCache = await window.agentswitch.history.list(force)
      setItems(historyCache)
    } catch (e) {
      toast({ kind: 'error', title: '读取本机历史失败', desc: String(e instanceof Error ? e.message : e) })
    } finally {
      setLoading(false)
    }
  }, [toast])
  useEffect(() => {
    void load(false)
  }, [load])

  const groups = useMemo(() => {
    const map = new Map<string, HistoryEntry[]>()
    for (const e of items ?? []) {
      if (!byId(e.profileId)) continue
      if (query && !e.title.toLowerCase().includes(query) && !(e.cwd ?? '').toLowerCase().includes(query)) continue
      const k = e.cwd ?? ''
      map.set(k, [...(map.get(k) ?? []), e])
    }
    return [...map.entries()]
  }, [items, query, byId])

  const open = async (e: HistoryEntry) => {
    const p = byId(e.profileId)
    if (!p || opening) return
    setOpening(e.key)
    try {
      await openHistory(e, { profileId: p.id, name: p.name, kind: p.kind, model: null }, profiles.filter(isReady).map((x) => x.id))
      navigate('workbench')
    } catch (err) {
      toast({ kind: 'error', title: '打开历史失败', desc: String(err instanceof Error ? err.message : err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '') })
    } finally {
      setOpening(null)
    }
  }

  return (
    <div className="no-drag min-h-0 flex-1 overflow-y-auto px-3 pb-3">
      <div className="flex h-6 items-center justify-between px-2.5 text-[11px] text-ink-3">
        <span>{items ? `${items.length} 个会话 · 只读` : '正在扫描…'}</span>
        <button onClick={() => void load(true)} className="flex items-center gap-1 rounded px-1 hover:bg-black/[0.05] hover:text-ink-2" title="重新扫描">
          {loading ? <Spinner size={11} /> : <IconRefresh size={11} />}
        </button>
      </div>
      {items && groups.length === 0 && <div className="px-3 pt-6 text-center text-[13px] text-ink-3">{query ? '没有匹配的历史' : '没有找到本机 CLI 历史'}</div>}
      {groups.map(([dir, list]) => (
        <div key={dir || '_'} className="mb-3">
          <div className="flex h-7 items-center gap-1.5 px-2.5 text-[12px] font-medium text-ink-3" title={dir || '未知项目'}>
            <IconFolder size={13} className="shrink-0" />
            <span className="truncate">{dir ? baseName(dir) : '未知项目'}</span>
          </div>
          {list.map((e) => {
            const p = byId(e.profileId)!
            const linked = importedThreadOf(e.key)
            const active = !!linked && linked.id === current?.id
            return (
              <button
                key={e.key}
                onClick={() => void open(e)}
                title={`${e.title}\n${p.name} · ${fullTime(e.updatedAt)}${e.cwd ? `\n${e.cwd}` : ''}`}
                className={`flex h-[46px] w-full items-center gap-2 rounded-lg px-2.5 text-left transition-colors ${active ? 'bg-black/[0.07]' : 'hover:bg-black/[0.035]'}`}
              >
                <KindAvatar kind={e.kind} size={16} />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className={`truncate text-[13px] leading-[18px] ${active ? 'font-medium text-ink' : 'text-ink/85'}`}>{e.title}</span>
                  <span className="flex items-center gap-1 truncate text-[11px] leading-4 text-ink-3">
                    {opening === e.key && <Spinner size={10} className="text-accent" />}
                    {shortTime(e.updatedAt)} · {p.name}
                    {linked && !linked.preview && <span className="text-accent">· 已继续</span>}
                  </span>
                </span>
              </button>
            )
          })}
        </div>
      ))}
    </div>
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
