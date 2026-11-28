import { useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { t } from '../state/i18n'
import { scrollListTo } from '../lib/scrollList'

const FADE_H = 64
const reducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false

/**
 * Long content clipped to `collapsedHeight` with a soft fade and a 展开全部 / 收起 text link
 * right under it (X / Twitter style). No height animation: expanding releases the height at
 * once and the newly revealed part fades in (opacity only, no per-frame layout); collapsing
 * snaps back, and if the top of the message has scrolled above the list it realigns the
 * message list itself — never `scrollIntoView`, which would also move outer containers.
 */
export function CollapsibleBody({
  children,
  threshold,
  collapsedHeight,
  defaultOpen = false,
  disabled = false,
  tone = 'plain',
  anchor,
  className = ''
}: {
  children: ReactNode
  /** Content taller than this (px) becomes foldable. */
  threshold: number
  collapsedHeight: number
  defaultOpen?: boolean
  /** e.g. while streaming: always shown in full, no toggle. */
  disabled?: boolean
  /** On the accent user bubble or on the page background (fade colour + link colour). */
  tone?: 'bubble' | 'plain'
  /** Element realigned to the list top when collapsing hides it. */
  anchor?: RefObject<HTMLElement | null>
  className?: string
}) {
  const box = useRef<HTMLDivElement>(null)
  const inner = useRef<HTMLDivElement>(null)
  const [long, setLong] = useState(false)
  const [open, setOpen] = useState(defaultOpen)
  /** Expanding: the overlay is fading out over the newly revealed part. */
  const [fading, setFading] = useState(false)
  const realign = useRef(false)

  useLayoutEffect(() => {
    const el = inner.current
    if (!el) return
    const check = () => setLong(el.offsetHeight > threshold)
    check()
    const ro = new ResizeObserver(check)
    ro.observe(el)
    return () => ro.disconnect()
  }, [threshold])

  // after the collapse is laid out, before paint: bring the message top back if it is above the list
  useLayoutEffect(() => {
    if (open || !realign.current) return
    realign.current = false
    scrollListTo(anchor?.current ?? box.current, { smooth: false, onlyIfAbove: true })
  }, [open, anchor])

  const active = long && !disabled
  const toggle = () => {
    if (open) {
      realign.current = true
      setFading(false)
      setOpen(false)
    } else {
      setOpen(true)
      setFading(!reducedMotion())
    }
  }

  const color = tone === 'bubble' ? 'var(--accent)' : 'var(--chat-canvas)'
  const link = tone === 'bubble' ? 'text-white/90 hover:text-white' : 'text-accent hover:text-accent-hover'

  return (
    <div className={className}>
      <div ref={box} className="relative" style={active && !open ? { height: collapsedHeight, overflow: 'hidden' } : undefined}>
        <div ref={inner}>{children}</div>
        {/* collapsed: the visible part is just the fade at the cut; expanding: also covers the
            revealed rest in the background colour and fades out — a pure opacity animation */}
        {active && (!open || fading) && (
          <div
            className={`pointer-events-none absolute inset-x-0 bottom-0 ${fading ? 'cb-reveal' : ''}`}
            style={{ top: Math.max(0, collapsedHeight - FADE_H), background: `linear-gradient(to bottom, transparent, ${color} ${FADE_H}px)` }}
            onAnimationEnd={() => setFading(false)}
          />
        )}
      </div>
      {active && (
        <div className={tone === 'bubble' ? 'px-4 pb-2.5' : 'mt-1.5'}>
          <button onClick={toggle} aria-expanded={open} className={`text-[13px] font-medium transition-colors hover:underline ${link}`}>
            {open ? t('wb.collapse') : t('wb.expandAll')}
          </button>
        </div>
      )}
    </div>
  )
}
