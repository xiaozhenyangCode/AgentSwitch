/**
 * Scrolling inside the message list only. `scrollIntoView()` also scrolls every scrollable
 * ancestor (the page, the main column…), which shoves the composer off the window bottom; these
 * helpers move just the nearest `[data-scroller]` element.
 */
export function scrollerOf(el: Element | null): HTMLElement | null {
  return el?.closest<HTMLElement>('[data-scroller]') ?? null
}

/** Scroll the list so `el`'s top sits `gap` px under the list's top edge. */
export function scrollListTo(el: Element | null, { gap = 16, smooth = true, onlyIfAbove = false }: { gap?: number; smooth?: boolean; onlyIfAbove?: boolean } = {}) {
  const sc = scrollerOf(el)
  if (!el || !sc) return
  const d = el.getBoundingClientRect().top - sc.getBoundingClientRect().top - gap
  if (onlyIfAbove && d >= 0) return
  sc.scrollTo({ top: Math.max(0, sc.scrollTop + d), behavior: smooth ? 'smooth' : 'auto' })
}
