import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ProfileKind, RequestLogEntry, RequestLogPage, RequestLogQuery, RequestLogStatusFilter } from '@shared/types'
import { KIND_META } from '../lib/ui'
import { useApp } from '../state/AppContext'
import { selectThread, useChat } from '../state/chat'
import { t } from '../state/i18n'
import { KindAvatar } from './common'
import { IconCheck, IconChevronDown, IconCopy, IconExternal, IconInfo, IconSliders, IconX, Spinner } from './icons'

export type RequestLogColumnKey =
  | 'engine'
  | 'provider'
  | 'model'
  | 'cost'
  | 'uncachedInput'
  | 'output'
  | 'cacheRead'
  | 'speed'
  | 'ttft'
  | 'cacheWrite'
  | 'hitRate'
  | 'duration'
  | 'statusCode'

export interface ColumnDef {
  key: RequestLogColumnKey
  labelKey: Parameters<typeof t>[0]
  defaultVisible: boolean
  align: 'left' | 'right'
}

/** All 13 optional columns (Time is always pinned as the leading column). */
export const REQUEST_LOG_COLUMNS: readonly ColumnDef[] = [
  { key: 'engine', labelKey: 'reqLog.col.engine', defaultVisible: true, align: 'left' },
  { key: 'provider', labelKey: 'reqLog.col.provider', defaultVisible: true, align: 'left' },
  { key: 'model', labelKey: 'reqLog.col.model', defaultVisible: true, align: 'left' },
  { key: 'cost', labelKey: 'reqLog.col.cost', defaultVisible: true, align: 'right' },
  { key: 'uncachedInput', labelKey: 'reqLog.col.uncachedInput', defaultVisible: true, align: 'right' },
  { key: 'output', labelKey: 'reqLog.col.output', defaultVisible: true, align: 'right' },
  { key: 'cacheRead', labelKey: 'reqLog.col.cacheRead', defaultVisible: true, align: 'right' },
  { key: 'speed', labelKey: 'reqLog.col.speed', defaultVisible: true, align: 'right' },
  { key: 'ttft', labelKey: 'reqLog.col.ttft', defaultVisible: true, align: 'right' },
  { key: 'cacheWrite', labelKey: 'reqLog.col.cacheWrite', defaultVisible: false, align: 'right' },
  { key: 'hitRate', labelKey: 'reqLog.col.hitRate', defaultVisible: false, align: 'right' },
  { key: 'duration', labelKey: 'reqLog.col.duration', defaultVisible: false, align: 'right' },
  { key: 'statusCode', labelKey: 'reqLog.col.statusCode', defaultVisible: false, align: 'right' }
] as const

export type ColumnVisibility = Record<RequestLogColumnKey, boolean>

export const COLUMN_PREFS_STORAGE_KEY = 'agentswitch:requestLog:columns:v1'
const PAGE_SIZE = 100

export function defaultColumnVisibility(): ColumnVisibility {
  const out = {} as ColumnVisibility
  for (const col of REQUEST_LOG_COLUMNS) out[col.key] = col.defaultVisible
  return out
}

export function loadColumnVisibility(storage: Pick<Storage, 'getItem'> | null | undefined = typeof localStorage !== 'undefined' ? localStorage : null): ColumnVisibility {
  const base = defaultColumnVisibility()
  if (!storage) return base
  try {
    const raw = storage.getItem(COLUMN_PREFS_STORAGE_KEY)
    if (!raw) return base
    const parsed = JSON.parse(raw) as Record<string, unknown>
    if (!parsed || typeof parsed !== 'object') return base
    for (const col of REQUEST_LOG_COLUMNS) {
      if (typeof parsed[col.key] === 'boolean') base[col.key] = parsed[col.key] as boolean
    }
  } catch {
    /* ignore corrupt storage */
  }
  return base
}

