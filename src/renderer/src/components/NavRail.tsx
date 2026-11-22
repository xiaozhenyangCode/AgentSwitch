import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { HistoryEntry, ProfileKind } from '@shared/types'
import { useApp } from '../state/AppContext'
import { activeThread, chatMarkdown, clearUnread, deleteThread, importedThreadOf, isThreadBusy, openHistory, renameThread, selectThread, stop, togglePin, useChat, type Thread } from '../state/chat'
import { useEscape } from '../lib/escStack'
import { useStartThread } from '../state/threads'
import { isReady } from '../lib/ui'
import { BrandMark, KindAvatar, Segmented } from './common'
import { IconCheck, IconEngine, IconFolder, IconGauge, IconGear, IconPin, IconPlus, IconRefresh, IconSearch, IconSidebar, IconX, Spinner } from './icons'
import { currentLocale, fmtAgo, t } from '../state/i18n'
import { useSettings } from '../state/settings'
import { useDraft, pickDriver } from '../state/draft'
import { fmtTokens, quotaLevel, tokenSum, useUsage } from '../state/usage'

const SIDEBAR_KEY = 'agentswitch.sidebar.width'
const SIDEBAR_DEFAULT = 248
const SIDEBAR_MIN = 220
const SIDEBAR_MAX = 420
const clampWidth = (w: number) => Math.round(Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, w)))

/** Drag-to-resize sidebar width, clamped to [220, 420] and remembered across launches. */
function useSidebarWidth(): [number, boolean, (e: React.PointerEvent<HTMLDivElement>) => void, () => void] {
  const [width, setWidth] = useState(() => clampWidth(Number(localStorage.getItem(SIDEBAR_KEY)) || SIDEBAR_DEFAULT))
  const [dragging, setDragging] = useState(false)
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
      setDragging(true)
      const move = (ev: PointerEvent) => setWidth(clampWidth(startW + ev.clientX - startX))
      const up = () => {
        el.removeEventListener('pointermove', move)
        el.removeEventListener('pointerup', up)
        el.removeEventListener('pointercancel', up)
        document.body.style.cursor = prevCursor
        document.body.style.userSelect = ''
        setDragging(false)
      }
      el.addEventListener('pointermove', move)
      el.addEventListener('pointerup', up)
      el.addEventListener('pointercancel', up)
    },
    [width]
  )
  return [width, dragging, onResize, () => setWidth(SIDEBAR_DEFAULT)]
}

const baseName = (p: string) => p.split('/').filter(Boolean).pop() ?? p

function ago(ts: number): string {
  if (Date.now() - ts < 86400_000 * 7) return fmtAgo(ts)
  return new Date(ts).toLocaleDateString(currentLocale(), { month: 'numeric', day: 'numeric' })
}

