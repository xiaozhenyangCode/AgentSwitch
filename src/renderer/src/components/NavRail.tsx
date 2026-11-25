import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { HistoryEntry, HistoryThread, ProfileKind } from '@shared/types'
import { useApp } from '../state/AppContext'
import { activeThread, archiveThread, chatMarkdown, clearUnread, deleteThread, importedThreadOf, isThreadBusy, openHistory, renameThread, selectThread, stop, togglePin, unarchiveThread, useChat, type Thread } from '../state/chat'
import { useEscape } from '../lib/escStack'
import { formatFullLocalTime, formatListTime } from '../lib/listTime'
import { getSidebarGroups, loadCollapsedProjects, saveCollapsedProjects } from '../lib/sidebarGroups'
import { useStartThread } from '../state/threads'
import { isReady } from '../lib/ui'
import { BrandMark, KindAvatar, Segmented } from './common'
import { IconArchive, IconCheck, IconChevronDown, IconEngine, IconFolder, IconGauge, IconGear, IconPin, IconPlus, IconRefresh, IconSearch, IconSidebar, IconX, Spinner } from './icons'
import { t } from '../state/i18n'
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

const listTime = (ts: number) => formatListTime(ts, new Date(), (hm) => t('time.yesterday', { time: hm }))

function ListTime({ ts }: { ts: number }) {
  const title = formatFullLocalTime(ts)
  if (!title) return null

  return <time className="tabular-nums" dateTime={new Date(ts).toISOString()} title={title}>{listTime(ts)}</time>
}

