import type { GitConflictChoice, GitConflictHunk } from './types'

type Block = { hunk: GitConflictHunk; start: number; end: number }
type OpenBlock = {
  start: number; startLine: number; label: string; size: number; currentStart: number
  base?: { start: number; marker: number }; separator?: { start: number; end: number }
}

function scan(content: string): { blocks: Block[]; malformed: boolean } {
  const blocks: Block[] = []
  let open: OpenBlock | undefined
  let malformed = false
  let line = 0
  for (const part of content.matchAll(/[^\n]*\n|[^\n]+$/g)) {
    line++
    const raw = part[0]
    const start = part.index + (line === 1 && raw.startsWith('\uFEFF') ? 1 : 0)
    const end = part.index + raw.length
    const marker = /^(<{7,}|\|{7,}|={7,}|>{7,})(?: (.*))?$/.exec(content.slice(start, end).replace(/\r?\n$/, ''))
    if (!marker) continue
    const [, marks, label = ''] = marker
    if (marks[0] === '<' && !open) {
      open = { start, startLine: line, label, size: marks.length, currentStart: end }
    } else if (open && marks.length === open.size) {
      if (marks[0] === '|' && !open.separator && !open.base) {
        open.base = { start: end, marker: start }
      } else if (marks[0] === '=' && !open.separator && !label) {
        open.separator = { start, end }
      } else if (marks[0] === '>' && open.separator) {
        blocks.push({ start: open.start, end, hunk: {
          index: blocks.length, startLine: open.startLine, endLine: line,
          currentLabel: open.label, incomingLabel: label,
          current: content.slice(open.currentStart, open.base?.marker ?? open.separator.start),
          ...(open.base ? { base: content.slice(open.base.start, open.separator.start) } : {}),
          incoming: content.slice(open.separator.end, start)
        } })
        open = undefined
      } else if (marks[0] === '<' || marks[0] === '>') {
        malformed = true
      }
    } else if (marks[0] === '>') {
      malformed = true
    }
  }
  return { blocks, malformed: malformed || !!open }
}

export function parseGitConflicts(content: string): GitConflictHunk[] {
  return scan(content).blocks.map(({ hunk }) => hunk)
}

export function inspectGitConflicts(content: string) {
  const { blocks, malformed } = scan(content)
  return { hunks: blocks.map(({ hunk }) => hunk), malformed }
}

export function applyConflictChoice(content: string, hunkIndex: number | 'all', choice: GitConflictChoice): string {
  const { blocks, malformed } = scan(content)
  if (malformed) throw new Error('Conflict markers are incomplete or nested. Resolve this file in an editor.')
  const selected = hunkIndex === 'all' ? blocks : blocks.filter(({ hunk }) => hunk.index === hunkIndex)
  if (!selected.length && hunkIndex !== 'all') throw new Error('This conflict block no longer exists.')
  const result: string[] = []
  let offset = 0
  for (const { hunk, start, end } of selected) {
    const replacement = choice === 'current' ? hunk.current : choice === 'incoming' ? hunk.incoming : hunk.current + hunk.incoming
    result.push(content.slice(offset, start), replacement)
    offset = end
  }
  const resolved = result.join('') + content.slice(offset)
  return selected.length && offset === content.length && !content.endsWith('\n') ? resolved.replace(/\r?\n$/, '') : resolved
}
