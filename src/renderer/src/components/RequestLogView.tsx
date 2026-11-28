import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ProfileKind, RequestLogEntry, RequestLogPage, RequestLogQuery, RequestLogStatusFilter } from '@shared/types'
import { useLayer } from '../lib/escStack'
import { KIND_META } from '../lib/ui'
import { useApp } from '../state/AppContext'
import { selectThread, useChat } from '../state/chat'
import { t } from '../state/i18n'
import { KindAvatar } from './common'
import { IconCheck, IconChevronDown, IconChevronLeft, IconChevronRight, IconCopy, IconExternal, IconInfo, IconSliders, IconX, Spinner } from './icons'

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
export const PAGE_SIZE_STORAGE_KEY = 'agentswitch:requestLog:pageSize:v1'
export const PAGE_SIZE_OPTIONS = [20, 50, 100] as const
export type RequestLogPageSize = (typeof PAGE_SIZE_OPTIONS)[number]
export const DEFAULT_PAGE_SIZE: RequestLogPageSize = 20

export function loadPageSize(
  storage: Pick<Storage, 'getItem'> | null | undefined = typeof localStorage !== 'undefined' ? localStorage : null
): RequestLogPageSize {
  if (!storage) return DEFAULT_PAGE_SIZE
  try {
    const raw = storage.getItem(PAGE_SIZE_STORAGE_KEY)
    if (!raw) return DEFAULT_PAGE_SIZE
    const parsed = Number(raw)
    if (PAGE_SIZE_OPTIONS.includes(parsed as RequestLogPageSize)) return parsed as RequestLogPageSize
  } catch {
    /* ignore corrupt storage */
  }
  return DEFAULT_PAGE_SIZE
}

export function savePageSize(
  size: RequestLogPageSize,
  storage: Pick<Storage, 'setItem'> | null | undefined = typeof localStorage !== 'undefined' ? localStorage : null
): void {
  if (!storage) return
  try {
    storage.setItem(PAGE_SIZE_STORAGE_KEY, String(size))
  } catch {
    /* ignore quota errors */
  }
}

export function getTotalPages(filteredTotal: number, pageSize: number): number {
  const safeTotal = Number.isFinite(filteredTotal) ? Math.max(0, Math.floor(filteredTotal)) : 0
  const safeSize = Number.isFinite(pageSize) ? Math.max(1, Math.floor(pageSize)) : DEFAULT_PAGE_SIZE
  return Math.max(1, Math.ceil(safeTotal / safeSize))
}

export function clampPage(page: number, totalPages: number): number {
  const max = Number.isFinite(totalPages) ? Math.max(1, Math.floor(totalPages)) : 1
  if (!Number.isFinite(page)) return 1
  return Math.min(max, Math.max(1, Math.floor(page)))
}

export function getPageRange(page: number, pageSize: number, filteredTotal: number): { start: number; end: number } {
  if (!Number.isFinite(filteredTotal) || filteredTotal <= 0) return { start: 0, end: 0 }
  const total = Math.floor(filteredTotal)
  const safeSize = Math.max(1, Math.floor(pageSize))
  const safePage = clampPage(page, getTotalPages(total, safeSize))
  const start = (safePage - 1) * safeSize + 1
  const end = Math.min(safePage * safeSize, total)
  return { start, end }
}

export type PageToken = number | 'ellipsis-left' | 'ellipsis-right'

export function buildPageTokens(currentPage: number, totalPages: number): PageToken[] {
  const max = Math.max(1, Math.floor(totalPages))
  const cur = clampPage(currentPage, max)
  if (max <= 7) {
    return Array.from({ length: max }, (_, idx) => idx + 1)
  }
  if (cur <= 4) {
    return [1, 2, 3, 4, 5, 'ellipsis-right', max]
  }
  if (cur >= max - 3) {
    return [1, 'ellipsis-left', max - 4, max - 3, max - 2, max - 1, max]
  }
  return [1, 'ellipsis-left', cur - 1, cur, cur + 1, 'ellipsis-right', max]
}

