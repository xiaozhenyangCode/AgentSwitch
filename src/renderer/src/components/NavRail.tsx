import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { HistoryEntry } from '@shared/types'
import { useApp } from '../state/AppContext'
import { activeThread, deleteThread, importedThreadOf, isThreadBusy, openHistory, renameThread, selectThread, useChat, type Thread } from '../state/chat'
import { useStartThread } from '../state/threads'
import { isReady } from '../lib/ui'
import { BrandMark, KindAvatar, Segmented } from './common'
import { IconEngine, IconFolder, IconGauge, IconGear, IconPlus, IconRefresh, IconSearch, IconTerminal, IconX, Spinner } from './icons'
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
  const { page, navigate, profiles, drawer, openDrawer, closeDrawer, info, confirm, toast, openSettings, settingsOpen } = useApp()
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
    for (const t of [...chat.threads].sort((a, b) => b.updatedAt - a.updatedAt)) {
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

  const [width, onResize, resetWidth] = useSidebarWidth()

  return (
    <nav className="drag relative flex shrink-0 flex-col border-r border-black/[0.06] bg-sidebar/85 backdrop-blur-2xl dark:bg-sidebar/95" style={{ width }}>
      {/* resize handle on the right edge (double-click resets) */}
      <div
        className="no-drag group absolute top-0 -right-px bottom-0 z-20 w-[7px] cursor-col-resize"
        onPointerDown={onResize}
        onDoubleClick={resetWidth}
        title={t('nav.resizeHint')}
      >
        <div className="ml-auto h-full w-px bg-transparent transition-colors duration-150 group-hover:bg-accent/50 group-active:bg-accent" />
      </div>
      {/* traffic-light zone */}
      <div className="h-[52px] shrink-0" />

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
            <div className="flex h-7 items-center gap-1.5 px-2.5 text-[12px] font-medium text-ink-3" title={dir || undefined}>
              <IconFolder size={13} className="shrink-0" />
              <span className="truncate">{dir ? baseName(dir) : t('nav.noProject')}</span>
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
        <div className="flex items-center gap-1">
          <div className="min-w-0 flex-1">
            <NavItem active={settingsOpen} icon={<IconGear size={18} strokeWidth={1.7} />} label={t('nav.settings')} onClick={() => openSettings()} trailing={<span className="text-[11px] text-ink-3/70">⌘,</span>} />
          </div>
          <button
            onClick={() => (drawer.open ? closeDrawer() : openDrawer())}
            className={`no-drag relative flex h-9 w-9 shrink-0 items-center justify-center rounded-lg transition-colors ${
              drawer.open ? 'bg-black/[0.06] text-ink' : 'text-ink-3 hover:bg-black/[0.035] hover:text-ink-2'
            }`}
            title={
              t('nav.debugLog') +
              (info
                ? '\n' +
                  (info.shellEnvSource === 'login' ? t('nav.shellLogin') : info.shellEnvSource === 'cache' ? t('nav.shellCache') : t('nav.shellFallback', { error: info.shellEnvError ?? '' }))
                : '')
            }
          >
            <IconTerminal size={15} />
            {info && <span className={`absolute top-2 right-2 h-1.5 w-1.5 rounded-full ${info.shellEnvSource === 'fallback' ? 'bg-orange' : 'bg-green'}`} />}
          </button>
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

function ThreadRow({ t: th, active, onOpen, onDelete }: { t: Thread; active: boolean; onOpen: () => void; onDelete: () => void }) {
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState(th.title)
  const [menu, setMenu] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const busy = isThreadBusy(th)
  useEffect(() => setName(th.title), [th.title])
  useEffect(() => {
    if (!menu) return
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setMenu(false)
    window.addEventListener('mousedown', close)
    return () => window.removeEventListener('mousedown', close)
  }, [menu])

  const commit = () => {
    setEditing(false)
    if (name.trim() && name.trim() !== th.title) renameThread(th.id, name)
    else setName(th.title)
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
          className={`flex h-[46px] w-full flex-col justify-center rounded-lg pr-8 pl-2.5 text-left transition-colors ${active ? 'bg-black/[0.07]' : 'hover:bg-black/[0.035]'}`}
        >
          <span className={`w-full truncate text-[13px] leading-[18px] ${active ? 'font-medium text-ink' : 'text-ink/85'}`}>{th.title}</span>
          <span className="flex items-center gap-1 text-[11px] leading-4 text-ink-3">
            {busy && <Spinner size={10} className="text-accent" />}
            {busy ? t('nav.replying') : ago(th.updatedAt)}
          </span>
        </button>
      )}
      {!editing && (
        <button
          onClick={() => setMenu((m) => !m)}
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
        <div className="absolute top-9 right-0 z-30 w-36 rounded-xl bg-surface/95 p-1.5 shadow-[0_0_0_1px_var(--ring),0_12px_32px_rgba(0,0,0,0.16)] backdrop-blur-xl">
          <button
            className="flex h-8 w-full items-center rounded-md px-2.5 text-left text-[13px] text-ink hover:bg-accent hover:text-white"
            onClick={() => {
              setMenu(false)
              setEditing(true)
            }}
          >
            {t('common.rename')}
          </button>
          <div className="mx-2 my-1 h-px bg-hairline" />
          <button
            className="flex h-8 w-full items-center rounded-md px-2.5 text-left text-[13px] text-danger hover:bg-danger-soft"
            onClick={() => {
              setMenu(false)
              onDelete()
            }}
          >
            {t('nav.deleteChat')}
          </button>
        </div>
      )}
    </div>
  )
}

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
