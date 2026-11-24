import { describe, expect, it } from 'vitest'
import { budgetedHandoff, contextBudgetFor, estimateTokens, formatContext, selectContext, transcriptText } from './contextBudget'
import { numberTranscript, type TranscriptEntry } from './transcript'

const message = (text: string, assistant = false, details?: string): TranscriptEntry => ({
  id: text, turnId: 'turn', profileId: assistant ? 'claude' : null, speaker: assistant ? 'A' : 'U', time: null, text, details
})

describe('context budget', () => {
  it('estimates UTF-8 bytes conservatively and caps the budget at a quarter window', () => {
    expect(estimateTokens('abcd')).toBe(2)
    expect(estimateTokens('历史')).toBe(2)
    expect(estimateTokens('😀abc')).toBe(3)
    expect(estimateTokens('')).toBe(0)
    expect(contextBudgetFor()).toBe(16_000)
    expect(contextBudgetFor(32_003)).toBe(8_000)
    expect(contextBudgetFor(200_000)).toBe(16_000)
  })

  it('keeps every message of a small conversation verbatim', () => {
    const entries = numberTranscript([message('  第一个任务\n'), message('\n```ts\nconst a = 1\n```\n', true), message('第二个任务')])
    const result = selectContext(entries, 100)
    expect(result.items.map((item) => item.text)).toEqual(entries.map(transcriptText))
    expect(result.omitted).toEqual([])
    expect(budgetedHandoff(entries, 100, true, true).readable).toBe(false)
  })

  it('keeps the original and recent complete rounds ahead of shorter older results', () => {
    const entries = numberTranscript([
      message('原始需求'), message('a'.repeat(350), true, '审核结论：PASS'),
      message('之前的任务'.repeat(22)), message('b'.repeat(350), true, '产出文件：report.md'),
      message('最近的任务'), message('最新结果', true)
    ])
    const result = selectContext(entries, 140)
    expect(result.items.map(({ number, kind }) => [number, kind])).toEqual([
      [1, 'full'], [2, 'result'], [4, 'result'], [5, 'full'], [6, 'full']
    ])
    expect(result.items[2].text).toContain('产出文件：report.md')
    expect(result.omitted).toEqual([{ from: 2, to: 4 }])
    expect(formatContext(result, true)).toContain('第 2–4 条')
    expect(formatContext(result, false)).not.toContain('read_thread')
  })

  it('keeps the latest question before truncating a reply that exceeds the remaining space', () => {
    const entries = numberTranscript([message('first'), message('a'.repeat(100), true), message('b'.repeat(100)), message('c'.repeat(100), true)])
    const result = selectContext(entries, 70)
    expect(result.items.map(({ number, kind }) => [number, kind])).toEqual([[1, 'full'], [3, 'full'], [4, 'truncated']])
    expect(result.omitted).toEqual([{ from: 2, to: 2 }, { from: 4, to: 4 }])
  })

  it('keeps the latest question and prefers the latest of two long replies over older results', () => {
    const entries = numberTranscript([
      message('original'), message('early reply', true, '审核结论：PASS'),
      message('middle Q'), message('middle reply', true, '产出文件：report.md'),
      message('LATEST-Q'), message('a'.repeat(9_000), true),
      message('b'.repeat(9_000), true, '审核结论：REJECT')
    ])
    const result = selectContext(entries, 5_000)
    expect(result.items.map(({ number, kind }) => [number, kind])).toEqual([
      [1, 'full'], [5, 'full'], [6, 'truncated'], [7, 'full']
    ])
    expect(result.items[1].text).toBe(transcriptText(entries[4]))
    expect(result.items[3].text).toBe(transcriptText(entries[6]))
    expect(result.omitted).toEqual([{ from: 2, to: 4 }, { from: 6, to: 6 }])
    const rendered = budgetedHandoff(entries, 5_000, true, true)
    expect(rendered.text).toContain('LATEST-Q')
    expect(rendered.text).toContain('审核结论：REJECT')
    const used = estimateTokens(rendered.text)
    expect(used).toBeGreaterThan(4_950)
    expect(used).toBeLessThanOrEqual(5_000)
  })

  it('truncates an oversized single message from the end without breaking Unicode', () => {
    const entries = numberTranscript([message('原始需求🙂'.repeat(300))])
    const result = selectContext(entries, 80)
    expect(result.items[0]).toMatchObject({ number: 1, kind: 'truncated' })
    expect(transcriptText(entries[0]).startsWith(result.items[0].text)).toBe(true)
    expect(result.items[0].text).not.toContain('�')
    expect(result.omitted).toEqual([{ from: 1, to: 1 }])
    const rendered = budgetedHandoff(entries, 150, true, true)
    expect(rendered.readable).toBe(true)
    expect(rendered.text).toContain('已截断，可用 read_thread 读取全文')
    expect(estimateTokens(rendered.text)).toBeLessThanOrEqual(150)
  })

  it('truncates an oversized latest reply when resuming and preserves absolute ranges', () => {
    const entries = numberTranscript([message('ignored'), message('older'), message('new'), message('长回复'.repeat(150), true)]).slice(1)
    const result = selectContext(entries, 60, false)
    expect(result.items.map(({ number, kind }) => [number, kind])).toEqual([[3, 'full'], [4, 'truncated']])
    expect(result.omitted).toEqual([{ from: 2, to: 2 }, { from: 4, to: 4 }])
    expect(budgetedHandoff(entries, 150, false, false)).toMatchObject({ readable: false })
  })
})
