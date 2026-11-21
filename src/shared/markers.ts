/**
 * Hidden end-of-reply markers the driver model is asked to emit (see orchestrator prompt):
 *   <!-- agentswitch:title:短标题 -->   first turn only: the chat's title
 *   <!-- agentswitch:next:下一句建议 -->  optional: suggested next user input (ghost text)
 * They are stripped from what is shown, copied and passed on as context.
 */
const MARK = /<!--\s*agentswitch:(title|next)\s*:([\s\S]*?)-->/g

export interface ReplyMarks {
  title: string | null
  next: string | null
}

const clean = (s: string, max: number): string | null => {
  const v = s.replace(/\s+/g, ' ').replace(/^["'“”「『]+|["'“”」』]+$/g, '').trim()
  return v ? v.slice(0, max) : null
}

export function readMarks(text: string): ReplyMarks {
  let title: string | null = null
  let next: string | null = null
  for (const m of text.matchAll(MARK)) {
    if (m[1] === 'title') title = clean(m[2], 40)
    else next = clean(m[2], 300)
  }
  return { title, next }
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
