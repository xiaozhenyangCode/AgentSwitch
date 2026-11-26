export interface CodeSpan {
  start: number
  end: number
  delimiter: number
}

function inlineSpans(text: string, start: number, end: number, spans: CodeSpan[]): void {
  const runs = [...text.slice(start, end).matchAll(/`+/g)]
  const nextByWidth = new Map<number, number>()
  const closing = new Map<number, number>()
  for (let i = runs.length - 1; i >= 0; i--) {
    const width = runs[i][0].length
    const next = nextByWidth.get(width)
    if (next !== undefined) closing.set(i, next)
    nextByWidth.set(width, i)
  }
  for (let i = 0; i < runs.length; i++) {
    const close = closing.get(i)
    if (close === undefined) continue
    const from = start + runs[i].index
    let escapes = 0
    while (from - escapes > start && text[from - escapes - 1] === '\\') escapes++
    if (escapes % 2) continue
    const width = runs[i][0].length
    spans.push({ start: from, end: start + runs[close].index + width, delimiter: width })
    i = close
  }
}

/** Finds Markdown fences and inline code with matching delimiter widths. */
export function markdownCodeSpans(text: string): CodeSpan[] {
  const spans: CodeSpan[] = []
  let after = 0
  let fence: { start: number; marker: string } | undefined
  for (const match of text.matchAll(/^ {0,3}(`{3,}|~{3,})([^\r\n]*)/gm)) {
    const [line, marker, info] = match
    if (fence) {
      if (marker[0] === fence.marker[0] && marker.length >= fence.marker.length && /^[ \t]*$/.test(info)) {
        after = match.index + line.length
        spans.push({ start: fence.start, end: after, delimiter: 0 })
        fence = undefined
      }
    } else if (marker[0] === '~' || !info.includes('`')) {
      inlineSpans(text, after, match.index, spans)
      fence = { start: match.index, marker }
    }
  }
  if (fence) spans.push({ start: fence.start, end: text.length, delimiter: 0 })
  else inlineSpans(text, after, text.length, spans)
  return spans
}

/** Blanks code for account routing while preserving positions in the original text. */
export function maskCode(text: string): string {
  let after = 0
  let masked = ''
  for (const { start, end } of markdownCodeSpans(text)) {
    masked += text.slice(after, start) + text.slice(start, end).replace(/[^\n]/g, ' ')
    after = end
  }
  return masked + text.slice(after)
}