export function createLatestRequestGuard() {
  let latest = 0
  return {
    next: () => ++latest,
    isLatest: (token: number) => token === latest
  }
}

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

  const closeButton = useRef<HTMLButtonElement>(null)
  useLayer({ onEsc: onClose, onClose })
  useLayoutEffect(() => {
    const focused = document.activeElement
    closeButton.current?.focus({ preventScroll: true })
    return () => {
      if (focused instanceof HTMLElement && focused.isConnected) focused.focus({ preventScroll: true })
    }
  }, [])

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
        aria-label={t('reqLog.detailTitle')}
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
            ref={closeButton}
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
              <div className="mt-0.5 truncate font-mono text-ink" title={entry.model || '—'}>
                {entry.model || '—'}
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
  onCountsChange,
  refreshToken = 0
}: {
  onCloseDialog?: () => void
  onCountsChange?: (counts: RequestLogPage['counts']) => void
  refreshToken?: number
}) {
  const { navigate } = useApp()
  const [statusFilter, setStatusFilter] = useState<RequestLogStatusFilter>('all')
  const [engineFilter, setEngineFilter] = useState<ProfileKind | ''>('')
  const [modelFilter, setModelFilter] = useState<string>('')
  const [page, setPage] = useState<number>(1)
  const [pageSize, setPageSize] = useState<RequestLogPageSize>(() => loadPageSize())
  const [jumpInput, setJumpInput] = useState<string>('')
  const [changeNonce, setChangeNonce] = useState<number>(0)
  const [columns, setColumns] = useState<ColumnVisibility>(() => loadColumnVisibility())
  const [colMenuOpen, setColMenuOpen] = useState(false)
  const [entries, setEntries] = useState<RequestLogEntry[]>([])
  const [pageMeta, setPageMeta] = useState<Pick<RequestLogPage, 'total' | 'filteredTotal' | 'counts' | 'availableModels' | 'availableEngines'>>({
    total: 0,
    filteredTotal: 0,
    counts: { total: 0, accounts: 0, models: 0, status2xx: 0, status429: 0, statusError: 0 },
    availableModels: [],
    availableEngines: []
  })
  const [loading, setLoading] = useState(true)
  const [selected, setSelected] = useState<RequestLogEntry | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const requestGuardRef = useRef(createLatestRequestGuard())

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

  const resetScrollAndCloseDetail = useCallback(() => {
    setSelected(null)
    if (scrollRef.current) scrollRef.current.scrollTop = 0
  }, [])

  const buildQuery = useCallback(
    (targetPage: number): RequestLogQuery => ({
      offset: (targetPage - 1) * pageSize,
      limit: pageSize,
      statusCode: statusFilter,
      engineKind: engineFilter || null,
      model: modelFilter || null
    }),
    [pageSize, statusFilter, engineFilter, modelFilter]
  )

  const loadPage = useCallback(
    async (targetPage: number) => {
      const token = requestGuardRef.current.next()
      setLoading(true)
      let redirected = false
      try {
        const res = await window.agentswitch.usage.requestLogs(buildQuery(targetPage))
        if (!requestGuardRef.current.isLatest(token)) return
        const nextTotalPages = getTotalPages(res.filteredTotal, pageSize)
        if (targetPage > nextTotalPages) {
          redirected = true
          onCountsChange?.(res.counts)
          resetScrollAndCloseDetail()
          setPage(nextTotalPages)
          return
        }
        setEntries(res.entries)
        setPageMeta({
          total: res.total,
          filteredTotal: res.filteredTotal,
          counts: res.counts,
          availableModels: res.availableModels,
          availableEngines: res.availableEngines
        })
        onCountsChange?.(res.counts)
      } catch {
        /* keep current rows visible on transient IPC error */
      } finally {
        if (!redirected && requestGuardRef.current.isLatest(token)) {
          setLoading(false)
        }
      }
    },
    [buildQuery, pageSize, onCountsChange, resetScrollAndCloseDetail]
  )

  useEffect(() => {
    void loadPage(page)
  }, [loadPage, page, refreshToken, changeNonce])

  useEffect(() => {
    return window.agentswitch.usage.onRequestLogsChanged(() => {
      setChangeNonce((n) => n + 1)
    })
  }, [])

  const totalPages = useMemo(() => getTotalPages(pageMeta.filteredTotal, pageSize), [pageMeta.filteredTotal, pageSize])
  const pageRange = useMemo(() => getPageRange(page, pageSize, pageMeta.filteredTotal), [page, pageSize, pageMeta.filteredTotal])
  const pageTokens = useMemo(() => buildPageTokens(page, totalPages), [page, totalPages])
  const visibleCols = useMemo(() => REQUEST_LOG_COLUMNS.filter((c) => columns[c.key]), [columns])

  const goToPage = (nextPage: number) => {
    const clamped = clampPage(nextPage, totalPages)
    setJumpInput('')
    if (clamped === page) return
    resetScrollAndCloseDetail()
    setPage(clamped)
  }

  const handleEngineChange = (val: ProfileKind | '') => {
    resetScrollAndCloseDetail()
    setEngineFilter(val)
    setPage(1)
  }

  const handleModelChange = (val: string) => {
    resetScrollAndCloseDetail()
    setModelFilter(val)
    setPage(1)
  }

  const handleStatusChange = (val: RequestLogStatusFilter) => {
    resetScrollAndCloseDetail()
    setStatusFilter(val)
    setPage(1)
  }

  const handlePageSizeChange = (raw: string) => {
    const next = Number(raw) as RequestLogPageSize
    if (!PAGE_SIZE_OPTIONS.includes(next)) return
    savePageSize(next)
    resetScrollAndCloseDetail()
    setPageSize(next)
    setPage(1)
  }

  const handleJumpSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    const parsed = Number.parseInt(jumpInput.trim(), 10)
    if (!Number.isFinite(parsed)) {
      setJumpInput('')
      return
    }
    goToPage(parsed)
  }

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
    <div className="flex min-h-0 flex-1 flex-col px-8 pt-4 pb-5 [container-type:size]">
      {/* Toolbar: filters on left, column customizer on right */}
      <div className="mb-3 flex shrink-0 flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          {/* Engine filter */}
          <div className="relative">
            <select
              aria-label={t('reqLog.filterEngine')}
              value={engineFilter}
              onChange={(e) => handleEngineChange((e.target.value as ProfileKind) || '')}
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
              onChange={(e) => handleModelChange(e.target.value)}
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
              onChange={(e) => handleStatusChange(parseStatusOption(e.target.value))}
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
        </div>

        {/* Column visibility menu (no backdrop blur) */}
        <div ref={colMenuRef} className="relative">
          <button
            type="button"
            onClick={() => setColMenuOpen((o) => !o)}
            className={`flex h-7 items-center gap-1.5 rounded-lg border px-2.5 text-[12px] font-medium transition-colors ${
              colMenuOpen
                ? 'border-black/[0.16] bg-black/[0.04] text-ink dark:border-white/[0.18] dark:bg-white/[0.06]'
                : 'border-black/[0.09] bg-surface text-ink-2 shadow-[0_1px_2px_rgba(0,0,0,0.03)] hover:text-ink dark:border-white/[0.12]'
            }`}
          >
            <IconSliders size={12} />
            {t('reqLog.columns')}
            <IconChevronDown size={11} />
          </button>
          {colMenuOpen && (
            <div className="absolute top-full right-0 z-40 mt-1.5 w-52 rounded-xl border border-editor-hairline bg-elevated p-1.5 shadow-[0_12px_32px_rgba(0,0,0,0.14)]">
              <div className="flex items-center justify-between px-2 py-1 text-[11px] font-medium text-ink-3">
                <span>{t('reqLog.columnsTitle')}</span>
                <button type="button" onClick={resetColumns} className="text-accent hover:underline">
                  {t('reqLog.columnsReset')}
                </button>
              </div>
              <div className="max-h-[min(18rem,max(2rem,calc(100cqh-7rem)))] overflow-y-auto py-0.5">
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

      {/* Scrollable dense table + fixed bottom pagination bar */}
      <div className={`flex min-h-0 flex-1 flex-col overflow-hidden ${CARD}`}>
        <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto">
          <table className="w-full border-collapse text-[12.5px]">
            <thead className="text-[11.5px] text-ink-3 [&_th]:sticky [&_th]:top-0 [&_th]:z-10 [&_th]:bg-surface-2 [&_th]:shadow-[inset_0_-1px_var(--hairline)]">
              <tr>
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
            <tbody className={loading && entries.length > 0 ? 'pointer-events-none opacity-50 transition-opacity' : 'transition-opacity'}>
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
                            <td key={col.key} className="px-2.5 py-2 whitespace-nowrap">
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
                            <td key={col.key} className="max-w-[180px] truncate px-2.5 py-2 whitespace-nowrap text-ink-2" title={entry.provider}>
                              {entry.provider}
                            </td>
                          )
                        case 'model':
                          return (
                            <td key={col.key} className="max-w-[280px] truncate px-2.5 py-2 font-mono text-[11.5px] whitespace-nowrap text-ink" title={entry.model || '—'}>
                              {entry.model || '—'}
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

        {/* Fixed bottom pagination bar */}
        <div className="flex shrink-0 flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t border-hairline bg-surface-2/60 px-3.5 py-2 text-[12px] dark:bg-white/[0.02]">
          <div className="flex items-center gap-2 text-ink-3 tabular-nums">
            <span>
              {pageMeta.filteredTotal > 0
                ? t('reqLog.pageRange', {
                    start: pageRange.start.toLocaleString(),
                    end: pageRange.end.toLocaleString(),
                    total: pageMeta.filteredTotal.toLocaleString()
                  })
                : t('reqLog.pageEmpty')}
            </span>
            {loading && entries.length > 0 && <Spinner size={12} className="text-ink-3" />}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {/* Page size selector */}
            <div className="relative">
              <select
                aria-label={t('reqLog.perPage')}
                value={pageSize}
                onChange={(e) => handlePageSizeChange(e.target.value)}
                className={SELECT_CLS + ' appearance-none tabular-nums'}
              >
                {PAGE_SIZE_OPTIONS.map((size) => (
                  <option key={size} value={size}>
                    {t('reqLog.perPageOption', { n: size })}
                  </option>
                ))}
              </select>
              <IconChevronDown size={12} className="pointer-events-none absolute top-1/2 right-2 -translate-y-1/2 text-ink-3" />
            </div>

            {/* Page navigation buttons */}
            <nav aria-label="Pagination" className="flex items-center gap-1">
              <button
                type="button"
                disabled={page <= 1 || loading}
                onClick={() => goToPage(page - 1)}
                className="inline-flex h-7 items-center gap-0.5 rounded-lg border border-black/[0.09] bg-surface px-2 text-[12px] font-medium text-ink-2 shadow-[0_1px_2px_rgba(0,0,0,0.03)] transition-colors hover:bg-black/[0.03] hover:text-ink disabled:pointer-events-none disabled:opacity-45 dark:border-white/[0.12] dark:hover:bg-white/[0.06]"
              >
                <IconChevronLeft size={12} />
                <span>{t('reqLog.prevPage')}</span>
              </button>

              <div className="flex items-center gap-0.5">
                {pageTokens.map((tok) =>
                  typeof tok === 'number' ? (
                    <button
                      key={tok}
                      type="button"
                      disabled={loading && tok !== page}
                      aria-current={tok === page ? 'page' : undefined}
                      onClick={() => goToPage(tok)}
                      className={`h-7 min-w-7 rounded-lg px-2 text-[12px] tabular-nums transition-colors ${
                        tok === page
                          ? 'bg-accent font-medium text-white shadow-[0_1px_2px_rgba(0,0,0,0.08)]'
                          : 'text-ink-2 hover:bg-black/[0.05] hover:text-ink disabled:pointer-events-none disabled:opacity-50 dark:hover:bg-white/[0.08]'
                      }`}
                    >
                      {tok}
                    </button>
                  ) : (
                    <span key={tok} className="px-1 text-ink-3 select-none" aria-hidden="true">
                      …
                    </span>
                  )
                )}
              </div>

              <button
                type="button"
                disabled={page >= totalPages || loading}
                onClick={() => goToPage(page + 1)}
                className="inline-flex h-7 items-center gap-0.5 rounded-lg border border-black/[0.09] bg-surface px-2 text-[12px] font-medium text-ink-2 shadow-[0_1px_2px_rgba(0,0,0,0.03)] transition-colors hover:bg-black/[0.03] hover:text-ink disabled:pointer-events-none disabled:opacity-45 dark:border-white/[0.12] dark:hover:bg-white/[0.06]"
              >
                <span>{t('reqLog.nextPage')}</span>
                <IconChevronRight size={12} />
              </button>
            </nav>

            {/* Compact page jump input when totalPages > 7 */}
            {totalPages > 7 && (
              <form onSubmit={handleJumpSubmit} className="flex items-center gap-1.5 pl-0.5">
                <span className="text-[11.5px] text-ink-3">{t('reqLog.jumpTo')}</span>
                <input
                  type="text"
                  inputMode="numeric"
                  aria-label={t('reqLog.jumpPageLabel')}
                  value={jumpInput}
                  onChange={(e) => setJumpInput(e.target.value.replace(/[^\d]/g, ''))}
                  placeholder={String(page)}
                  className="h-7 w-12 rounded-lg border border-black/[0.09] bg-surface px-1.5 text-center font-mono text-[12px] text-ink tabular-nums shadow-[0_1px_2px_rgba(0,0,0,0.03)] outline-none focus:border-accent dark:border-white/[0.12]"
                />
              </form>
            )}
          </div>
        </div>
      </div>

      {selected && <RequestLogDetail entry={selected} onClose={() => setSelected(null)} onJumpThread={handleJumpThread} />}
    </div>
  )
}
