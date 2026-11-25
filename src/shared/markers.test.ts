import { describe, expect, it } from 'vitest'
import { fallbackTaskSummary, readMarks, splitReplyText, stripMarks } from './markers'

describe('hidden reply markers', () => {
  it('reads task, title and next independently and strips all three from the reply', () => {
    const reply = [
      '正文。',
      '<!-- agentswitch:title:短标题 -->',
      '<!-- agentswitch:next:继续验证 -->',
      '<!-- agentswitch:task: “已定位问题，\n接下来补回归测试” -->'
    ].join('\n')
    expect(readMarks(reply)).toEqual({ title: '短标题', next: '继续验证', task: '已定位问题， 接下来补回归测试' })
    expect(stripMarks(reply)).toBe('正文。')
    expect(readMarks('正文。').task).toBeNull()
  })

  it('accepts the summary alias, caps at 120 characters and ignores empty text', () => {
    expect(readMarks('<!-- agentswitch:task: ‘’ -->').task).toBeNull()
    const long = '界'.repeat(119) + '🌏额外内容'
    expect(readMarks(`<!-- agentswitch:summary:「${long}」 -->`).task).toBe('界'.repeat(119) + '🌏')
  })

  it('holds back a marker split across arbitrary streaming chunks', () => {
    const reply = 'Already done.\n<!-- agentswitch:task:✓ -->Next step. <!-- ordinary comment -->'
    let output = ''
    let pending = ''
    for (const chunk of reply) {
      const result = splitReplyText(pending + chunk)
      output += result.body
      pending = result.pending
    }
    expect(output).toBe('Already done.\nNext step. <!-- ordinary comment -->')
    expect(pending).toBe('')
    expect(stripMarks('可见内容\n<!-- agentswitch:ta')).toBe('可见内容')
  })
})

describe('task summary fallback', () => {
  it('skips code and generic headings, then extracts the first meaningful Markdown sentence', () => {
    const reply = [
      '## 总结', '<!-- invisible note -->', '```ts', 'throw new Error("Not the summary!");', '````',
      '> ~~~sh', '> echo hidden', '> ~~~', '**分析：**', '---',
      '> 1. **已完成缓存核对。** 下一步补单测。', '## 另一个标题'
    ].join('\n')
    expect(fallbackTaskSummary(reply)).toBe('已完成缓存核对。')
  })

  it('keeps substantive headings and handles multilingual sentence boundaries', () => {
    expect(fallbackTaskSummary('## 検証結果を記録しました。詳細は以下です。')).toBe('検証結果を記録しました。')
    expect(fallbackTaskSummary('## Analysis\n- Checked src/app.ts. Added tests.')).toBe('Checked src/app.ts.')
    expect(fallbackTaskSummary('需要重试吗？后续再检查。')).toBe('需要重试吗？')
    expect(fallbackTaskSummary('1、核对缓存。')).toBe('核对缓存。')
    expect(fallbackTaskSummary('Updated the cache\nMore details follow')).toBe('Updated the cache')
  })

  it('returns null for formatting and code alone and adds an ellipsis when capped', () => {
    expect(fallbackTaskSummary('<!-- agentswitch:task: -->\n## Summary\n```\ntruncated code')).toBeNull()
    expect(fallbackTaskSummary('      indented code\n  \tmore indented code')).toBeNull()
    expect(fallbackTaskSummary('核对日志并定位到真实原因', 5)).toBe('核对日志…')
  })
})
