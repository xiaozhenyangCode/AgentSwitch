/**
 * Hidden end-of-reply markers the driver model is asked to emit (see orchestrator prompt):
 *   <!-- agentswitch:title:短标题 -->   first turn only: the chat's title
 *   <!-- agentswitch:next:下一句建议 -->  optional: suggested next user input (ghost text)
 *   <!-- agentswitch:task:任务进度 -->  what is done and what comes next
 * They are stripped from what is shown, copied and passed on as context.
 */
const MARK = /<!--\s*agentswitch:(title|next|task|summary)\s*:([\s\S]*?)-->/g

export interface ReplyMarks {
  title: string | null
  next: string | null
  task: string | null
}

const clean = (s: string, max: number): string | null => {
  const v = s.replace(/\s+/g, ' ').trim().replace(/^["'“”‘’「『]+|["'“”‘’」』]+$/g, '').trim()
  return v ? Array.from(v).slice(0, max).join('') : null
}

/** Normalises a CLI-reported conversation title (whitespace, wrapping quotes, length cap). */
export function cleanTitle(raw: unknown, max = 80): string | null {
  return typeof raw === 'string' ? clean(raw, max) : null
}

export function readMarks(text: string): ReplyMarks {
  let title: string | null = null
  let next: string | null = null
  let task: string | null = null
  for (const m of text.matchAll(MARK)) {
    if (m[1] === 'title') title = clean(m[2], 40)
    else if (m[1] === 'next') next = clean(m[2], 300)
    else task = clean(m[2], 120)
  }
  return { title, next, task }
}

/** Holds back a possible split marker until the next streaming chunk. */
export function splitReplyText(text: string): { body: string; pending: string } {
  const lastClose = text.lastIndexOf('-->')
  const commentStart = text.indexOf('<!--', lastClose < 0 ? 0 : lastClose + 3)
  const partial = text.match(/<(?:!-?)?$/)
  const end = commentStart >= 0 ? commentStart : partial?.index ?? text.length
  return { body: text.slice(0, end).replace(MARK, ''), pending: text.slice(end) }
}

/** Removes complete markers, plus an unfinished one still streaming in at the end. */
export function stripMarks(text: string): string {
  if (!text.includes('<!')) return text
  return text
    .replace(MARK, '')
    .replace(/<!--(?![\s\S]*-->)[\s\S]*$/, '')
    .replace(/<!?-?$/, '')
    .trimEnd()
}

const CATEGORY = /^(?:总结|總結|小结|小結|分析|概述|摘要|进度|進度|任务进度|任務進度|下一步|结论|結論|结果|結果|まとめ|要約|概要|進捗|結果と次の手順|summary|analysis|overview|task progress|progress|next steps?|results?|conclusion)$/i
const FENCED_CODE = /^[ \t]*((`|~)\2{2,})[^\r\n]*(?:\r?\n|$)[\s\S]*?(?:^[ \t]*\1\2*[ \t]*\r?$|(?![\s\S]))/gm

/** Pick the first meaningful sentence of the visible reply when no task marker was emitted. */
export function fallbackTaskSummary(text: string, maxLen = 60): string | null {
  if (maxLen < 1) return null
  const prose = stripMarks(text)
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/^(?:[ \t]*>[ \t]?)+/gm, '')
    .replace(/^[ \t]*(?:[-*+]|\d+[.)、])[ \t]+(?=`{3,}|~{3,})/gm, '')
    .replace(FENCED_CODE, '')

  for (const line of prose.split(/\r?\n/)) {
    if (/^(?: {4}| {0,3}\t)/.test(line)) continue
    const body = line
      .trim()
      .replace(/^(?:#{1,6}\s+|(?:[-*+•]|\d+[.)])\s+|\d+、\s*|\[[ xX]\]\s+)+/, '')
      .replace(/\s+#+$/, '')
      .replace(/(?<![\p{L}\p{N}])(\*{1,3}|_{1,3})(\S(?:.*?\S)?)\1(?![\p{L}\p{N}])/gu, '$2')
      .replace(/`([^`]+)`/g, '$1')
      .trim()
    if (!/[\p{L}\p{N}]/u.test(body) || CATEGORY.test(body.replace(/[:：。.!！?？]+$/, '').trimEnd())) continue
    const sentence = body.match(/^.*?(?:[。！？!?]+|\.(?=\s|$)|$)/)?.[0] ?? body
    const chars = Array.from(sentence)
    return chars.length <= maxLen ? sentence : chars.slice(0, maxLen - 1).join('').trimEnd() + '…'
  }
  return null
}
