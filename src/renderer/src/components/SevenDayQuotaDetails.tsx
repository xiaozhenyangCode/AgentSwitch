import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { AccountWindowLogSummary } from '@shared/types'
import { useLayer } from '../lib/escStack'
import { formatSevenDayEstimateTime, type SevenDayEstimate } from '../lib/sevenDayEstimate'
import { currentLocale, t } from '../state/i18n'
import { fmtCost } from '../state/usage'

function describeEstimate(estimate: SevenDayEstimate, now: number): string {
  switch (estimate.status) {
    case 'within_limit': return t('usage.estimateWithinDetail', { pct: estimate.projectedPct })
    case 'will_deplete': return t('usage.estimateDepleteDetail', {
      time: formatSevenDayEstimateTime(estimate.depleteAt, now, currentLocale(), true)
    })
    case 'unavailable': return t('usage.estimateUnavailable')
    case 'depleted': return t('usage.estimateDepleted')
    case 'no_local_logs': return t('usage.estimateNoLogs')
    case 'insufficient_sample': return t('usage.estimateInsufficient')
  }
}

export function SevenDayQuotaDetails({ estimate, summary, now, children }: {
  estimate: SevenDayEstimate
  summary?: AccountWindowLogSummary
  now: number
  children: ReactNode
}) {
  const id = useId()
  const anchor = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const hideTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const [mode, setMode] = useState<'peek' | 'pinned' | null>(null)
  const [position, setPosition] = useState<CSSProperties>({})
  const open = mode !== null

  const cancelHide = () => clearTimeout(hideTimer.current)
  const close = useCallback(() => {
    clearTimeout(hideTimer.current)
    setMode(null)
  }, [])
  const peek = () => {
    cancelHide()
    setMode((value) => value ?? 'peek')
  }
  const leave = () => {
    cancelHide()
    hideTimer.current = setTimeout(() => setMode((value) => value === 'peek' ? null : value), 140)
  }
  useLayer({ onEsc: close, onClose: close, active: open })
  useEffect(() => () => clearTimeout(hideTimer.current), [])

  useLayoutEffect(() => {
    if (!open || !anchor.current || !panel.current) return
    const { right, top, bottom } = anchor.current.getBoundingClientRect()
    const edge = 8
    const gap = 6
    const above = top - edge - gap
    const below = window.innerHeight - bottom - edge - gap
    const flip = panel.current.scrollHeight + 2 > below && above > below
    const width = panel.current.offsetWidth
    setPosition({
      left: Math.max(edge, Math.min(right - width, window.innerWidth - width - edge)),
      ...(flip ? { bottom: window.innerHeight - top + gap } : { top: bottom + gap }),
      maxHeight: Math.max(0, flip ? above : below)
    })
  }, [open, estimate, summary, now])

  useEffect(() => {
    if (!open) return
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !anchor.current?.contains(event.target) && !panel.current?.contains(event.target)) close()
    }
    const scroll = (event: Event) => {
      if (!(event.target instanceof Node) || !panel.current?.contains(event.target)) close()
    }
    document.addEventListener('pointerdown', outside, true)
    window.addEventListener('scroll', scroll, true)
    window.addEventListener('resize', close)
    window.addEventListener('blur', close)
    return () => {
      document.removeEventListener('pointerdown', outside, true)
      window.removeEventListener('scroll', scroll, true)
      window.removeEventListener('resize', close)
      window.removeEventListener('blur', close)
    }
  }, [open, close])

  const tokens = summary && ('basis' in estimate ? estimate.basis === 'tokens' : summary.windowCost <= 0 && summary.windowTokens > 0)
  const formatWeight = (cost: number, count: number) => tokens
    ? t('usage.estimateTokenCount', { n: count.toLocaleString(currentLocale()) })
    : fmtCost(cost)

  return (
    <>
      <button ref={anchor} type="button" aria-expanded={open} aria-controls={open ? id : undefined}
        className="block w-full min-w-0 rounded-sm text-left focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-accent/60"
        onPointerEnter={(event) => { if (event.pointerType === 'mouse') peek() }}
        onPointerLeave={(event) => { if (event.pointerType === 'mouse') leave() }}
        onFocus={(event) => { if (event.currentTarget.matches(':focus-visible')) peek() }}
        onBlur={leave}
        onClick={() => {
          cancelHide()
          setMode((value) => value === 'pinned' ? null : 'pinned')
        }}
      >
        {children}
      </button>
      {open && createPortal(
        <div ref={panel} id={id} role="region" aria-labelledby={`${id}-title`}
          className="no-drag fixed z-[70] w-[288px] max-w-[calc(100vw-16px)] overflow-y-auto rounded-xl border border-editor-hairline bg-elevated px-3 py-2.5 text-[12px] leading-[1.5] tabular-nums shadow-[0_12px_32px_rgba(0,0,0,0.16)]"
          style={position} onPointerEnter={cancelHide} onPointerLeave={leave}>
          <p id={`${id}-title`} className="font-medium text-ink">{describeEstimate(estimate, now)}</p>
          {summary && (
            <div className="mt-1 space-y-0.5 text-ink-2">
              <p>{t(summary.windowRequestCount === 1 ? 'usage.estimateWindowSingle' : 'usage.estimateWindow', {
                weight: formatWeight(summary.windowCost, summary.windowTokens),
                n: summary.windowRequestCount.toLocaleString(currentLocale())
              })}</p>
              <p>{summary.last24hRequestCount > 0
                ? t('usage.estimateRecent', { weight: formatWeight(summary.last24hCost, summary.last24hTokens) })
                : t('usage.estimateRecentEmpty')}</p>
            </div>
          )}
          <p className="mt-2 border-t border-editor-hairline pt-2 text-[11.5px] text-ink-2">{t('usage.estimateScope')}</p>
        </div>,
        document.body
      )}
    </>
  )
}
