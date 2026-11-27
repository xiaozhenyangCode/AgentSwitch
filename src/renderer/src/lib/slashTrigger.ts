import type { ExtSource, SkillItem } from '@shared/types'
import { isCliCompactCommand } from './compactCommand'

export interface SlashTrigger {
  start: number
  query: string
}

export function matchSlashTrigger(value: string, caret: number): SlashTrigger | null {
  if (caret < 1 || caret > value.length || (caret < value.length && !/\s/u.test(value[caret]))) return null
  const match = /(?:^|\s)[/／]([^\s/／]{0,48})$/u.exec(value.slice(0, caret))
  if (!match || match.index + match[0].length !== caret) return null
  return { start: caret - match[1].length - 1, query: match[1] }
}

const SOURCE_RANK: Record<ExtSource, number> = { project: 0, global: 1, plugin: 2, builtin: 3 }

/**
 * Fuzzy match for the / menu: name prefix, then a word in the name (`-`, `:`, `_`), then
 * substring, then letters in order; the description is searched last. Project skills first.
 */
export function filterSkills(items: SkillItem[], query: string, limit = 400): SkillItem[] {
  const q = query.trim().toLowerCase()
  if (!q) return items.slice(0, limit)
  const subseq = (s: string) => {
    let i = 0
    for (const ch of s) if (ch === q[i]) i++
    return i === q.length
  }
  const score = (it: SkillItem): number => {
    const n = it.name.toLowerCase()
    if (n.startsWith(q)) return 0
    if (n.split(/[-:_\s]/).some((w) => w.startsWith(q))) return 1
    if (n.includes(q)) return 2
    if (subseq(n)) return 3
    if (it.description.toLowerCase().includes(q)) return 4
    return -1
  }
  return items
    .map((it) => ({ it, s: score(it) }))
    .filter((x) => x.s >= 0)
    .sort((a, b) => a.s - b.s || SOURCE_RANK[a.it.source] - SOURCE_RANK[b.it.source] || a.it.name.localeCompare(b.it.name))
    .slice(0, limit)
    .map((x) => x.it)
}

export function groupQuickSkills(
  cliItems: SkillItem[],
  builtinItems: SkillItem[],
  query: string,
  pinned: string[]
): { pinned: SkillItem[]; all: SkillItem[]; flat: SkillItem[] } {
  const items = [...cliItems.filter((item) => !isCliCompactCommand(item)), ...builtinItems]
  if (query.trim()) {
    const matched = filterSkills(items, query)
    return { pinned: [], all: matched, flat: matched }
  }

  items.sort((a, b) => SOURCE_RANK[a.source] - SOURCE_RANK[b.source] || a.name.localeCompare(b.name))
  const pinOrder = new Map(pinned.map((name, index) => [name, index]))
  const favorites = items
    .filter((item) => pinOrder.has(item.name))
    .sort((a, b) => pinOrder.get(a.name)! - pinOrder.get(b.name)!)
  const all = items.filter((item) => !pinOrder.has(item.name))
  return { pinned: favorites, all, flat: [...favorites, ...all] }
}