const pad = (n: number) => String(n).padStart(2, '0')
/** today HH:mm · 昨天 HH:mm · MM-DD */
function shortTime(ts: number): string {
  const d = new Date(ts)
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`
  if (ts >= today.getTime()) return hm
  if (ts >= today.getTime() - 86400_000) return t('time.yesterday', { time: hm })
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}
const fullTime = (ts: number) => {
  const d = new Date(ts)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

/** Frosted sidebar; the native `vibrancy: 'sidebar'` material shows through the translucent fill. */
export function NavRail() {
  const { page, navigate, profiles, confirm, toast, openSettings, settingsOpen, sidebarOpen, toggleSidebar } = useApp()
  const chat = useChat()
  const start = useStartThread()
  const attention = profiles.filter((p) => p.status === 'uninstalled' || p.status === 'not_logged_in').length
  const current = activeThread(chat)
  const [tab, setTab] = useState<'threads' | 'history'>('threads')
  const [query, setQuery] = useState('')
  const q = query.trim().toLowerCase()
  const search = useRef<HTMLInputElement>(null)
  // ⌘K (menu bar 显示 › 搜索对话)
  useEffect(() => {
    const focus = () => {
      search.current?.focus()
      search.current?.select()
    }
    window.addEventListener('agentswitch:focus-search', focus)
    return () => window.removeEventListener('agentswitch:focus-search', focus)
  }, [])

  // group by project; groups ordered by their most recent thread
  const groups = useMemo(() => {
    const map = new Map<string, Thread[]>()
    // pinned chats lead their project group (and bring the group up with them)
    for (const t of [...chat.threads].sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || b.updatedAt - a.updatedAt)) {
      if (t.preview) continue
      if (q && !t.title.toLowerCase().includes(q) && !(t.projectDir ?? '').toLowerCase().includes(q)) continue
      const k = t.projectDir ?? ''
      map.set(k, [...(map.get(k) ?? []), t])
    }
    return [...map.entries()]
  }, [chat.threads, q])

  const remove = async (th: Thread) => {
    let purgeCli = false
    const ok = await confirm({
      title: t('del.title', { title: th.title }),
      message: t('del.message'),
      confirmLabel: t('del.confirm'),
      destructive: true,
      option: {
        label: t('del.optionLabel'),
        hint: th.imported ? t('del.hintImported') : t('del.hintOwn'),
        onChange: (v) => (purgeCli = v)
      }
    })
    if (!ok) return
    const r = await deleteThread(th.id, purgeCli).catch((e: unknown) => {
      toast({ kind: 'warn', title: t('del.cleanupFailed'), desc: e instanceof Error ? e.message : String(e) })
      return null
    })
    if (r?.failed.length) toast({ kind: 'warn', title: t('del.trashFailed', { n: r.failed.length }) })
    else if (r?.trashed.length) toast({ kind: 'success', title: t('del.trashed', { n: r.trashed.length }) })
  }

  const [width, dragging, onResize, resetWidth] = useSidebarWidth()

  return (
    <nav
      aria-hidden={!sidebarOpen}
      className={`drag relative shrink-0 overflow-hidden bg-sidebar/85 backdrop-blur-2xl dark:bg-sidebar/95 ${
        dragging ? '' : 'transition-[width,opacity] duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none'
      } ${sidebarOpen ? 'border-r border-black/[0.06] opacity-100' : 'pointer-events-none border-r-0 opacity-0'}`}
      style={{ width: sidebarOpen ? width : 0 }}
    >
      <div className="flex h-full flex-col" style={{ width }}>
      {/* resize handle on the right edge (double-click resets) */}
      <div
        className="no-drag group absolute top-0 -right-px bottom-0 z-20 w-[7px] cursor-col-resize"
        onPointerDown={onResize}
        onDoubleClick={resetWidth}
        title={t('nav.resizeHint')}
      >
        <div className="ml-auto h-full w-px bg-transparent transition-colors duration-150 group-hover:bg-accent/50 group-active:bg-accent" />
      </div>
      {/* traffic-light zone + native macOS sidebar toggle */}
      <div className="flex h-[52px] shrink-0 items-center justify-end pr-3 pl-[84px]">
        <button
          onClick={toggleSidebar}
          className="no-drag flex h-7 w-7 items-center justify-center rounded-lg text-ink-2 transition-colors hover:bg-black/[0.06] hover:text-ink dark:hover:bg-white/[0.08]"
          title={`${t('nav.hideSidebar')} (⌘\\)`}
          aria-label={t('nav.hideSidebar')}
        >
          <IconSidebar size={16} strokeWidth={1.7} />
        </button>
      </div>

      <div className="flex items-center gap-2.5 px-5 pb-4">
        <BrandMark size={32} />
        <div className="text-[15px] leading-5 font-semibold tracking-tight text-ink">AgentSwitch</div>
      </div>

      <div className="px-3 pb-3">
        <button
          onClick={() => start(current?.projectDir ?? null)}
          className="no-drag flex h-9 w-full items-center justify-center gap-1.5 rounded-[10px] bg-surface text-[14px] font-medium text-ink shadow-[0_0_0_1px_var(--ring),0_1px_2px_rgba(0,0,0,0.05)] transition-all hover:bg-surface-2 active:scale-[0.98]"
        >
          <IconPlus size={16} className="text-accent" /> {t('nav.newChat')}
        </button>
      </div>

      <div className="no-drag space-y-2 px-3 pb-2">
        <Segmented
          size="sm"
          value={tab}
          onChange={(v) => setTab(v as 'threads' | 'history')}
          options={[
            { value: 'threads', label: t('nav.tabThreads') },
            { value: 'history', label: t('nav.tabHistory'), title: t('nav.tabHistoryHint') }
          ]}
        />
        <div className="flex h-7 items-center gap-1.5 rounded-lg bg-black/[0.04] px-2 text-ink-3 focus-within:bg-surface focus-within:ring-1 focus-within:ring-accent/40">
          <IconSearch size={13} className="shrink-0" />
          <input
            ref={search}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === 'Escape' && setQuery('')}
            placeholder={tab === 'threads' ? t('nav.searchThreads') : t('nav.searchHistory')}
            className="min-w-0 flex-1 bg-transparent text-[12.5px] text-ink outline-none placeholder:text-ink-3"
          />
          {query && (
            <button onClick={() => setQuery('')} className="rounded p-0.5 hover:bg-black/[0.06]" title={t('common.clear')}>
              <IconX size={11} />
            </button>
          )}
        </div>
      </div>

      {tab === 'history' ? (
        <HistoryList query={q} />
      ) : (
      <div className="no-drag min-h-0 flex-1 overflow-y-auto px-3 pb-3">
        {groups.length === 0 && <div className="px-3 pt-6 text-center text-[13px] leading-relaxed text-ink-3">{q ? t('nav.noMatchThreads') : t('nav.noThreads')}</div>}
        {groups.map(([dir, threads]) => (
          <div key={dir || '_'} className="mb-3">
            <div className="group flex h-7 items-center gap-1.5 pr-1 pl-2.5 text-[12px] font-medium text-ink-3" title={dir || undefined}>
              <IconFolder size={13} className="shrink-0" />
              <span className="min-w-0 flex-1 truncate">{dir ? baseName(dir) : t('nav.noProject')}</span>
              <button
                onClick={() => start(dir || null)}
                className="grid h-5 w-5 shrink-0 place-items-center rounded-md opacity-0 transition-opacity group-hover:opacity-100 hover:bg-black/[0.06] hover:text-ink focus-visible:opacity-100 dark:hover:bg-white/[0.08]"
                title={dir ? t('nav.newInProject', { name: baseName(dir) }) : t('nav.newNoProject')}
              >
                <IconPlus size={13} />
              </button>
            </div>
            {threads.map((th) => (
              <ThreadRow
                key={th.id}
                t={th}
                active={th.id === current?.id}
                onOpen={() => {
                  selectThread(th.id)
                  navigate('workbench')
                }}
                onDelete={() => void remove(th)}
                onNewHere={() => start(th.projectDir ?? null)}
              />
            ))}
          </div>
        ))}
      </div>
      )}

      <div className="border-t border-black/[0.05] px-3 pt-2 pb-4">
        <NavItem
          active={page === 'usage'}
          icon={<IconGauge size={18} />}
          label={t('nav.usage')}
          onClick={() => navigate('usage')}
          trailing={<UsageSummary />}
        />
        <NavItem
          active={page === 'engines'}
          icon={<IconEngine size={18} />}
          label={t('nav.engines')}
          onClick={() => navigate('engines')}
          trailing={
            attention > 0 && (
              <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-orange px-1.5 text-[12px] font-semibold text-white" title={t('nav.notReady', { n: attention })}>
                {attention}
              </span>
            )
          }
        />
        <NavItem active={settingsOpen} icon={<IconGear size={18} strokeWidth={1.7} />} label={t('nav.settings')} onClick={() => openSettings()} trailing={<span className="text-[11px] text-ink-3/70">⌘,</span>} />
      </div>
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
      toast({ kind: 'error', title: t('hist.loadFailed'), desc: String(e instanceof Error ? e.message : e) })
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
      toast({ kind: 'error', title: t('hist.openFailed'), desc: String(err instanceof Error ? err.message : err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '') })
    } finally {
      setOpening(null)
    }
  }

  return (
    <div className="no-drag min-h-0 flex-1 overflow-y-auto px-3 pb-3">
      <div className="flex h-6 items-center justify-between px-2.5 text-[11px] text-ink-3">
        <span>{items ? t('hist.count', { n: items.length }) : t('hist.scanning')}</span>
        <button onClick={() => void load(true)} className="flex items-center gap-1 rounded px-1 hover:bg-black/[0.05] hover:text-ink-2" title={t('hist.rescan')}>
          {loading ? <Spinner size={11} /> : <IconRefresh size={11} />}
        </button>
      </div>
      {items && groups.length === 0 && <div className="px-3 pt-6 text-center text-[13px] text-ink-3">{query ? t('hist.noMatch') : t('hist.none')}</div>}
      {groups.map(([dir, list]) => (
        <div key={dir || '_'} className="mb-3">
          <div className="flex h-7 items-center gap-1.5 px-2.5 text-[12px] font-medium text-ink-3" title={dir || t('hist.unknownProject')}>
            <IconFolder size={13} className="shrink-0" />
            <span className="truncate">{dir ? baseName(dir) : t('hist.unknownProject')}</span>
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
                    {linked && !linked.preview && <span className="text-accent">{t('hist.continued')}</span>}
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

function ThreadRow({ t: th, active, onOpen, onDelete, onNewHere }: { t: Thread; active: boolean; onOpen: () => void; onDelete: () => void; onNewHere: () => void }) {
  const { byId, toast } = useApp()
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState(th.title)
  /** Open menu: under the ··· button, or at the cursor for a right-click. */
  const [menu, setMenu] = useState<MenuAt | null>(null)
  const more = useRef<HTMLButtonElement>(null)
  const closeMenu = useCallback(() => setMenu(null), [])
  const busy = isThreadBusy(th)
  const kind: ProfileKind | null =
    (th.driver.profileId ? byId(th.driver.profileId)?.kind : undefined) ??
    th.imported?.kind ??
    [...th.messages].reverse().find((m) => m.role === 'assistant')?.agent.kind ??
    null
  useEffect(() => setName(th.title), [th.title])

  const commit = () => {
    setEditing(false)
    if (name.trim() && name.trim() !== th.title) renameThread(th.id, name)
    else setName(th.title)
  }

  return (
    <div
      className="group relative"
      onContextMenu={(e) => {
        if (editing) return
        e.preventDefault()
        setMenu({ x: e.clientX, y: e.clientY })
      }}
    >
      {editing ? (
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit()
            if (e.key === 'Escape') {
              setName(th.title)
              setEditing(false)
            }
          }}
          className="h-[46px] w-full rounded-lg bg-surface px-2.5 text-[13px] text-ink ring-2 ring-accent/40 outline-none"
        />
      ) : (
        <button
          onClick={onOpen}
          onDoubleClick={() => setEditing(true)}
          className={`flex h-[46px] w-full items-center gap-2 rounded-lg pr-8 pl-2.5 text-left transition-colors ${
            active
              ? 'bg-black/[0.07]'
              : th.unread === 'done'
                ? 'bg-ok-soft/45 hover:bg-ok-soft/70'
                : th.unread === 'error'
                  ? 'bg-danger-soft/45 hover:bg-danger-soft/70'
                  : th.unread === 'paused'
                    ? 'bg-warn-soft/45 hover:bg-warn-soft/70'
                    : 'hover:bg-black/[0.035]'
          }`}
        >
          {kind && <KindAvatar kind={kind} size={16} />}
          <span className="flex min-w-0 flex-1 flex-col">
            <span className={`flex items-center gap-1 text-[13px] leading-[18px] ${active || th.unread ? 'font-medium text-ink' : 'text-ink/85'}`}>
              {th.pinned && <IconPin size={11} className="shrink-0 text-ink-3" aria-label={t('nav.pinned')} />}
              <span className="truncate">{th.title}</span>
            </span>
            <span className="flex items-center gap-1 text-[11px] leading-4 text-ink-3">
              {busy ? (
                <>
                  <Spinner size={10} className="text-accent" />
                  {t('nav.replying')}
                </>
              ) : th.unread === 'done' ? (
                <>
                  <IconCheck size={10} className="shrink-0 text-ok" />
                  <span className="font-medium text-ok">{t('nav.done')}</span>
                  <span>· {ago(th.updatedAt)}</span>
                </>
              ) : th.unread === 'error' ? (
                <>
                  <span className="font-medium text-danger">{t('nav.failed')}</span>
                  <span>· {ago(th.updatedAt)}</span>
                </>
              ) : th.unread === 'paused' ? (
                <>
                  <span className="font-medium text-warn">{t('nav.paused')}</span>
                  <span>· {ago(th.updatedAt)}</span>
                </>
              ) : (
                ago(th.updatedAt)
              )}
            </span>
          </span>
        </button>
      )}
      {!editing && !busy && th.unread && (
        <span
          className={`pointer-events-none absolute top-1/2 right-3 h-2 w-2 -translate-y-1/2 rounded-full transition-opacity group-hover:opacity-0 ${menu ? 'opacity-0' : 'opacity-100'} ${
            th.unread === 'done' ? 'bg-green' : th.unread === 'error' ? 'bg-red' : 'bg-orange'
          }`}
        />
      )}
      {!editing && (
        <button
          ref={more}
          // keep the outside-click handler from closing the menu this click toggles
          onMouseDown={(e) => e.stopPropagation()}
          onClick={() => {
            if (menu) return setMenu(null)
            const r = more.current!.getBoundingClientRect()
            setMenu({ x: r.right, y: r.bottom + 4, alignRight: true, flipY: r.top - 4 })
          }}
          className={`absolute top-1/2 right-1.5 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-md text-ink-3 transition-opacity hover:bg-black/[0.06] hover:text-ink ${
            menu ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
          }`}
          title={t('common.more')}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
            <circle cx="5.5" cy="12" r="1.7" />
            <circle cx="12" cy="12" r="1.7" />
            <circle cx="18.5" cy="12" r="1.7" />
          </svg>
        </button>
      )}
      {menu && (
        <RowMenu at={menu} onClose={closeMenu}>
          <MenuItem onClick={() => setEditing(true)}>{t('common.rename')}</MenuItem>
          <MenuItem onClick={() => togglePin(th.id)}>{th.pinned ? t('nav.unpin') : t('nav.pin')}</MenuItem>
          {th.unread && <MenuItem onClick={() => clearUnread(th.id)}>{t('nav.markRead')}</MenuItem>}
          <MenuItem
            onClick={() => {
              void window.agentswitch.sys.copy(chatMarkdown(th))
              toast({ kind: 'success', title: t('nav.copiedChat') })
            }}
          >
            {t('nav.copyChat')}
          </MenuItem>
          <MenuSep />
          <MenuItem onClick={onNewHere}>{th.projectDir ? t('nav.newInProject', { name: baseName(th.projectDir) }) : t('nav.newNoProject')}</MenuItem>
          {th.projectDir && (
            <>
              <MenuItem onClick={() => void window.agentswitch.sys.showInFolder(th.projectDir!)}>{t('common.showInFinder')}</MenuItem>
              <MenuItem
                onClick={() => {
                  void window.agentswitch.sys.copy(th.projectDir!)
                  toast({ kind: 'success', title: t('common.copied') })
                }}
              >
                {t('proj.copyPath')}
              </MenuItem>
            </>
          )}
          {busy && (
            <>
              <MenuSep />
              <MenuItem onClick={() => stop(th.id)}>{t('nav.stopReply')}</MenuItem>
            </>
          )}
          <MenuSep />
          <MenuItem danger onClick={onDelete}>
            {t('nav.deleteChat')}
          </MenuItem>
        </RowMenu>
      )}
    </div>
  )
}

type MenuAt = { x: number; y: number; alignRight?: boolean; flipY?: number }
/** Closes the open row menu (an item was chosen). */
const MenuClose = createContext<() => void>(() => {})

/**
 * A chat row's menu, in a portal at a fixed position (the sidebar clips and scrolls, and its
 * backdrop-filter would trap a fixed child). Kept inside the window; flips above the ··· button
 * when there is no room below. Closes on outside click, Esc, scroll, resize or window blur.
 */
function RowMenu({ at, onClose, children }: { at: MenuAt; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)
  useEscape(onClose)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const m = 8
    const w = el.offsetWidth
    const h = el.offsetHeight
    let left = at.alignRight ? at.x - w : at.x
    let top = at.y
    if (top + h > window.innerHeight - m) top = at.flipY !== undefined ? at.flipY - h : at.y - h
    left = Math.min(Math.max(m, left), window.innerWidth - w - m)
    top = Math.min(Math.max(m, top), window.innerHeight - h - m)
    setPos({ left, top })
  }, [at])
  useEffect(() => {
    const down = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && onClose()
    const off = () => onClose()
    window.addEventListener('mousedown', down)
    window.addEventListener('resize', off)
    window.addEventListener('blur', off)
    document.addEventListener('scroll', off, true)
    return () => {
      window.removeEventListener('mousedown', down)
      window.removeEventListener('resize', off)
      window.removeEventListener('blur', off)
      document.removeEventListener('scroll', off, true)
    }
  }, [onClose])
  return createPortal(
    <div
      ref={ref}
      role="menu"
      onContextMenu={(e) => e.preventDefault()}
      style={{ position: 'fixed', left: pos?.left ?? at.x, top: pos?.top ?? at.y, visibility: pos ? 'visible' : 'hidden' }}
      className="no-drag z-50 w-56 rounded-xl bg-surface/95 p-1.5 shadow-[0_0_0_1px_var(--ring),0_12px_32px_rgba(0,0,0,0.16)] backdrop-blur-xl"
    >
      <MenuClose.Provider value={onClose}>{children}</MenuClose.Provider>
    </div>,
    document.body
  )
}

function MenuItem({ onClick, danger = false, children }: { onClick: () => void; danger?: boolean; children: ReactNode }) {
  const close = useContext(MenuClose)
  return (
    <button
      role="menuitem"
      className={`flex h-8 w-full items-center rounded-md px-2.5 text-left text-[13px] ${danger ? 'text-danger hover:bg-danger-soft' : 'text-ink hover:bg-accent hover:text-white'}`}
      onClick={() => {
        close()
        onClick()
      }}
    >
      <span className="min-w-0 flex-1 truncate">{children}</span>
    </button>
  )
}

const MenuSep = () => <div className="mx-2 my-1 h-px bg-hairline" />

function NavItem({ active, icon, label, onClick, trailing }: { active: boolean; icon: React.ReactNode; label: string; onClick: () => void; trailing?: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`no-drag mt-0.5 flex h-9 w-full items-center gap-3 rounded-lg px-3 text-[14px] font-medium transition-colors ${
        active ? 'bg-black/[0.06] text-ink' : 'text-ink/80 hover:bg-black/[0.035]'
      }`}
    >
      <span className={active ? 'text-accent' : 'text-ink-2'}>{icon}</span>
      <span className="min-w-0 flex-1 truncate text-left">{label}</span>
      {trailing}
    </button>
  )
}

/** "今日 61M" beside 用量限额, plus a dot when the current driver is near its limit. */
function UsageSummary() {
  const { profiles } = useApp()
  const snap = useUsage()
  const chat = useChat()
  const draft = useDraft()
  useSettings()
  const today = snap ? Object.values(snap.accounts).reduce((a, u) => a + tokenSum(u.today), 0) : 0
  const ctx = activeThread(chat) ?? draft
  const sorted = [...profiles].sort((a, b) => Number(isReady(b)) - Number(isReady(a)))
  const participants = ctx.participants.length ? ctx.participants : sorted.filter(isReady).map((p) => p.id)
  const driver = pickDriver(ctx, sorted, participants)
  const model = ctx.driver.profileId === driver?.id ? ctx.driver.model : null
  const { level, reason } = quotaLevel(driver, driver ? snap?.accounts[driver.id] : undefined, model)
  return (
    <span className="flex items-center gap-1.5 text-[11px] font-normal text-ink-3 tabular-nums">
      {level !== 'ok' && driver && <span className={`h-1.5 w-1.5 rounded-full ${level === 'danger' ? 'bg-red' : 'bg-orange'}`} title={`${driver.name}: ${reason}`} />}
      {t('usage.today', { n: fmtTokens(today) })}
    </span>
  )
}
