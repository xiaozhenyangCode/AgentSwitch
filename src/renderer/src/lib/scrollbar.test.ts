import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_SCROLL_HIDE_DELAY_MS,
  SCROLLING_ATTR,
  createScrollActivityHandler,
  installAutoHideScrollbars,
  isScrollableElement,
  type ScrollableElementLike
} from './scrollbar'

function makeFakeElement(dims: { scrollHeight: number; clientHeight: number; scrollWidth?: number; clientWidth?: number }) {
  const attrs = new Map<string, string>()
  const setAttribute = vi.fn((k: string, v: string) => {
    attrs.set(k, v)
  })
  const removeAttribute = vi.fn((k: string) => {
    attrs.delete(k)
  })
  const el: ScrollableElementLike = {
    scrollHeight: dims.scrollHeight,
    clientHeight: dims.clientHeight,
    scrollWidth: dims.scrollWidth ?? 100,
    clientWidth: dims.clientWidth ?? 100,
    getAttribute: (k) => attrs.get(k) ?? null,
    setAttribute,
    removeAttribute
  }
  return { el, attrs, setAttribute, removeAttribute }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('scrollbar auto-hide controller', () => {
  it('detects only genuinely overflowing elements', () => {
    const flat = makeFakeElement({ scrollHeight: 200, clientHeight: 200, scrollWidth: 300, clientWidth: 300 })
    const vertical = makeFakeElement({ scrollHeight: 420, clientHeight: 200 })
    const horizontal = makeFakeElement({ scrollHeight: 40, clientHeight: 40, scrollWidth: 500, clientWidth: 300 })

    expect(isScrollableElement(null)).toBe(false)
    expect(isScrollableElement({})).toBe(false)
    expect(isScrollableElement(flat.el)).toBe(false)
    expect(isScrollableElement(vertical.el)).toBe(true)
    expect(isScrollableElement(horizontal.el)).toBe(true)
  })

  it('marks overflowing containers during scroll and clears after inactivity delay', () => {
    vi.useFakeTimers()
    const handler = createScrollActivityHandler(DEFAULT_SCROLL_HIDE_DELAY_MS)
    const { el, attrs, setAttribute, removeAttribute } = makeFakeElement({ scrollHeight: 600, clientHeight: 200 })

    handler({ target: el as unknown as EventTarget })
    expect(attrs.get(SCROLLING_ATTR)).toBe('true')
    expect(setAttribute).toHaveBeenCalledTimes(1)

    // Subsequent scroll events before timeout debounce without redundant DOM writes
    vi.advanceTimersByTime(500)
    handler({ target: el as unknown as EventTarget })
    expect(setAttribute).toHaveBeenCalledTimes(1)
    expect(removeAttribute).not.toHaveBeenCalled()

    // Still visible 500ms after second scroll (total 1000ms from first)
    vi.advanceTimersByTime(500)
    expect(attrs.get(SCROLLING_ATTR)).toBe('true')

    // Hidden once full inactivity delay elapses after last scroll
    vi.advanceTimersByTime(DEFAULT_SCROLL_HIDE_DELAY_MS - 500)
    expect(attrs.has(SCROLLING_ATTR)).toBe(false)
    expect(removeAttribute).toHaveBeenCalledTimes(1)
  })

  it('ignores non-scrollable targets and manages multiple containers independently', () => {
    vi.useFakeTimers()
    const handler = createScrollActivityHandler(800)
    const flat = makeFakeElement({ scrollHeight: 120, clientHeight: 120 })
    const a = makeFakeElement({ scrollHeight: 500, clientHeight: 200 })
    const b = makeFakeElement({ scrollHeight: 100, clientHeight: 100, scrollWidth: 400, clientWidth: 200 })

    handler({ target: flat.el as unknown as EventTarget })
    expect(flat.setAttribute).not.toHaveBeenCalled()

    handler({ target: a.el as unknown as EventTarget })
    vi.advanceTimersByTime(400)
    handler({ target: b.el as unknown as EventTarget })

    vi.advanceTimersByTime(400)
    expect(a.attrs.has(SCROLLING_ATTR)).toBe(false)
    expect(b.attrs.get(SCROLLING_ATTR)).toBe('true')

    vi.advanceTimersByTime(400)
    expect(b.attrs.has(SCROLLING_ATTR)).toBe(false)
  })

  it('registers capture-phase passive scroll listener and cleans up properly', () => {
    const addEventListener = vi.fn()
    const removeEventListener = vi.fn()
    const dispose = installAutoHideScrollbars({ addEventListener, removeEventListener })

    expect(addEventListener).toHaveBeenCalledWith('scroll', expect.any(Function), { capture: true, passive: true })
    dispose()
    expect(removeEventListener).toHaveBeenCalledWith('scroll', addEventListener.mock.calls[0][1], { capture: true })
  })
})