/** Frosted sidebar; the native `vibrancy: 'sidebar'` material shows through the translucent fill. */
export function NavRail({ chatsAvailable }: { chatsAvailable: boolean }) {
  const { info, page, navigate, profiles, confirm, toast, openSettings, settingsOpen, sidebarOpen, toggleSidebar } = useApp()
  const version = info?.version ? `v${info.version.replace(/^v/i, '')}` : null
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

  const [archivedOpen, setArchivedOpen] = useState(false)
  const [expandedProjects, setExpandedProjects] = useState(() => new Set<string>())
  const [collapsedProjects, setCollapsedProjects] = useState(loadCollapsedProjects)

  const { groups, archivedThreads } = useMemo(
    () => getSidebarGroups(chat.threads, { activeThreadId: chat.activeId, expandedProjects, collapsedProjects, query: q }),
    [chat.threads, chat.activeId, expandedProjects, collapsedProjects, q]
  )
  const showArchived = archivedOpen || (!!q && archivedThreads.length > 0) || !!current?.archived

  const setProjectCollapsed = (dir: string, collapsed: boolean) => {
    const next = new Set(collapsedProjects)
    if (collapsed) next.add(dir)
    else next.delete(dir)
    setCollapsedProjects(next)
    saveCollapsedProjects(next)
  }

  const toggleProjectMore = (dir: string) => {
    setExpandedProjects((projects) => {
      const next = new Set(projects)
      if (next.has(dir)) next.delete(dir)
      else next.add(dir)
      return next
    })
  }

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
        <div className="grid min-w-0 flex-1 grid-cols-[auto_minmax(0,1fr)] items-baseline gap-1.5">
          <span className="text-[15px] leading-5 font-semibold tracking-tight text-ink">AgentSwitch</span>
          {version && <span className="truncate text-[12px] leading-5 text-ink-2 tabular-nums" title={version}>{version}</span>}
        </div>
      </div>

      <div className="px-3 pb-3" hidden={!chatsAvailable}>
        <button
          onClick={() => start(current?.projectDir ?? null)}
          className="no-drag flex h-9 w-full items-center justify-center gap-1.5 rounded-[10px] bg-surface text-[14px] font-medium text-ink shadow-[0_0_0_1px_var(--ring),0_1px_2px_rgba(0,0,0,0.05)] transition-all hover:bg-surface-2 active:scale-[0.98]"
        >
          <IconPlus size={16} className="text-accent" /> {t('nav.newChat')}
        </button>
      </div>

      <div className="no-drag space-y-2 px-3 pb-2" hidden={!chatsAvailable}>
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

      {!chatsAvailable ? <div className="flex-1" /> : tab === 'history' ? (
        <HistoryList query={q} />
      ) : (
      <div className="no-drag min-h-0 flex-1 overflow-y-auto px-3 pb-3">
        {groups.length === 0 && archivedThreads.length === 0 && (
          <div className="px-3 pt-6 text-center text-[13px] leading-relaxed text-ink-3">{q ? t('nav.noMatchThreads') : t('nav.noThreads')}</div>
        )}
        {groups.map(({ dir, collapsed, expanded, extraThreadCount, visibleThreads }) => (
          <div key={dir} className="mb-3.5">
            <div className="group flex h-8 items-center gap-1 pr-1">
              <button
                type="button"
                aria-expanded={!collapsed}
                disabled={!!q}
                onClick={() => setProjectCollapsed(dir, !collapsed)}
                className="flex h-full min-w-0 flex-1 items-center gap-2 rounded-lg pr-1 pl-2.5 text-left text-[13.5px] font-semibold text-ink-2 transition-colors enabled:hover:bg-black/[0.04] dark:enabled:hover:bg-white/[0.05]"
                title={dir || undefined}
              >
                <IconFolder size={15} aria-hidden="true" className="shrink-0 text-ink-3" />
                <span className="min-w-0 flex-1 truncate">{dir ? baseName(dir) : t('nav.noProject')}</span>
                <IconChevronDown size={13} aria-hidden="true" className={`shrink-0 text-ink-3 transition-transform duration-150 motion-reduce:transition-none ${collapsed ? '-rotate-90' : ''}`} />
              </button>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation()
                  if (collapsed) setProjectCollapsed(dir, false)
                  start(dir || null)
                }}
                className="grid h-6 w-6 shrink-0 place-items-center rounded-md text-ink-3 opacity-0 transition-opacity group-hover:opacity-100 hover:bg-black/[0.06] hover:text-ink focus-visible:opacity-100 dark:hover:bg-white/[0.08]"
                title={dir ? t('nav.newInProject', { name: baseName(dir) }) : t('nav.newNoProject')}
              >
                <IconPlus size={14} />
              </button>
            </div>
            {visibleThreads.map((th) => (
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
            {extraThreadCount > 0 && (
              <button
                type="button"
                aria-expanded={expanded}
                onClick={() => toggleProjectMore(dir)}
                className="flex h-7 w-full items-center rounded-lg pr-2.5 pl-8 text-left text-[12px] text-ink-3 transition-colors hover:bg-black/[0.04] hover:text-ink-2 dark:hover:bg-white/[0.05]"
              >
                {expanded ? t('common.collapse') : t('nav.showMoreThreads', { n: extraThreadCount })}
              </button>
            )}
          </div>
        ))}
        {archivedThreads.length > 0 && (
          <div className="mt-2 border-t border-black/[0.05] pt-2 dark:border-white/[0.06]">
            <button
              onClick={() => setArchivedOpen((o) => !o)}
              className="flex h-8 w-full items-center gap-2 rounded-lg px-2.5 text-left text-[12.5px] font-medium text-ink-3 transition-colors hover:bg-black/[0.04] hover:text-ink-2 dark:hover:bg-white/[0.05]"
            >
              <IconArchive size={14} className="shrink-0" />
              <span className="min-w-0 flex-1 truncate">{t('nav.archivedGroup', { n: archivedThreads.length })}</span>
              <IconChevronDown size={13} className={`shrink-0 transition-transform duration-150 ${showArchived ? '' : '-rotate-90'}`} />
            </button>
            {showArchived && (
              <div className="mt-0.5 space-y-0.5 opacity-85">
                {archivedThreads.map((th) => (
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
            )}
          </div>
        )}
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

/** The user's own name / pin for a history row (the CLI's files stay read-only). */
type HistoryMeta = Record<string, { title?: string; pinned?: boolean }>
const HISTORY_META_KEY = 'agentswitch.history.meta'
function loadHistoryMeta(): HistoryMeta {
  try {
    const j = JSON.parse(localStorage.getItem(HISTORY_META_KEY) ?? '{}')
    return j && typeof j === 'object' ? j : {}
  } catch {
    return {}
  }
}

/** A CLI session as Markdown, like 复制对话内容 on a chat. */
function historyMarkdown(title: string, h: HistoryThread, agentName: string): string {
  const out = [`# ${title}`]
  for (const m of h.messages) {
    const body = m.text.trim()
    if (!body) continue
    if (m.role === 'user') out.push('', `## ${t('chat.mdYou')}`, '', body)
    else out.push('', `## ${agentName}${m.model ? ` · ${m.model}` : ''}`, '', body)
  }
  return out.join('\n').trim() + '\n'
}

const errText = (err: unknown) => String(err instanceof Error ? err.message : err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

function HistoryList({ query }: { query: string }) {
  const { profiles, byId, navigate, toast, confirm } = useApp()
  const chat = useChat()
  const start = useStartThread()
  const current = activeThread(chat)
  const [items, setItems] = useState<HistoryEntry[] | null>(historyCache)
  const [loading, setLoading] = useState(false)
  const [opening, setOpening] = useState<string | null>(null)
  const [meta, setMeta] = useState<HistoryMeta>(loadHistoryMeta)
  const patchMeta = (key: string, patch: { title?: string; pinned?: boolean }) =>
    setMeta((m) => {
      const v = { ...m[key], ...patch }
      if (!v.title) delete v.title
      if (!v.pinned) delete v.pinned
      const next = { ...m }
      if (Object.keys(v).length) next[key] = v
      else delete next[key]
      localStorage.setItem(HISTORY_META_KEY, JSON.stringify(next))
      return next
    })

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

  const titleOf = (e: HistoryEntry) => meta[e.key]?.title ?? e.title

  const groups = useMemo(() => {
    const map = new Map<string, HistoryEntry[]>()
    // pinned sessions lead their project group (and bring the group up with them)
    const sorted = [...(items ?? [])].sort((a, b) => Number(!!meta[b.key]?.pinned) - Number(!!meta[a.key]?.pinned))
    for (const e of sorted) {
      if (!byId(e.profileId)) continue
      const title = meta[e.key]?.title ?? e.title
      if (query && !title.toLowerCase().includes(query) && !e.title.toLowerCase().includes(query) && !(e.cwd ?? '').toLowerCase().includes(query)) continue
      const k = e.cwd ?? ''
      map.set(k, [...(map.get(k) ?? []), e])
    }
    return [...map.entries()]
  }, [items, query, byId, meta])

  const open = async (e: HistoryEntry) => {
    const p = byId(e.profileId)
    if (!p || opening) return
    setOpening(e.key)
    try {
      const fresh = !importedThreadOf(e.key)
      const id = await openHistory(e, { profileId: p.id, name: p.name, kind: p.kind, model: null }, profiles.filter(isReady).map((x) => x.id))
      const alias = meta[e.key]?.title
      if (fresh && alias) renameThread(id, alias)
      navigate('workbench')
    } catch (err) {
      toast({ kind: 'error', title: t('hist.openFailed'), desc: errText(err) })
    } finally {
      setOpening(null)
    }
  }

  const rename = (e: HistoryEntry, title: string) => {
    const name = title.trim()
    if (!name || name === titleOf(e)) return
    patchMeta(e.key, { title: name === e.title ? undefined : name })
    const linked = importedThreadOf(e.key)
    if (linked) renameThread(linked.id, name)
  }

  const copyChat = async (e: HistoryEntry) => {
    try {
      const h = await window.agentswitch.history.open(e.key)
      await window.agentswitch.sys.copy(historyMarkdown(titleOf(e), h, byId(e.profileId)?.name ?? e.kind))
      toast({ kind: 'success', title: t('nav.copiedChat') })
    } catch (err) {
      toast({ kind: 'error', title: t('hist.openFailed'), desc: errText(err) })
    }
  }

  const remove = async (e: HistoryEntry) => {
    const linked = importedThreadOf(e.key)
    const ok = await confirm({
      title: t('del.title', { title: titleOf(e) }),
      message: t('hist.delMessage') + (linked && !linked.preview ? ' ' + t('hist.delLinked') : ''),
      confirmLabel: t('hist.delConfirm'),
      destructive: true
    })
    if (!ok) return
    try {
      const r = await window.agentswitch.history.trash(e.key)
      if (r.failed.length) return toast({ kind: 'warn', title: t('del.trashFailed', { n: r.failed.length }) })
      if (linked) await deleteThread(linked.id, false)
      patchMeta(e.key, { title: undefined, pinned: undefined })
      historyCache = (historyCache ?? []).filter((x) => x.key !== e.key)
      setItems(historyCache)
      toast({ kind: 'success', title: r.trashed.length ? t('del.trashed', { n: r.trashed.length }) : t('hist.removed') })
    } catch (err) {
      toast({ kind: 'error', title: t('hist.delFailed'), desc: errText(err) })
    }
  }

  return (
    <div className="no-drag min-h-0 flex-1 overflow-y-auto px-3 pb-3">
      <div className="flex h-7 items-center justify-between px-2.5 text-[12px] text-ink-3">
        <span>{items ? t('hist.count', { n: items.length }) : t('hist.scanning')}</span>
        <button onClick={() => void load(true)} className="flex items-center gap-1 rounded px-1 hover:bg-black/[0.05] hover:text-ink-2" title={t('hist.rescan')}>
          {loading ? <Spinner size={12} /> : <IconRefresh size={12} />}
        </button>
      </div>
      {items && groups.length === 0 && <div className="px-3 pt-6 text-center text-[13.5px] text-ink-3">{query ? t('hist.noMatch') : t('hist.none')}</div>}
      {groups.map(([dir, list]) => (
        <div key={dir || '_'} className="mb-3.5">
          <div className="group flex h-8 items-center gap-2 pr-1 pl-2.5 text-[13.5px] font-semibold text-ink-2" title={dir || t('hist.unknownProject')}>
            <IconFolder size={15} className="shrink-0 text-ink-3" />
            <span className="min-w-0 flex-1 truncate">{dir ? baseName(dir) : t('hist.unknownProject')}</span>
            {dir && (
              <button
                onClick={() => start(dir)}
                className="grid h-6 w-6 shrink-0 place-items-center rounded-md text-ink-3 opacity-0 transition-opacity group-hover:opacity-100 hover:bg-black/[0.06] hover:text-ink focus-visible:opacity-100 dark:hover:bg-white/[0.08]"
                title={t('nav.newInProject', { name: baseName(dir) })}
              >
                <IconPlus size={14} />
              </button>
            )}
          </div>
          {list.map((e) => {
            const linked = importedThreadOf(e.key)
            return (
              <HistoryRow
                key={e.key}
                e={e}
                title={titleOf(e)}
                pinned={!!meta[e.key]?.pinned}
                active={!!linked && linked.id === current?.id}
                opening={opening === e.key}
                onOpen={() => void open(e)}
                onRename={(name) => rename(e, name)}
                onPin={() => patchMeta(e.key, { pinned: !meta[e.key]?.pinned })}
                onCopyChat={() => void copyChat(e)}
                onNewHere={() => start(e.cwd)}
                onDelete={() => void remove(e)}
              />
            )
          })}
        </div>
      ))}
    </div>
  )
}

function HistoryRow(props: {
  e: HistoryEntry
  title: string
  pinned: boolean
  active: boolean
  opening: boolean
  onOpen: () => void
  onRename: (name: string) => void
  onPin: () => void
  onCopyChat: () => void
  onNewHere: () => void
  onDelete: () => void
}) {
  const { e, title, pinned, active, opening } = props
  const { byId, toast } = useApp()
  const p = byId(e.profileId)!
  const linked = importedThreadOf(e.key)
  const busy = !!linked && isThreadBusy(linked)
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState(title)
  const [menu, setMenu] = useState<MenuAt | null>(null)
  const closeMenu = useCallback(() => setMenu(null), [])
  useEffect(() => setName(title), [title])
  const commit = () => {
    setEditing(false)
    if (name.trim() && name.trim() !== title) props.onRename(name)
    else setName(title)
  }
  const copy = (text: string) => {
    void window.agentswitch.sys.copy(text)
    toast({ kind: 'success', title: t('common.copied') })
  }

  return (
    <div
      className="group relative"
      onContextMenu={(ev) => {
        if (editing) return
        ev.preventDefault()
        setMenu({ x: ev.clientX, y: ev.clientY })
      }}
    >
      {editing ? (
        <input
          autoFocus
          value={name}
          onChange={(ev) => setName(ev.target.value)}
          onBlur={commit}
          onKeyDown={(ev) => {
            if (ev.key === 'Enter') commit()
            if (ev.key === 'Escape') {
              setName(title)
              setEditing(false)
            }
          }}
          className="h-[50px] w-full rounded-lg bg-surface px-2.5 text-[14px] text-ink ring-2 ring-accent/40 outline-none"
        />
      ) : (
        <button
          onClick={props.onOpen}
          onDoubleClick={() => setEditing(true)}
          title={`${title}\n${p.name} · ${formatFullLocalTime(e.updatedAt)}${e.cwd ? `\n${e.cwd}` : ''}`}
          className={`flex h-[50px] w-full items-center gap-2.5 rounded-lg pr-8 pl-2.5 text-left transition-colors ${active ? 'bg-black/[0.07]' : 'hover:bg-black/[0.035]'}`}
        >
          <KindAvatar kind={e.kind} size={18} />
          <span className="flex min-w-0 flex-1 flex-col">
            <span className={`flex items-center gap-1 text-[14px] leading-[20px] ${active ? 'font-medium text-ink' : 'text-ink/85'}`}>
              {pinned && <IconPin size={12} className="shrink-0 text-ink-3" aria-label={t('nav.pinned')} />}
              <span className="truncate">{title}</span>
            </span>
            <span className="flex items-center gap-1 truncate text-[12px] leading-[17px] text-ink-3">
              {(opening || busy) && <Spinner size={11} className="text-accent" />}
              <span className="min-w-0 truncate"><ListTime ts={e.updatedAt} /> · {p.name}</span>
              {linked && !linked.preview && <span className="text-accent">{t('hist.continued')}</span>}
            </span>
          </span>
        </button>
      )}
      {!editing && <MoreButton open={!!menu} onToggle={(at) => setMenu(at)} />}
      {menu && (
        <RowMenu at={menu} onClose={closeMenu}>
          <MenuItem onClick={props.onOpen}>{t('hist.open')}</MenuItem>
          <MenuItem onClick={() => setEditing(true)}>{t('common.rename')}</MenuItem>
          <MenuItem onClick={props.onPin}>{pinned ? t('nav.unpin') : t('nav.pin')}</MenuItem>
          <MenuItem onClick={props.onCopyChat}>{t('nav.copyChat')}</MenuItem>
          <MenuItem onClick={() => copy(e.nativeId)}>{t('hist.copyId')}</MenuItem>
          <MenuSep />
          <MenuItem onClick={props.onNewHere}>{e.cwd ? t('nav.newInProject', { name: baseName(e.cwd) }) : t('nav.newNoProject')}</MenuItem>
          {e.cwd && (
            <>
              <MenuItem onClick={() => void window.agentswitch.sys.showInFolder(e.cwd!)}>{t('common.showInFinder')}</MenuItem>
              <MenuItem onClick={() => copy(e.cwd!)}>{t('proj.copyPath')}</MenuItem>
            </>
          )}
          {busy && (
            <>
              <MenuSep />
              <MenuItem onClick={() => stop(linked!.id)}>{t('nav.stopReply')}</MenuItem>
            </>
          )}
          <MenuSep />
          <MenuItem danger onClick={props.onDelete}>
            {t('nav.deleteChat')}
          </MenuItem>
        </RowMenu>
      )}
    </div>
  )
}

/** The ··· on a sidebar row: opens its menu under the button (a second click closes it). */
function MoreButton({ open, onToggle }: { open: boolean; onToggle: (at: MenuAt | null) => void }) {
  const ref = useRef<HTMLButtonElement>(null)
  return (
    <button
      ref={ref}
      // keep the outside-click handler from closing the menu this click toggles
      onMouseDown={(e) => e.stopPropagation()}
      onClick={() => {
        if (open) return onToggle(null)
        const r = ref.current!.getBoundingClientRect()
        onToggle({ x: r.right, y: r.bottom + 4, alignRight: true, flipY: r.top - 4 })
      }}
      className={`absolute top-1/2 right-1.5 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-md text-ink-3 transition-opacity hover:bg-black/[0.06] hover:text-ink ${
        open ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
      }`}
      title={t('common.more')}
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
        <circle cx="5.5" cy="12" r="1.7" />
        <circle cx="12" cy="12" r="1.7" />
        <circle cx="18.5" cy="12" r="1.7" />
      </svg>
    </button>
  )
}

function ThreadRow({ t: th, active, onOpen, onDelete, onNewHere }: { t: Thread; active: boolean; onOpen: () => void; onDelete: () => void; onNewHere: () => void }) {
  const { byId, toast } = useApp()
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState(th.title)
  /** Open menu: under the ··· button, or at the cursor for a right-click. */
  const [menu, setMenu] = useState<MenuAt | null>(null)
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
          className="h-[50px] w-full rounded-lg bg-surface px-2.5 text-[14px] text-ink ring-2 ring-accent/40 outline-none"
        />
      ) : (
        <button
          onClick={onOpen}
          onDoubleClick={() => setEditing(true)}
          className={`flex h-[50px] w-full items-center gap-2.5 rounded-lg pr-8 pl-2.5 text-left transition-colors ${
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
          {kind && <KindAvatar kind={kind} size={18} />}
          <span className="flex min-w-0 flex-1 flex-col">
            <span className={`flex items-center gap-1 text-[14px] leading-[20px] ${active || th.unread ? 'font-medium text-ink' : 'text-ink/85'}`}>
              {th.pinned && <IconPin size={12} className="shrink-0 text-ink-3" aria-label={t('nav.pinned')} />}
              <span className="truncate">{th.title}</span>
            </span>
            <span className="flex items-center gap-1 text-[12px] leading-[17px] text-ink-3">
              {busy ? (
                <>
                  <Spinner size={11} className="text-accent" />
                  {t('nav.replying')}
                </>
              ) : th.unread === 'done' ? (
                <>
                  <IconCheck size={11} className="shrink-0 text-ok" />
                  <span className="font-medium text-ok">{t('nav.done')}</span>
                  <span>· <ListTime ts={th.updatedAt} /></span>
                </>
              ) : th.unread === 'error' ? (
                <>
                  <span className="font-medium text-danger">{t('nav.failed')}</span>
                  <span>· <ListTime ts={th.updatedAt} /></span>
                </>
              ) : th.unread === 'paused' ? (
                <>
                  <span className="font-medium text-warn">{t('nav.paused')}</span>
                  <span>· <ListTime ts={th.updatedAt} /></span>
                </>
              ) : (
                <ListTime ts={th.updatedAt} />
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
      {!editing && <MoreButton open={!!menu} onToggle={(at) => setMenu(at)} />}
      {menu && (
        <RowMenu at={menu} onClose={closeMenu}>
          <MenuItem onClick={() => setEditing(true)}>{t('common.rename')}</MenuItem>
          {!th.archived && <MenuItem onClick={() => togglePin(th.id)}>{th.pinned ? t('nav.unpin') : t('nav.pin')}</MenuItem>}
          <MenuItem onClick={() => (th.archived ? unarchiveThread(th.id) : archiveThread(th.id))}>
            {th.archived ? t('nav.unarchive') : t('nav.archive')}
          </MenuItem>
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