export function saveColumnVisibility(
  vis: ColumnVisibility,
  storage: Pick<Storage, 'setItem'> | null | undefined = typeof localStorage !== 'undefined' ? localStorage : null
): void {
  if (!storage) return
  try {
    storage.setItem(COLUMN_PREFS_STORAGE_KEY, JSON.stringify(vis))
  } catch {
    /* ignore quota errors */
  }
}

// ---- formatting helpers --------------------------------------------------------------------

const pad2 = (n: number) => String(n).padStart(2, '0')

export function fmtTimeHms(ts: number): string {
  const d = new Date(ts)
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
}

export function fmtFullDateTime(ts: number): string {
  const d = new Date(ts)
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${fmtTimeHms(ts)}`
}

/** Compact uppercase token count: 265K, 1.2M, 850. */
export function fmtCompactTokens(v: number): string {
  if (!Number.isFinite(v) || v <= 0) return '0'
  if (v >= 1e9) return `${(v / 1e9).toFixed(v >= 1e10 ? 0 : 1)}B`
  if (v >= 1e6) return `${(v / 1e6).toFixed(v >= 1e7 ? 0 : 1)}M`
  if (v >= 1e3) return `${(v / 1e3).toFixed(v >= 1e5 ? 0 : v >= 1e4 ? 0 : 1)}K`
  return String(Math.round(v))
}

/** Per-request USD cost with 4 decimal places for small values (e.g. $0.0578). */
export function fmtRequestCost(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—'
  if (v === 0) return '$0.0000'
  if (v >= 10) return `$${v.toFixed(2)}`
  if (v >= 1) return `$${v.toFixed(3)}`
  return `$${v.toFixed(4)}`
}

/** Latency formatting: ≈1.6s, 420ms, or —. */
export function fmtLatency(ms: number | null | undefined, approx = false): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return '—'
  const prefix = approx ? '≈' : ''
  if (ms >= 60_000) {
    const mins = Math.floor(ms / 60_000)
    const secs = ((ms % 60_000) / 1000).toFixed(0)
    return `${prefix}${mins}m${secs}s`
  }
  if (ms >= 1000) return `${prefix}${(ms / 1000).toFixed(1)}s`
  return `${prefix}${Math.round(ms)}ms`
}

export function fmtSpeed(tps: number | null | undefined): string {
  if (tps === null || tps === undefined || !Number.isFinite(tps) || tps <= 0) return '—'
  return `≈${Math.round(tps)} tok/s`
}

export function fmtHitRate(entry: Pick<RequestLogEntry, 'uncachedInputTokens' | 'cacheReadTokens' | 'cacheWriteTokens'>): string {
  const denom = entry.uncachedInputTokens + entry.cacheReadTokens + entry.cacheWriteTokens
  if (denom <= 0) return '—'
  return `${((entry.cacheReadTokens / denom) * 100).toFixed(1)}%`
}

function statusBadgeClass(code: number): string {
  if (code >= 200 && code < 300) return 'bg-ok-soft text-ok'
  if (code === 429) return 'bg-warn-soft text-warn'
  if (code === 499) return 'bg-black/[0.06] text-ink-3 dark:bg-white/[0.08]'
  return 'bg-danger-soft text-danger'
}

const CARD = 'rounded-xl border border-black/[0.07] bg-surface shadow-[0_1px_2px_rgba(0,0,0,0.03)]'
const SELECT_CLS =
  'h-7 rounded-lg border border-black/[0.09] bg-surface px-2.5 pr-7 text-[12px] font-medium text-ink shadow-[0_1px_2px_rgba(0,0,0,0.03)] outline-none hover:bg-black/[0.02] focus:border-accent dark:border-white/[0.12]'

function useOutsideClose(open: boolean, close: () => void) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) close()
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [open, close])
  return ref
}

// ---- Detail Drawer/Panel (no backdrop blur) -------------------------------------------------

function RequestLogDetail({
  entry,
  onClose,
  onJumpThread
}: {
  entry: RequestLogEntry
  onClose: () => void
  onJumpThread?: (threadId: string) => void
}) {
  const [copied, setCopied] = useState(false)
  const chat = useChat()
  const thread = entry.threadId ? chat.threads.find((th) => th.id === entry.threadId) : undefined
  const rawJson = useMemo(
    () => (entry.rawUsage !== undefined && entry.rawUsage !== null ? JSON.stringify(entry.rawUsage, null, 2) : null),
    [entry.rawUsage]
  )

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])

  const copyJson = async () => {
    if (!rawJson) return
    await window.agentswitch.sys.copy(rawJson)
    setCopied(true)
    setTimeout(() => setCopied(false), 1600)
  }

  return (
    <div
      className="fixed inset-0 z-50 flex justify-end bg-black/25"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="true"
        className="flex h-full w-[440px] max-w-[92vw] flex-col border-l border-black/[0.08] bg-surface shadow-[0_0_32px_rgba(0,0,0,0.18)] dark:border-white/[0.1]"
      >
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-hairline px-5 py-3.5">
          <div className="flex min-w-0 items-center gap-2">
            <KindAvatar kind={entry.engineKind} size={20} />
            <span className="truncate text-[14px] font-semibold text-ink">{t('reqLog.detailTitle')}</span>
            <span className={`shrink-0 rounded px-1.5 py-0.5 font-mono text-[11px] font-medium tabular-nums ${statusBadgeClass(entry.statusCode)}`}>
              {entry.statusCode}
            </span>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="flex h-7 w-7 items-center justify-center rounded-full text-ink-3 hover:bg-black/[0.06] hover:text-ink"
            title={t('common.close')}
          >
            <IconX size={15} />
          </button>
        </div>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4 text-[12.5px]">
          <div className="grid grid-cols-2 gap-x-4 gap-y-2.5 rounded-xl border border-black/[0.06] bg-canvas/70 p-3.5">
            <div>
              <div className="text-[11px] text-ink-3">{t('reqLog.col.time')}</div>
              <div className="mt-0.5 font-mono text-ink tabular-nums">{fmtFullDateTime(entry.timestamp)}</div>
            </div>
            <div>
              <div className="text-[11px] text-ink-3">{t('reqLog.col.engine')}</div>
              <div className="mt-0.5 text-ink">
                {KIND_META[entry.engineKind]?.name ?? entry.engineKind} · {entry.accountName}
              </div>
            </div>
            <div>
              <div className="text-[11px] text-ink-3">{t('reqLog.col.provider')}</div>
              <div className="mt-0.5 text-ink">{entry.provider}</div>
            </div>
            <div>
              <div className="text-[11px] text-ink-3">{t('reqLog.col.model')}</div>
              <div className="mt-0.5 truncate font-mono text-ink" title={entry.model}>
                {entry.model}
              </div>
            </div>
            {entry.turnIndex != null && (
              <div>
                <div className="text-[11px] text-ink-3">{t('reqLog.detailTurn')}</div>
                <div className="mt-0.5 font-mono text-ink tabular-nums">#{entry.turnIndex}</div>
              </div>
            )}
            {entry.runId && (
              <div>
                <div className="text-[11px] text-ink-3">{t('reqLog.detailRunId')}</div>
                <div className="mt-0.5 truncate font-mono text-[11.5px] text-ink-2" title={entry.runId}>
                  {entry.runId}
                </div>
              </div>
            )}
          </div>

          {(entry.projectDir || entry.threadId) && (
            <div className="space-y-2 rounded-xl border border-black/[0.06] bg-canvas/70 p-3.5">
              {entry.projectDir && (
                <div>
                  <div className="text-[11px] text-ink-3">{t('reqLog.detailProject')}</div>
                  <div className="mt-0.5 truncate font-mono text-[11.5px] text-ink-2 select-text" title={entry.projectDir}>
                    {entry.projectDir}
                  </div>
                </div>
              )}
              {entry.threadId && (
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <div className="text-[11px] text-ink-3">{t('reqLog.detailThread')}</div>
                    <div className="mt-0.5 truncate text-ink" title={thread?.title || entry.threadId}>
                      {thread?.title || entry.threadId}
                    </div>
                  </div>
                  {thread && onJumpThread && (
                    <button
                      type="button"
                      onClick={() => onJumpThread(thread.id)}
                      className="inline-flex h-7 shrink-0 items-center gap-1 rounded-lg border border-black/[0.09] bg-surface px-2.5 text-[11.5px] font-medium text-ink hover:bg-black/[0.04]"
                    >
                      <IconExternal size={12} /> {t('reqLog.jumpToThread')}
                    </button>
                  )}
                </div>
              )}
            </div>
          )}

          <div>
            <div className="mb-1.5 text-[11.5px] font-medium text-ink-3">{t('reqLog.detailMetrics')}</div>
            <div className="grid grid-cols-3 gap-2">
              {[
                [t('reqLog.col.uncachedInput'), entry.uncachedInputTokens.toLocaleString()],
                [t('reqLog.col.output'), entry.outputTokens.toLocaleString()],
                [t('reqLog.col.cacheRead'), entry.cacheReadTokens.toLocaleString()],
                [t('reqLog.col.cacheWrite'), entry.cacheWriteTokens.toLocaleString()],
                [t('reqLog.col.hitRate'), fmtHitRate(entry)],
                [t('reqLog.col.cost'), fmtRequestCost(entry.costUsd)],
                [t('reqLog.col.ttft'), fmtLatency(entry.ttftMs, true)],
                [t('reqLog.col.duration'), fmtLatency(entry.durationMs)],
                [t('reqLog.col.speed'), fmtSpeed(entry.tokensPerSecond)]
              ].map(([label, val]) => (
                <div key={label} className="rounded-lg border border-black/[0.06] bg-canvas/70 px-2.5 py-2">
                  <div className="text-[10.5px] text-ink-3">{label}</div>
                  <div className="mt-0.5 font-mono text-[12.5px] font-medium text-ink tabular-nums">{val}</div>
                </div>
              ))}
            </div>
          </div>

          {entry.errorSummary && (
            <div>
              <div className="mb-1.5 text-[11.5px] font-medium text-danger">{t('reqLog.detailError')}</div>
              <div className="rounded-xl bg-danger-soft/80 px-3 py-2.5 font-mono text-[11.5px] leading-relaxed text-danger break-words select-text">
                {entry.errorSummary}
              </div>
            </div>
          )}

          <div>
            <div className="mb-1.5 flex items-center justify-between">
              <span className="text-[11.5px] font-medium text-ink-3">{t('reqLog.detailRawUsage')}</span>
              {rawJson && (
                <button
                  type="button"
                  onClick={() => void copyJson()}
                  className="inline-flex h-6 items-center gap-1 rounded-md px-2 text-[11px] font-medium text-ink-2 hover:bg-black/[0.05] hover:text-ink"
                >
                  {copied ? <IconCheck size={12} /> : <IconCopy size={12} />}
                  {copied ? t('reqLog.copied') : t('reqLog.copyJson')}
                </button>
              )}
            </div>
            {rawJson ? (
              <pre className="max-h-64 overflow-auto rounded-xl border border-black/[0.06] bg-canvas p-3 font-mono text-[11px] leading-relaxed text-ink-2 select-text">
                {rawJson}
              </pre>
            ) : (
              <div className="rounded-xl border border-black/[0.06] bg-canvas/60 px-3 py-2.5 text-[12px] text-ink-3">
                {t('reqLog.noRawUsage')}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

// ---- Main RequestLogView --------------------------------------------------------------------

export function RequestLogView({
  onCloseDialog,
  onCountsChange
}: {
  onCloseDialog?: () => void
  onCountsChange?: (counts: RequestLogPage['counts']) => void
}) {
  const { navigate } = useApp()
  const [statusFilter, setStatusFilter] = useState<RequestLogStatusFilter>('all')
  const [engineFilter, setEngineFilter] = useState<ProfileKind | ''>('')
  const [modelFilter, setModelFilter] = useState<string>('')
  const [columns, setColumns] = useState<ColumnVisibility>(() => loadColumnVisibility())
  const [colMenuOpen, setColMenuOpen] = useState(false)
  const [entries, setEntries] = useState<RequestLogEntry[]>([])
  const [pageMeta, setPageMeta] = useState<Pick<RequestLogPage, 'total' | 'filteredTotal' | 'hasMore' | 'counts' | 'availableModels' | 'availableEngines'>>({
    total: 0,
    filteredTotal: 0,
    hasMore: false,
    counts: { total: 0, accounts: 0, models: 0, status2xx: 0, status429: 0, statusError: 0 },
    availableModels: [],
    availableEngines: []
  })
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [selected, setSelected] = useState<RequestLogEntry | null>(null)
  const sentinelRef = useRef<HTMLDivElement>(null)
  const reqSeq = useRef(0)

  const closeColMenu = useCallback(() => setColMenuOpen(false), [])
  const colMenuRef = useOutsideClose(colMenuOpen, closeColMenu)

  const toggleColumn = (key: RequestLogColumnKey) => {
    setColumns((prev) => {
      const next = { ...prev, [key]: !prev[key] }
      saveColumnVisibility(next)
      return next
    })
  }

  const resetColumns = () => {
    const next = defaultColumnVisibility()
    saveColumnVisibility(next)
    setColumns(next)
  }

  const buildQuery = useCallback(
    (offset: number): RequestLogQuery => ({
      offset,
      limit: PAGE_SIZE,
      statusCode: statusFilter,
      engineKind: engineFilter || null,
      model: modelFilter || null
    }),
    [statusFilter, engineFilter, modelFilter]
  )

  const loadPage = useCallback(
    async (offset: number, append: boolean) => {
      const seq = ++reqSeq.current
      if (append) setLoadingMore(true)
      else setLoading(true)
      try {
        const res = await window.agentswitch.usage.requestLogs(buildQuery(offset))
        if (seq !== reqSeq.current) return
        setEntries((prev) => (append ? [...prev, ...res.entries] : res.entries))
        setPageMeta({
          total: res.total,
          filteredTotal: res.filteredTotal,
          hasMore: res.hasMore,
          counts: res.counts,
          availableModels: res.availableModels,
          availableEngines: res.availableEngines
        })
        onCountsChange?.(res.counts)
      } finally {
        if (seq === reqSeq.current) {
          setLoading(false)
          setLoadingMore(false)
        }
      }
    },
    [buildQuery, onCountsChange]
  )

  useEffect(() => {
    void loadPage(0, false)
  }, [loadPage])

  useEffect(() => {
    return window.agentswitch.usage.onRequestLogsChanged(() => {
      void loadPage(0, false)
    })
  }, [loadPage])

  const loadMore = useCallback(() => {
    if (loading || loadingMore || !pageMeta.hasMore) return
    void loadPage(entries.length, true)
  }, [loading, loadingMore, pageMeta.hasMore, entries.length, loadPage])

  useEffect(() => {
    const el = sentinelRef.current
    if (!el || !pageMeta.hasMore || loading) return
    const io = new IntersectionObserver(
      (items) => {
        if (items.some((i) => i.isIntersecting)) loadMore()
      },
      { rootMargin: '180px' }
    )
    io.observe(el)
    return () => io.disconnect()
  }, [pageMeta.hasMore, loading, loadMore])

  const visibleCols = useMemo(() => REQUEST_LOG_COLUMNS.filter((c) => columns[c.key]), [columns])

  const handleJumpThread = (threadId: string) => {
    setSelected(null)
    onCloseDialog?.()
    selectThread(threadId)
    navigate('workbench')
  }

  const parseStatusOption = (raw: string): RequestLogStatusFilter => {
    if (raw === 'all' || raw === '2xx' || raw === '429' || raw === '4xx5xx') return raw
    const num = Number(raw)
    return Number.isInteger(num) ? num : 'all'
  }

  return (
    <div>
      {/* Toolbar: count summary on left, filters + column customizer on right */}
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="text-[12px] text-ink-3 tabular-nums">
          {t('reqLog.showingCount', { shown: entries.length, total: pageMeta.filteredTotal })}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {/* Engine filter */}
          <div className="relative">
            <select
              aria-label={t('reqLog.filterEngine')}
              value={engineFilter}
              onChange={(e) => setEngineFilter((e.target.value as ProfileKind) || '')}
              className={SELECT_CLS + ' appearance-none'}
            >
              <option value="">{t('reqLog.filterEngineAll')}</option>
              {pageMeta.availableEngines.map((kind) => (
                <option key={kind} value={kind}>
                  {KIND_META[kind]?.name ?? kind}
                </option>
              ))}
            </select>
            <IconChevronDown size={12} className="pointer-events-none absolute top-1/2 right-2 -translate-y-1/2 text-ink-3" />
          </div>

          {/* Model filter */}
          <div className="relative">
            <select
              aria-label={t('reqLog.filterModel')}
              value={modelFilter}
              onChange={(e) => setModelFilter(e.target.value)}
              className={SELECT_CLS + ' max-w-[190px] appearance-none truncate'}
            >
              <option value="">{t('reqLog.filterModelAll')}</option>
              {pageMeta.availableModels.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
            <IconChevronDown size={12} className="pointer-events-none absolute top-1/2 right-2 -translate-y-1/2 text-ink-3" />
          </div>

          {/* Status code filter */}
          <div className="relative">
            <select
              aria-label={t('reqLog.filterStatus')}
              value={String(statusFilter)}
              onChange={(e) => setStatusFilter(parseStatusOption(e.target.value))}
              className={SELECT_CLS + ' appearance-none'}
            >
              <option value="all">{t('reqLog.statusAll')}</option>
              <option value="2xx">{t('reqLog.status2xx')}</option>
              <option value="429">{t('reqLog.status429')}</option>
              <option value="4xx5xx">{t('reqLog.statusError')}</option>
              <option value="200">200 OK</option>
              <option value="401">401 Unauthorized</option>
              <option value="403">403 Forbidden</option>
              <option value="408">408 Timeout</option>
              <option value="499">499 Aborted</option>
              <option value="500">500 Error</option>
            </select>
            <IconChevronDown size={12} className="pointer-events-none absolute top-1/2 right-2 -translate-y-1/2 text-ink-3" />
          </div>

          {/* Column visibility menu (no backdrop blur) */}
          <div ref={colMenuRef} className="relative">
            <button
              type="button"
              onClick={() => setColMenuOpen((o) => !o)}
              className={`flex h-7 items-center gap-1.5 rounded-lg border px-2.5 text-[12px] font-medium transition-colors ${
                colMenuOpen
                  ? 'border-black/[0.16] bg-black/[0.04] text-ink'
                  : 'border-black/[0.09] bg-surface text-ink-2 shadow-[0_1px_2px_rgba(0,0,0,0.03)] hover:text-ink'
              }`}
            >
              <IconSliders size={12} />
              {t('reqLog.columns')}
              <IconChevronDown size={11} />
            </button>
            {colMenuOpen && (
              <div className="absolute top-full right-0 z-40 mt-1.5 w-52 rounded-xl border border-black/[0.1] bg-surface p-1.5 shadow-[0_12px_32px_rgba(0,0,0,0.16)] dark:border-white/[0.12]">
                <div className="flex items-center justify-between px-2 py-1 text-[11px] font-medium text-ink-3">
                  <span>{t('reqLog.columnsTitle')}</span>
                  <button type="button" onClick={resetColumns} className="text-accent hover:underline">
                    {t('reqLog.columnsReset')}
                  </button>
                </div>
                <div className="max-h-72 overflow-y-auto py-0.5">
                  {REQUEST_LOG_COLUMNS.map((col) => {
                    const checked = columns[col.key]
                    return (
                      <label
                        key={col.key}
                        className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-[12px] text-ink hover:bg-black/[0.04] dark:hover:bg-white/[0.06]"
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => toggleColumn(col.key)}
                          className="h-3.5 w-3.5 rounded accent-accent"
                        />
                        <span className="truncate">{t(col.labelKey)}</span>
                      </label>
                    )
                  })}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Paginated dense table */}
      <div className={`overflow-x-auto ${CARD}`}>
        <table className="w-full border-collapse text-[12.5px]">
          <thead>
            <tr className="border-b border-black/[0.06] bg-surface-2/80 text-[11.5px] text-ink-3">
              <th className="px-3 py-2 text-left font-medium whitespace-nowrap">{t('reqLog.col.time')}</th>
              {visibleCols.map((col) => (
                <th
                  key={col.key}
                  className={`px-2.5 py-2 font-medium whitespace-nowrap ${col.align === 'right' ? 'text-right' : 'text-left'}`}
                >
                  {col.key === 'speed' ? (
                    <span className="inline-flex items-center justify-end gap-1" title={t('reqLog.speedTooltip')}>
                      {t(col.labelKey)}
                      <IconInfo size={11} className="text-ink-3/80" />
                    </span>
                  ) : (
                    t(col.labelKey)
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {loading && !entries.length ? (
              <tr>
                <td colSpan={visibleCols.length + 1} className="px-4 py-8 text-center text-ink-3">
                  <span className="inline-flex items-center gap-2">
                    <Spinner size={13} /> {t('reqLog.loading')}
                  </span>
                </td>
              </tr>
            ) : entries.length ? (
              entries.map((entry) => (
                <tr
                  key={entry.id}
                  onClick={() => setSelected(entry)}
                  className="cursor-pointer border-b border-black/[0.05] transition-colors last:border-0 hover:bg-black/[0.025] dark:hover:bg-white/[0.04]"
                >
                  <td
                    className="px-3 py-2 font-mono text-[12px] whitespace-nowrap text-ink-2 tabular-nums"
                    title={fmtFullDateTime(entry.timestamp)}
                  >
                    {fmtTimeHms(entry.timestamp)}
                  </td>
                  {visibleCols.map((col) => {
                    switch (col.key) {
                      case 'engine':
                        return (
                          <td key={col.key} className="max-w-[140px] px-2.5 py-2 whitespace-nowrap">
                            <div className="flex items-center gap-1.5">
                              <KindAvatar kind={entry.engineKind} size={16} />
                              <span className="truncate text-ink" title={`${KIND_META[entry.engineKind]?.name ?? entry.engineKind} · ${entry.accountName}`}>
                                {KIND_META[entry.engineKind]?.name ?? entry.engineKind}
                              </span>
                            </div>
                          </td>
                        )
                      case 'provider':
                        return (
                          <td key={col.key} className="max-w-[110px] truncate px-2.5 py-2 whitespace-nowrap text-ink-2" title={entry.provider}>
                            {entry.provider}
                          </td>
                        )
                      case 'model':
                        return (
                          <td key={col.key} className="max-w-[180px] truncate px-2.5 py-2 font-mono text-[11.5px] whitespace-nowrap text-ink" title={entry.model}>
                            {entry.model}
                          </td>
                        )
                      case 'cost':
                        return (
                          <td key={col.key} className="px-2.5 py-2 text-right font-mono whitespace-nowrap text-ink tabular-nums">
                            {fmtRequestCost(entry.costUsd)}
                          </td>
                        )
                      case 'uncachedInput':
                        return (
                          <td
                            key={col.key}
                            className="px-2.5 py-2 text-right font-mono whitespace-nowrap text-ink-2 tabular-nums"
                            title={entry.uncachedInputTokens.toLocaleString()}
                          >
                            {fmtCompactTokens(entry.uncachedInputTokens)}
                          </td>
                        )
                      case 'output':
                        return (
                          <td
                            key={col.key}
                            className="px-2.5 py-2 text-right font-mono whitespace-nowrap text-ink-2 tabular-nums"
                            title={entry.outputTokens.toLocaleString()}
                          >
                            {fmtCompactTokens(entry.outputTokens)}
                          </td>
                        )
                      case 'cacheRead':
                        return (
                          <td
                            key={col.key}
                            className="px-2.5 py-2 text-right font-mono whitespace-nowrap text-ink-2 tabular-nums"
                            title={entry.cacheReadTokens.toLocaleString()}
                          >
                            {fmtCompactTokens(entry.cacheReadTokens)}
                          </td>
                        )
                      case 'speed':
                        return (
                          <td key={col.key} className="px-2.5 py-2 text-right font-mono whitespace-nowrap text-ink-2 tabular-nums">
                            {fmtSpeed(entry.tokensPerSecond)}
                          </td>
                        )
                      case 'ttft':
                        return (
                          <td key={col.key} className="px-2.5 py-2 text-right font-mono whitespace-nowrap text-ink-2 tabular-nums">
                            {fmtLatency(entry.ttftMs, true)}
                          </td>
                        )
                      case 'cacheWrite':
                        return (
                          <td
                            key={col.key}
                            className="px-2.5 py-2 text-right font-mono whitespace-nowrap text-ink-2 tabular-nums"
                            title={entry.cacheWriteTokens.toLocaleString()}
                          >
                            {fmtCompactTokens(entry.cacheWriteTokens)}
                          </td>
                        )
                      case 'hitRate':
                        return (
                          <td key={col.key} className="px-2.5 py-2 text-right font-mono whitespace-nowrap text-ink-2 tabular-nums">
                            {fmtHitRate(entry)}
                          </td>
                        )
                      case 'duration':
                        return (
                          <td key={col.key} className="px-2.5 py-2 text-right font-mono whitespace-nowrap text-ink-2 tabular-nums">
                            {fmtLatency(entry.durationMs)}
                          </td>
                        )
                      case 'statusCode':
                        return (
                          <td key={col.key} className="px-2.5 py-2 text-right whitespace-nowrap">
                            <span className={`inline-block rounded px-1.5 py-0.5 font-mono text-[11px] font-medium tabular-nums ${statusBadgeClass(entry.statusCode)}`}>
                              {entry.statusCode}
                            </span>
                          </td>
                        )
                    }
                  })}
                </tr>
              ))
            ) : (
              <tr>
                <td colSpan={visibleCols.length + 1} className="px-4 py-8 text-center text-[13px] text-ink-3">
                  {t('reqLog.empty')}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Infinite-scroll sentinel + manual Load More fallback */}
      <div ref={sentinelRef} className="mt-3 flex justify-center">
        {pageMeta.hasMore && (
          <button
            type="button"
            disabled={loadingMore}
            onClick={loadMore}
            className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-black/[0.09] bg-surface px-4 text-[12px] font-medium text-ink-2 shadow-[0_1px_2px_rgba(0,0,0,0.03)] hover:bg-black/[0.03] hover:text-ink disabled:opacity-60"
          >
            {loadingMore && <Spinner size={12} />}
            {loadingMore ? t('reqLog.loading') : t('reqLog.loadMore')}
          </button>
        )}
      </div>

      {selected && <RequestLogDetail entry={selected} onClose={() => setSelected(null)} onJumpThread={handleJumpThread} />}
    </div>
  )
}
