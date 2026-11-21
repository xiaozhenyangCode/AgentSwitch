import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { t } from '../state/i18n'
import { IconChevronDown } from './icons'

const DURATION = 240
const EASE = 'cubic-bezier(0.22, 1, 0.36, 1)'
const reducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false

/**
 * Long content folded to `collapsedHeight` with a fade at the bottom and an 展开全部 / 收起
 * toggle. Height animates from the real scrollHeight; once expanded the height is released
 * (`auto`) so late-loading images, diagrams or opened code blocks are never clipped, and
 * collapsing first locks the current height so it animates back just as smoothly.
 */
export function CollapsibleBody({
  children,
  threshold,
  collapsedHeight,
  defaultOpen = false,
  disabled = false,
  fadeClass,
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
  /** Gradient into the surrounding background, e.g. `to-accent` / `to-canvas`. */
  fadeClass: string
  /** Toggle colours: on an accent bubble or on the page. */
  tone?: 'bubble' | 'plain'
  /** Element scrolled back into view when collapsing hides its top. */
  anchor?: RefObject<HTMLElement | null>
  className?: string
}) {
  const box = useRef<HTMLDivElement>(null)
  const inner = useRef<HTMLDivElement>(null)
  const [long, setLong] = useState(false)
  const [open, setOpen] = useState(defaultOpen)
  /** Explicit height while animating (null: natural / collapsed by `open`). */
  const [h, setH] = useState<number | null>(null)
  const [anim, setAnim] = useState(false)
  const done = useRef<ReturnType<typeof setTimeout> | null>(null)

  useLayoutEffect(() => {
    const el = inner.current
    if (!el) return
    const check = () => setLong(el.offsetHeight > threshold)
    check()
    const ro = new ResizeObserver(check)
    ro.observe(el)
    return () => ro.disconnect()
  }, [threshold])
  useEffect(() => () => void (done.current && clearTimeout(done.current)), [])

  const active = long && !disabled
  const finish = () => {
    if (done.current) clearTimeout(done.current)
    done.current = null
    setAnim(false)
    setH(null)
  }
  // fallback when transitionend never fires (hidden tab, interrupted transition)
  const armFallback = () => {
    if (done.current) clearTimeout(done.current)
    done.current = setTimeout(finish, DURATION + 120)
  }

  const toggle = () => {
    const full = inner.current?.offsetHeight ?? 0
    if (reducedMotion()) {
      setOpen((o) => !o)
      return
    }
    if (!open) {
      // collapsed -> full content height, then release to auto
      setH(collapsedHeight)
      requestAnimationFrame(() => {
        setAnim(true)
        setH(full)
        setOpen(true)
        armFallback()
      })
    } else {
      // lock the current height first so the collapse animates from where it is
      setAnim(false)
      setH(box.current?.offsetHeight ?? full)
      const top = (anchor?.current ?? box.current)?.getBoundingClientRect().top ?? 0
      if (top < 64) (anchor?.current ?? box.current)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          setAnim(true)
          setH(collapsedHeight)
          setOpen(false)
          armFallback()
        })
      )
    }
  }

  const style = !active
    ? undefined
    : h !== null
      ? { height: h, overflow: 'hidden' as const, transition: anim ? `height ${DURATION}ms ${EASE}` : undefined }
      : !open
        ? { height: collapsedHeight, overflow: 'hidden' as const }
        : undefined

  const btn =
    tone === 'bubble'
      ? 'text-white/85 hover:bg-white/15 hover:text-white'
      : 'text-ink-3 hover:bg-black/[0.05] hover:text-ink dark:hover:bg-white/[0.07]'

  return (
    <div className={className}>
      <div ref={box} className="relative" style={style} onTransitionEnd={(e) => e.target === box.current && e.propertyName === 'height' && finish()}>
        <div ref={inner}>{children}</div>
        {active && (
          <div
            className={`pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-gradient-to-b from-transparent ${fadeClass} transition-opacity ease-out motion-reduce:transition-none ${open ? 'opacity-0' : 'opacity-100'}`}
            style={{ transitionDuration: `${DURATION}ms` }}
          />
        )}
      </div>
      {active && (
        <div className={`flex ${tone === 'bubble' ? 'justify-end px-2 pb-1.5' : 'mt-1'}`}>
          <button onClick={toggle} aria-expanded={open} className={`flex h-6 items-center gap-1 rounded-full px-2 text-[12px] font-medium transition-colors ${btn}`}>
            {open ? t('wb.collapse') : t('wb.expandAll')}
            <IconChevronDown size={12} className="transition-transform motion-reduce:transition-none" style={{ transform: open ? 'rotate(180deg)' : undefined, transitionDuration: `${DURATION}ms`, transitionTimingFunction: EASE }} />
          </button>
        </div>
      )}
    </div>
  )
}
