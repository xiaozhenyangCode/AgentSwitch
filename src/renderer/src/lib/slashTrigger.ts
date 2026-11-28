import { translate, type Locale } from '@shared/i18n'
import { getProviderCapabilities } from '@shared/providerCapabilities'
import type { AgentItem, ExtOverview, ExtPackKind, ExtPackMeta, ExtSource, HookItem, McpServer, PluginItem, ProfileKind, RuleFile, SkillItem } from '@shared/types'
import { COMPACT_COMMAND_INSERT, isCliCompactCommand } from './compactCommand'

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

function nameMatchScore(name: string, query: string): number {
  if (name.startsWith(query)) return 0
  if (name.split(/[-:_\s]/).some((word) => word.startsWith(query))) return 1
  if (name.includes(query)) return 2
  let cursor = 0
  for (const ch of name) if (ch === query[cursor]) cursor++
  return cursor === query.length ? 3 : -1
}

/**
 * Fuzzy match for the / menu: name prefix, then a word in the name (`-`, `:`, `_`), then
 * substring, then letters in order; the description is searched last. Project skills first.
 */
export function filterSkills(items: SkillItem[], query: string, limit = 400, locale?: Locale): SkillItem[] {
  const q = normalize(query).trim()
  if (!q) return items.slice(0, limit)
  const score = (it: SkillItem): number => {
    const n = normalize(it.name)
    const nameScore = nameMatchScore(n, q)
    if (nameScore >= 0) return nameScore
    if (matchesExtensionSearch(q, n, it.insert, it.description, it.translatedDescription, it.path, it.plugin, locale ? extensionPackLabel(extensionPack(it), locale) : it.packName, it.category, ...(it.tags ?? []))) return 4
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

export const EXT_TABS = ['skills', 'agents', 'plugins', 'mcp', 'context'] as const
export type ExtTabId = typeof EXT_TABS[number]

export type QuickCapabilityItem =
  | { type: 'skills'; item: SkillItem }
  | { type: 'agents'; item: AgentItem }
  | { type: 'plugins'; item: PluginItem }
  | { type: 'mcp'; item: McpServer }
  | { type: 'rules'; item: RuleFile }
  | { type: 'hooks'; item: HookItem }

export function extensionPinKey(entry: QuickCapabilityItem): string {
  switch (entry.type) {
    case 'skills': return entry.item.name
    case 'agents': return `agent:${entry.item.plugin ? entry.item.plugin + ':' : ''}${entry.item.name}`
    case 'plugins': return `plugin:${entry.item.key}`
    case 'mcp': return `mcp:${entry.item.name}`
    case 'rules': return `rule:${entry.item.display}`
    case 'hooks': return `hook:${entry.item.event}:${entry.item.name || entry.item.matcher || entry.item.summary}`
  }
}

const hookName = (hook: HookItem) => hook.name ? `${hook.event} (${hook.name})` : hook.matcher ? `${hook.event} · ${hook.matcher}` : hook.event

export function capabilityLabel(entry: QuickCapabilityItem): string {
  if (entry.type === 'skills') return entry.item.insert
  if (entry.type === 'rules') return entry.item.display
  if (entry.type === 'hooks') return hookName(entry.item)
  return entry.item.name
}

interface CapabilityInsert {
  text: string
  appendSpace: boolean
  isCompact: boolean
}

export function buildCapabilityInsert(entry: QuickCapabilityItem, kind: ProfileKind | undefined, locale: Locale): CapabilityInsert {
  const { type, item } = entry
  if (type === 'skills') {
    return { text: item.insert, appendSpace: true, isCompact: item.source === 'builtin' && item.insert === COMPACT_COMMAND_INSERT }
  }
  const key = type === 'agents' ? (kind && getProviderCapabilities(kind).usesStandaloneAgentTerm ? 'ext.agentPhraseCodex' : 'ext.agentPhrase')
    : type === 'plugins' ? 'ext.pluginPhrase' : type === 'mcp' ? 'ext.mcpPhrase' : type === 'rules' ? 'ext.rulePhrase' : 'ext.hookPhrase'
  const text = translate(locale, key, { name: capabilityLabel(entry), path: type === 'rules' ? item.display : '' })
  return { text, appendSpace: false, isCompact: false }
}

export function applyCapabilityInsert(value: string, rangeStart: number, rangeEnd: number, insert: CapabilityInsert, pickerMode: boolean) {
  const before = value.slice(0, rangeStart)
  const after = value.slice(rangeEnd)
  const prefix = pickerMode && before && !/\s$/u.test(before) ? ' ' : ''
  const token = insert.appendSpace
    ? insert.text + (pickerMode && /^\s/u.test(after) ? '' : ' ')
    : /^\s/u.test(after) ? insert.text.trimEnd() : insert.text
  return { value: before + prefix + token + after, caret: before.length + prefix.length + token.length }
}

function capabilityPack(entry: QuickCapabilityItem, locale: Locale): Omit<ExtensionPack, 'count'> {
  const { type, item } = entry
  if (type === 'plugins') return {
    id: `market:${item.marketplace || item.source}`,
    label: item.marketplace ?? translate(locale, `ext.src.${item.source}`),
    kind: item.marketplace ? 'plugin' : item.source
  }
  if (type === 'rules') {
    if (item.scope === 'managed' && !item.plugin) return {
      id: 'scope:managed', kind: 'global', label: translate(locale, 'ext.scope.managed')
    }
    return extensionPack({ source: item.scope === 'managed' ? 'global' : item.scope, plugin: item.plugin })
  }
  return extensionPack(item)
}

function matchesCapability(entry: QuickCapabilityItem, query: string, locale: Locale): boolean {
  const { type, item } = entry
  const label = capabilityLabel(entry)
  if (nameMatchScore(normalize(label), normalize(query).trim()) >= 0) return true
  const pack = extensionPackLabel(capabilityPack(entry, locale), locale)
  if (type === 'agents') return matchesExtensionSearch(query, label, pack, item.plugin, item.path, item.description, item.translatedDescription, item.category, ...(item.tags ?? []))
  if (type === 'plugins') return matchesExtensionSearch(query, label, pack, item.key, item.path, item.description, item.translatedDescription, item.skills.join(' '), item.agents.join(' '), item.mcp.join(' '), item.rules.join(' '), item.hooks.join(' '))
  if (type === 'mcp') return matchesExtensionSearch(query, label, pack, item.plugin, item.transport, item.command, item.url, item.configPath, item.cwd)
  if (type === 'rules') return matchesExtensionSearch(query, label, pack, item.plugin, item.path, item.scope, item.importedBy)
  if (type === 'hooks') return matchesExtensionSearch(query, label, pack, item.plugin, item.name, item.event, item.type, item.matcher, item.summary, item.file)
  return false
}

export function cycleCapabilityTab(tab: ExtTabId, direction: number): ExtTabId {
  return EXT_TABS[(EXT_TABS.indexOf(tab) + direction + EXT_TABS.length) % EXT_TABS.length]
}

export function buildQuickCapabilitiesView(
  overview: ExtOverview | null | undefined,
  builtinSkills: SkillItem[],
  options: QuickSkillsOptions & { tab: ExtTabId; locale: Locale }
) {
  const { tab, query, pinned, collapsedPacks, locale } = options
  const searching = !!query.trim()
  const skills = [...(overview?.skills ?? []).filter((item) => !isCliCompactCommand(item)), ...builtinSkills]
  const matchingSkills = searching ? filterSkills(skills, query, Infinity, locale) : skills
  const entries: Record<ExtTabId, QuickCapabilityItem[]> = {
    skills: matchingSkills.map((item) => ({ type: 'skills', item })),
    agents: (overview?.agents ?? []).map((item) => ({ type: 'agents', item })),
    plugins: (overview?.plugins ?? []).map((item) => ({ type: 'plugins', item })),
    mcp: (overview?.mcp ?? []).map((item) => ({ type: 'mcp', item })),
    context: [
      ...(overview?.rules ?? []).map((item) => ({ type: 'rules' as const, item })),
      ...(overview?.hooks ?? []).map((item) => ({ type: 'hooks' as const, item }))
    ]
  }
  const tabCounts = { skills: 0, agents: 0, plugins: 0, mcp: 0, context: 0 }
  for (const id of EXT_TABS) {
    if (searching && id !== 'skills') entries[id] = entries[id].filter((entry) => matchesCapability(entry, query, locale))
    tabCounts[id] = entries[id].length
  }

  const matches = entries[tab]
  const pinOrder = new Map(pinned.map((key, rank) => [key, rank]))
  const rank = (entry: QuickCapabilityItem) => pinOrder.get(extensionPinKey(entry)) ?? Number.MAX_SAFE_INTEGER
  const byPin = (a: QuickCapabilityItem, b: QuickCapabilityItem) => rank(a) - rank(b)
  const groups = new Map<string, { pack: ExtensionPack; items: QuickCapabilityItem[] }>()
  for (const entry of matches) {
    const pack = capabilityPack(entry, locale)
    const group = groups.get(pack.id)
    if (group) {
      group.pack.count++
      group.items.push(entry)
    } else {
      groups.set(pack.id, { pack: { ...pack, count: 1 }, items: [entry] })
    }
  }
  const ordered = [...groups.values()]
  if (!searching || tab !== 'skills') {
    ordered.sort((a, b) => PACK_RANK[a.pack.kind] - PACK_RANK[b.pack.kind] ||
      extensionPackLabel(a.pack, locale).localeCompare(extensionPackLabel(b.pack, locale), locale))
  }
  const favorites = matches.filter((entry) => pinOrder.has(extensionPinKey(entry))).sort(byPin)
  const pinnedPack: ExtensionPack = { id: PINNED_PACK_ID, kind: 'global', count: favorites.length }
  const showPackBar = ordered.length > 1 || (favorites.length > 0 && matches.length > 1)
  const packs: ExtensionPackFilter[] = [
    { id: ALL_PACKS_ID, count: matches.length },
    ...(favorites.length ? [pinnedPack] : []),
    ...ordered.map(({ pack }) => pack)
  ]
  const packFilter = showPackBar && packs.some((pack) => pack.id === options.packFilter) ? options.packFilter : ALL_PACKS_ID
  const sections = packFilter === PINNED_PACK_ID ? [] : ordered
    .filter(({ pack }) => packFilter === ALL_PACKS_ID || pack.id === packFilter)
    .map(({ pack, items }) => ({
      pack,
      items: packFilter === ALL_PACKS_ID
        ? items.filter((entry) => !pinOrder.has(extensionPinKey(entry)))
        : [...items].sort(byPin)
    }))
    .filter(({ items }) => items.length)
  if ((packFilter === ALL_PACKS_ID || packFilter === PINNED_PACK_ID) && favorites.length) sections.unshift({ pack: pinnedPack, items: favorites })
  const visible = sections.map(({ pack, items }) => ({
    pack: { ...pack, count: items.length },
    items,
    expanded: searching || !collapsedPacks?.has(pack.id)
  }))
  return { packs, showPackBar, packFilter, sections: visible, flat: visible.flatMap(({ items, expanded }) => expanded ? items : []), tabCounts }
}
