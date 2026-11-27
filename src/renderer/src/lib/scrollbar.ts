export const SCROLLING_ATTR = 'data-scrolling'
export const DEFAULT_SCROLL_HIDE_DELAY_MS = 900

export interface ScrollableElementLike {
  scrollHeight: number
  clientHeight: number
  scrollWidth: number
  clientWidth: number
  getAttribute(name: string): string | null
  setAttribute(name: string, value: string): void
  removeAttribute(name: string): void
}

export function isScrollableElement(target: unknown): target is ScrollableElementLike {
  if (!target || typeof target !== 'object') return false
  if (typeof HTMLElement !== 'undefined' && !(target instanceof HTMLElement)) return false
  const el = target as Partial<ScrollableElementLike>
  if (
    typeof el.scrollHeight !== 'number' ||
    typeof el.clientHeight !== 'number' ||
    typeof el.scrollWidth !== 'number' ||
    typeof el.clientWidth !== 'number' ||
    typeof el.getAttribute !== 'function' ||
    typeof el.setAttribute !== 'function' ||
    typeof el.removeAttribute !== 'function'
  ) {
    return false
  }
  return el.scrollHeight > el.clientHeight || el.scrollWidth > el.clientWidth
}

export function createScrollActivityHandler(hideDelayMs = DEFAULT_SCROLL_HIDE_DELAY_MS): (event: Pick<Event, 'target'>) => void {
  const timers = new WeakMap<ScrollableElementLike, ReturnType<typeof setTimeout>>()

  return (event) => {
    const target = event.target
    if (!isScrollableElement(target)) return

    if (target.getAttribute(SCROLLING_ATTR) !== 'true') {
      target.setAttribute(SCROLLING_ATTR, 'true')
    }

    const prev = timers.get(target)
    if (prev !== undefined) clearTimeout(prev)

    const timer = setTimeout(() => {
      timers.delete(target)
      target.removeAttribute(SCROLLING_ATTR)
    }, hideDelayMs)
    timers.set(target, timer)
  }
}

export function installAutoHideScrollbars(
  target: Pick<Document, 'addEventListener' | 'removeEventListener'> | null = typeof document !== 'undefined' ? document : null,
  hideDelayMs = DEFAULT_SCROLL_HIDE_DELAY_MS
): () => void {
  if (!target) return () => {}
  const handler = createScrollActivityHandler(hideDelayMs)
  target.addEventListener('scroll', handler, { capture: true, passive: true })
  return () => {
    target.removeEventListener('scroll', handler, { capture: true })
  }
}
