import { describe, expect, it } from 'vitest'
import { COMPOSER_MAX_HEIGHT, composerEscapeAction, nextComposerExpanded, showComposerExpand } from './composerExpand'

const padding = 24.5
const lineHeight = 22
const draftHeight = (lines: number) => Math.round(padding + lines * lineHeight)

describe('composer expand availability', () => {
  it.each([1, 2, 3, 4, 5])('keeps the control hidden at %i visual lines', (lines) => {
    const height = draftHeight(lines)
    expect(showComposerExpand({
      expanded: false, hasText: true, scrollHeight: height, clientHeight: height, padding, lineHeight
    })).toBe(false)
  })

  it('shows the control for visual wrapping beyond five lines before reaching the height cap', () => {
    const height = draftHeight(6)
    expect(height).toBeLessThan(COMPOSER_MAX_HEIGHT)
    expect(showComposerExpand({
      expanded: false, hasText: true, scrollHeight: height, clientHeight: height, padding, lineHeight
    })).toBe(true)
  })

  it('shows the control for real overflow even if the visual line threshold is not met', () => {
    const height = draftHeight(4)
    expect(showComposerExpand({
      expanded: false, hasText: true, scrollHeight: height, clientHeight: height - 2, padding, lineHeight
    })).toBe(true)
    expect(showComposerExpand({
      expanded: false, hasText: true, scrollHeight: height, clientHeight: height - 1, padding, lineHeight
    })).toBe(false)
  })

  it('keeps the collapse control visible for an empty expanded draft', () => {
    const metrics = { hasText: false, scrollHeight: 300, clientHeight: COMPOSER_MAX_HEIGHT, padding, lineHeight }
    expect(showComposerExpand({ ...metrics, expanded: true })).toBe(true)
    expect(showComposerExpand({ ...metrics, expanded: false })).toBe(false)
  })
})

describe('composer expansion and Escape', () => {
  const idle = { composing: false, higherLayer: false, extensionsOpen: false, mention: false, slash: false, ghost: false }

  it('toggles between editing modes and returns to compact after sending or switching threads', () => {
    expect(nextComposerExpanded(false, 'toggle')).toBe(true)
    expect(nextComposerExpanded(true, 'toggle')).toBe(false)
    expect(nextComposerExpanded(true, 'send')).toBe(false)
    expect(nextComposerExpanded(true, 'thread')).toBe(false)
    expect(nextComposerExpanded(true, 'escape')).toBe(false)
    expect(nextComposerExpanded(false, 'send')).toBe(false)
  })

  it('dismisses composer suggestions and completion before collapsing', () => {
    expect(composerEscapeAction({ ...idle, expanded: true, mention: true })).toBe('mention')
    expect(composerEscapeAction({ ...idle, expanded: true, slash: true })).toBe('slash')
    expect(composerEscapeAction({ ...idle, expanded: true, ghost: true })).toBe('ghost')
    expect(composerEscapeAction({ ...idle, expanded: true })).toBe('collapse')
    expect(composerEscapeAction({ ...idle, expanded: false, slash: true })).toBe('slash')
    expect(composerEscapeAction({ ...idle, expanded: false })).toBeNull()
  })

  it('leaves Escape with IME, the extensions panel, or the topmost registered layer', () => {
    const rollover = { ...idle, expanded: true, mention: true }
    expect(composerEscapeAction({ ...rollover, composing: true })).toBeNull()
    expect(composerEscapeAction({ ...rollover, extensionsOpen: true })).toBeNull()
    expect(composerEscapeAction({ ...rollover, higherLayer: true })).toBeNull()
  })
})
