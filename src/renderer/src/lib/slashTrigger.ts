import { translate, type Locale } from '@shared/i18n'
import type { ExtPackKind, ExtPackMeta, ExtSource, SkillItem } from '@shared/types'
import { isCliCompactCommand } from './compactCommand'

export interface SlashTrigger {
  start: number
  query: string
}

export function matchSlashTrigger(value: string, caret: number, multiWord = false): SlashTrigger | null {
  if (caret < 1 || caret > value.length || (caret < value.length && !/\s/u.test(value[caret]))) return null
  const pattern = multiWord ? /(?:^|\s)[/／]([^\s/／]+(?:[ \t\u3000]+[^\s/／]+)+)$/u : /(?:^|\s)[/／]([^\s/／]{0,48})$/u
  const match = pattern.exec(value.slice(0, caret))
  if (!match || match[1].length > 48 || match.index + match[0].length !== caret) return null
  return { start: caret - match[1].length - 1, query: match[1] }
}

const normalize = (text: string): string => text.normalize('NFKC').toLowerCase()

export function matchesExtensionSearch(query: string, ...fields: (string | null | undefined)[]): boolean {
  const words = normalize(query).trim().split(/\s+/u).filter(Boolean)
  if (!words.length) return true
  const candidates = fields.map((field) => normalize(field ?? ''))
  return words.every((word) => candidates.some((field) => field.includes(word)))
}

const SOURCE_RANK: Record<ExtSource, number> = { project: 0, global: 1, plugin: 2, builtin: 3 }

/**
 * Fuzzy match for the / menu: name prefix, then a word in the name (`-`, `:`, `_`), then
 * substring, then letters in order; the description is searched last. Project skills first.
 */
export function filterSkills(items: SkillItem[], query: string, limit = 400, locale?: Locale): SkillItem[] {
  const q = normalize(query).trim()
  if (!q) return items.slice(0, limit)
  const subseq = (s: string) => {
    let i = 0
    for (const ch of s) if (ch === q[i]) i++
    return i === q.length
  }
  const score = (it: SkillItem): number => {
    const n = normalize(it.name)
    if (n.startsWith(q)) return 0
    if (n.split(/[-:_\s]/).some((w) => w.startsWith(q))) return 1
    if (n.includes(q)) return 2
    if (subseq(n)) return 3
    if (matchesExtensionSearch(q, n, it.insert, it.description, it.translatedDescription, locale ? extensionPackLabel(extensionPack(it), locale) : it.packName, it.category, ...(it.tags ?? []))) return 4
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
  pinned: string[],
  locale?: Locale
): { pinned: SkillItem[]; all: SkillItem[]; flat: SkillItem[] } {
  const items = [...cliItems.filter((item) => !isCliCompactCommand(item)), ...builtinItems]
  if (query.trim()) {
    const matched = filterSkills(items, query, undefined, locale)
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

export interface ExtensionPack {
  id: string
  label?: string
  kind: ExtPackKind
  count: number
}

const PACK_RANK: Record<ExtPackKind, number> = { project: 0, plugin: 1, global: 2, builtin: 3 }

export function extensionPack(item: ExtPackMeta & { source: ExtSource; plugin?: string }): Omit<ExtensionPack, 'count'> {
  const kind = item.packKind ?? (item.plugin ? 'plugin' : item.source)
  const label = item.packName ?? item.plugin
  const id = item.packId ?? (kind === 'plugin' && label ? `plugin:${label.toLowerCase()}` : kind === 'global' ? 'global:personal' : kind)
  return { id, kind, label }
}

export type ExtensionPackFilter = Omit<ExtensionPack, 'kind'> & Partial<Pick<ExtensionPack, 'kind'>>

export function extensionPackLabel({ id, label, kind }: Omit<ExtensionPackFilter, 'count'>, locale: Locale): string {
  if (id === ALL_PACKS_ID) return translate(locale, 'ext.pack.all')
  if (id === PINNED_PACK_ID) return translate(locale, 'ext.pack.pinned')
  if (id === 'global:personal') return translate(locale, 'ext.pack.personal')
  if (kind === 'builtin') return translate(locale, 'ext.pack.builtin')
  return label || (kind ? translate(locale, `ext.src.${kind}`) : '')
}

export function groupExtensionPacks<T extends ExtPackMeta & { source: ExtSource; plugin?: string }>(items: T[], ranked = false) {
  const groups = new Map<string, { pack: ExtensionPack; items: T[] }>()
  for (const item of items) {
    const pack = extensionPack(item)
    const existing = groups.get(pack.id)
    if (existing) {
      existing.items.push(item)
      existing.pack.count++
    } else {
      groups.set(pack.id, { pack: { ...pack, count: 1 }, items: [item] })
    }
  }
  const sections = [...groups.values()]
  // During a search, the strongest match opens the first section.
  return ranked ? sections : sections.sort((a, b) =>
    PACK_RANK[a.pack.kind] - PACK_RANK[b.pack.kind] || (a.pack.label ?? '').localeCompare(b.pack.label ?? '') ||
    a.pack.id.localeCompare(b.pack.id))
}

export const PINNED_PACK_ID = 'pinned'
export const ALL_PACKS_ID = 'all'

interface QuickSkillsOptions {
  query: string
  pinned: string[]
  packFilter?: string
  collapsedPacks?: ReadonlySet<string>
  locale?: Locale
}

export function buildQuickSkillsView(cliItems: SkillItem[], builtinItems: SkillItem[], options: QuickSkillsOptions) {
  const { query, pinned, collapsedPacks } = options
  const searching = !!query.trim()
  const cli = cliItems.filter((item) => !isCliCompactCommand(item))
  const items = [...cli, ...builtinItems]
  const pins = new Set(pinned)
  const packs = groupExtensionPacks(items).map(({ pack }) => pack)
  const pinnedPack: ExtensionPack = { id: PINNED_PACK_ID, kind: 'global', count: items.filter((item) => pins.has(item.name)).length }
  const filters: ExtensionPackFilter[] = [
    { id: ALL_PACKS_ID, count: items.length },
    pinnedPack,
    ...packs
  ]
  const packFilter = filters.some((item) => item.id === options.packFilter) ? options.packFilter : ALL_PACKS_ID
  const eligible = (item: SkillItem) => packFilter === ALL_PACKS_ID ||
    (packFilter === PINNED_PACK_ID ? pins.has(item.name) : extensionPack(item).id === packFilter)
  const showPinnedSection = packFilter === ALL_PACKS_ID || packFilter === PINNED_PACK_ID
  const sorted = groupQuickSkills(cli.filter(eligible), builtinItems.filter(eligible), query, showPinnedSection ? pinned : [], options.locale)
  const sections = groupExtensionPacks(sorted.all, searching)
  if (sorted.pinned.length) sections.unshift({ pack: { ...pinnedPack, count: sorted.pinned.length }, items: sorted.pinned })
  const visible = sections.map((section) => ({
    ...section,
    expanded: searching || !collapsedPacks?.has(section.pack.id)
  }))
  return { packs: filters, sections: visible, flat: visible.flatMap((section) => section.expanded ? section.items : []) }
}
