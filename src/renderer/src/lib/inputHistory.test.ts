import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadInputHistory, pushInputHistory, stepInputHistory, type HistoryCursor } from './inputHistory'

function createMemoryStorage() {
  const map = new Map<string, string>()
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      map.set(key, value)
    },
    removeItem: (key: string) => {
      map.delete(key)
    },
    clear: () => map.clear()
  }
}

describe('inputHistory storage', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', createMemoryStorage())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('persists entries, deduplicates adjacent repeats, ignores blanks, and caps at 100', () => {
    expect(loadInputHistory()).toEqual([])
    pushInputHistory('   ')
    expect(loadInputHistory()).toEqual([])

    pushInputHistory('first')
    pushInputHistory('first')
    pushInputHistory('second')
    pushInputHistory('first')
    expect(loadInputHistory()).toEqual(['first', 'second', 'first'])

    for (let i = 0; i < 120; i++) pushInputHistory(`item-${i}`)
    const list = loadInputHistory()
    expect(list).toHaveLength(100)
    expect(list[0]).toBe('item-20')
    expect(list[list.length - 1]).toBe('item-119')
  })
})

describe('stepInputHistory navigation boundaries', () => {
  const history = ['first', 'second', 'third']

  it('recalls newest on ArrowUp from empty input, clamps at oldest, and restores draft on ArrowDown', () => {
    let cursor: HistoryCursor | null = null
    let value = ''

    const up1 = stepInputHistory({ key: 'ArrowUp', value, selectionStart: 0, selectionEnd: 0, history, cursor })
    expect(up1).toEqual({ handled: true, text: 'third', cursor: { idx: 2, saved: '' } })
    value = up1.text!
    cursor = up1.cursor

    const up2 = stepInputHistory({ key: 'ArrowUp', value, selectionStart: value.length, selectionEnd: value.length, history, cursor })
    expect(up2).toEqual({ handled: true, text: 'second', cursor: { idx: 1, saved: '' } })
    value = up2.text!
    cursor = up2.cursor

    const up3 = stepInputHistory({ key: 'ArrowUp', value, selectionStart: value.length, selectionEnd: value.length, history, cursor })
    expect(up3).toEqual({ handled: true, text: 'first', cursor: { idx: 0, saved: '' } })
    value = up3.text!
    cursor = up3.cursor

    // Clamps at oldest cleanly
    const up4 = stepInputHistory({ key: 'ArrowUp', value, selectionStart: value.length, selectionEnd: value.length, history, cursor })
    expect(up4).toEqual({ handled: true, cursor: { idx: 0, saved: '' } })

    const down1 = stepInputHistory({ key: 'ArrowDown', value, selectionStart: value.length, selectionEnd: value.length, history, cursor })
    expect(down1).toEqual({ handled: true, text: 'second', cursor: { idx: 1, saved: '' } })
    value = down1.text!
    cursor = down1.cursor

    const down2 = stepInputHistory({ key: 'ArrowDown', value, selectionStart: value.length, selectionEnd: value.length, history, cursor })
    expect(down2).toEqual({ handled: true, text: 'third', cursor: { idx: 2, saved: '' } })
    value = down2.text!
    cursor = down2.cursor

    const down3 = stepInputHistory({ key: 'ArrowDown', value, selectionStart: value.length, selectionEnd: value.length, history, cursor })
    expect(down3).toEqual({ handled: true, text: '', cursor: null })
  })

  it('preserves and restores an unsent single-line draft', () => {
    const draft = 'work in progress'
    const up = stepInputHistory({ key: 'ArrowUp', value: draft, selectionStart: 0, selectionEnd: 0, history, cursor: null })
    expect(up).toEqual({ handled: true, text: 'third', cursor: { idx: 2, saved: draft } })
    const down = stepInputHistory({
      key: 'ArrowDown',
      value: up.text!,
      selectionStart: up.text!.length,
      selectionEnd: up.text!.length,
      history,
      cursor: up.cursor
    })
    expect(down).toEqual({ handled: true, text: draft, cursor: null })
  })

  it('does not intercept when navigating inside multiline text or when text is selected', () => {
    const multi = 'line 1\nline 2\nline 3'
    const midPos = 'line 1\nli'.length
    // Middle line: neither ArrowUp nor ArrowDown should intercept
    expect(stepInputHistory({ key: 'ArrowUp', value: multi, selectionStart: midPos, selectionEnd: midPos, history, cursor: null }).handled).toBe(false)
    expect(
      stepInputHistory({ key: 'ArrowDown', value: multi, selectionStart: midPos, selectionEnd: midPos, history, cursor: { idx: 1, saved: '' } }).handled
    ).toBe(false)

    // First line ArrowUp is allowed
    expect(stepInputHistory({ key: 'ArrowUp', value: multi, selectionStart: 3, selectionEnd: 3, history, cursor: null })).toEqual({
      handled: true,
      text: 'third',
      cursor: { idx: 2, saved: multi }
    })
    // Last line ArrowDown while browsing is allowed
    expect(
      stepInputHistory({
        key: 'ArrowDown',
        value: multi,
        selectionStart: multi.length,
        selectionEnd: multi.length,
        history,
        cursor: { idx: 2, saved: 'saved' }
      })
    ).toEqual({
      handled: true,
      text: 'saved',
      cursor: null
    })

    // Active selection should never intercept
    expect(stepInputHistory({ key: 'ArrowUp', value: 'hello', selectionStart: 0, selectionEnd: 3, history, cursor: null }).handled).toBe(false)
    // ArrowDown when not browsing should never intercept
    expect(stepInputHistory({ key: 'ArrowDown', value: '', selectionStart: 0, selectionEnd: 0, history, cursor: null }).handled).toBe(false)
    // Empty history should never intercept
    expect(stepInputHistory({ key: 'ArrowUp', value: '', selectionStart: 0, selectionEnd: 0, history: [], cursor: null }).handled).toBe(false)
  })
})
