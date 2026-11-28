import { useEffect, useRef, useState } from 'react'
import { useEscape } from '../lib/escStack'
import { isSignedIn } from '../lib/ui'
import { useApp, useSortedAccounts } from '../state/AppContext'
import { activeThread, useChat } from '../state/chat'
import { pickDriver, useDraft } from '../state/draft'
import { ALL_PACKS_ID, PINNED_PACK_ID, extensionPack, extensionPackLabel, groupExtensionPacks, matchesExtensionSearch, type buildQuickSkillsView, type ExtensionPack, type ExtensionPackFilter } from '../lib/slashTrigger'
import type { Locale, MsgKey } from '@shared/i18n'
import type { AgentItem, ExtDescription, ExtDetail, ExtOverview, ExtPackMeta, ExtSource, HookItem, McpServer, PluginItem, ProfileKind, ProfileState, RuleFile, RuleScope, SkillItem } from '@shared/types'
import { getProviderCapabilities } from '@shared/providerCapabilities'
import {
  displayExtDescription, invalidateExtCache, pinnedFirst, setShowOriginalDesc, togglePin,
  useOverview, usePins, useShowOriginalDesc, useTranslateProgress
} from '../state/extensions'
import { t, useI18n } from '../state/i18n'
import { Markdown } from './Markdown'
import { IconChevronDown, IconCopy, IconExternal, IconFile, IconFolder, IconFolderTree, IconRefresh, IconSearch, IconSlash, IconStar, Spinner } from './icons'

const SOURCE_KEY = { project: 'ext.src.project', global: 'ext.src.global', plugin: 'ext.src.plugin', builtin: 'ext.src.builtin' } as const
export const sourceLabel = (s: ExtSource): string => t(SOURCE_KEY[s])
type TabId = 'skills' | 'agents' | 'plugins' | 'mcp' | 'context'
const TABS: TabId[] = ['skills', 'agents', 'plugins', 'mcp', 'context']
const fmtBytes = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`)
const SCOPE_KEY: Record<RuleScope, MsgKey> = { managed: 'ext.scope.managed', global: 'ext.src.global', project: 'ext.src.project', plugin: 'ext.src.plugin' }
const STATE_DOT: Record<McpServer['state'], string> = { on: 'bg-ok', off: 'bg-ink-3/40', pending: 'bg-warn' }
const Chevron = ({ open }: { open: boolean }) => <IconChevronDown size={12} className={`shrink-0 text-ink-3 transition-transform ${open ? '' : '-rotate-90'}`} />
const actionClass = 'inline-flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-[12px] text-ink-2 hover:bg-fill hover:text-ink'

type InventoryData =
  | { type: 'skills'; item: SkillItem }
  | { type: 'agents'; item: AgentItem }
  | { type: 'plugins'; item: PluginItem }
  | { type: 'mcp'; item: McpServer }
  | { type: 'rules'; item: RuleFile }
  | { type: 'hooks'; item: HookItem }

type InventoryRow = InventoryData & { id: string; label: string; subtitle?: string }
interface InventorySection {
  pack: ExtensionPack
  rows: InventoryRow[]
}

function inventorySections(data: ExtOverview, tab: TabId, q: string, pins: string[], pinnedOnly: boolean, original: boolean, locale: Locale): InventorySection[] {
  const matches = matchesExtensionSearch
  if (tab === 'skills') {
    const items = pinnedFirst(data.skills.filter((item) =>
      (!pinnedOnly || pins.includes(item.name)) &&
      matches(q, item.name, item.insert, item.description, item.translatedDescription, item.path, item.plugin, extensionPackLabel(extensionPack(item), locale), item.category, ...(item.tags ?? []))), pins)
    return groupExtensionPacks(items).map(({ pack, items }) => ({
      pack,
      rows: items.map((item) => ({ type: tab, item, id: item.insert, label: item.insert, subtitle: displayExtDescription(item, original) }))
    }))
  }
  if (tab === 'agents') {
    const items = data.agents.filter((item) =>
      matches(q, item.name, item.description, item.translatedDescription, item.path, item.plugin, extensionPackLabel(extensionPack(item), locale), item.category, ...(item.tags ?? [])))
    return groupExtensionPacks(items).map(({ pack, items }) => ({
      pack,
      rows: items.map((item) => ({ type: tab, item, id: JSON.stringify([item.name, item.path]), label: item.name, subtitle: displayExtDescription(item, original) }))
    }))
  }
  const sections = new Map<string, InventorySection>()
  const add = (group: string, label: string, row: InventoryRow, kind: ExtSource = 'global') => {
    const existing = sections.get(group)
    if (existing) {
      existing.rows.push(row)
      existing.pack.count++
    } else {
      sections.set(group, { pack: { id: group, label, kind, count: 1 }, rows: [row] })
    }
  }
  if (tab === 'plugins') {
    for (const item of data.plugins) {
      if (!matches(q, item.name, item.key, item.description, item.translatedDescription, item.path, item.marketplace)) continue
      const label = item.marketplace || sourceLabel(item.source)
      add(`market:${item.marketplace || item.source}`, label, {
        type: tab, item, id: item.key, label: item.name, subtitle: displayExtDescription(item, original)
      })
    }
  } else if (tab === 'mcp') {
    for (const item of data.mcp) {
      if (!matches(q, item.name, item.plugin, item.command, item.url, item.configPath)) continue
      const pack = extensionPack(item)
      add(pack.id, pack.label || sourceLabel(item.source), {
        type: tab, item, id: JSON.stringify([item.source, item.name, item.plugin, item.configPath]), label: item.name, subtitle: item.transport
      }, item.source)
    }
  } else {
    for (const item of data.rules) {
      if (!matches(q, item.display, item.path, item.plugin)) continue
      add('context:rules', t('ext.rules'), { type: 'rules', item, id: item.path, label: item.display, subtitle: t(SCOPE_KEY[item.scope]) })
    }
    for (const [index, item] of data.hooks.entries()) {
      if (!matches(q, item.event, item.matcher, item.summary, item.plugin, item.name, item.file, item.type)) continue
      add(`context:hooks:${item.event}`, item.event, {
        type: 'hooks', item, id: `hook:${index}`, label: item.name || item.summary, subtitle: item.matcher || item.type
      })
    }
  }
  return [...sections.values()]
}

function InventoryGuide({ tab, message }: { tab: TabId; message?: string }) {
  return (
    <div className="m-auto flex max-w-[32ch] flex-col items-center gap-2 px-4 py-5 text-center">
      <IconFolderTree size={22} className="mb-1 text-ink-2" />
      <p className="text-[13px] font-medium text-ink">{message || t('ext.detail.select')}</p>
      <p className="text-[12px] leading-relaxed text-ink-2">{t(`ext.desc.${tab}`)}</p>
    </div>
  )
}

function DetailFile({ path }: { path: string }) {
  const [detail, setDetail] = useState<ExtDetail | null>(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let live = true
    window.agentswitch.ext.readDetail(path).then(
      (result) => { if (live) setDetail(result) },
      () => { if (live) setFailed(true) }
    )
    return () => { live = false }
  }, [path])
  return (
    <section className="space-y-2 border-t border-hairline pt-4">
      <h3 className="text-[12px] font-semibold text-ink-2">{t('ext.detail.document')}</h3>
      {failed ? <p className="text-[12px] text-ink-2">{t('ext.previewFailed')}</p>
        : !detail ? <p className="text-[12px] text-ink-2">{t('ext.loading')}</p>
        : <>
          {detail.truncated && <p className="text-[12px] text-warn tabular-nums">{t('ext.detail.truncated', { size: fmtBytes(detail.bytes) })}</p>}
          {!detail.body.trim() ? <p className="text-[12px] text-ink-2">{t('ext.previewEmpty')}</p>
            : /\.(md|markdown)$/i.test(path) ? <div className="min-w-0 break-words select-text"><Markdown text={detail.body} readOnly /></div>
            : <pre className="font-mono text-[12px] break-all whitespace-pre-wrap text-ink-2 select-text">{detail.body}</pre>}
        </>}
    </section>
  )
}

function useDetailActions() {
  const { toast } = useApp()
  const copy = async (text: string) => {
    try {
      await window.agentswitch.sys.copy(text)
      toast({ kind: 'success', title: t('ext.detail.copied') })
    } catch {
      toast({ kind: 'error', title: t('ext.detail.copyFailed') })
    }
  }
  const open = async (path: string) => {
    try {
      await window.agentswitch.ext.openFile(path)
    } catch {
      toast({ kind: 'error', title: t('ext.detail.openFailed') })
    }
  }
  return { copy, open }
}

function DetailFileActions({ path, editable = true }: { path: string; editable?: boolean }) {
  const { open } = useDetailActions()
  return (
    <>
      {editable && <button type="button" onClick={() => void open(path)} className={actionClass}><IconExternal size={13} />{t('ext.detail.openEditor')}</button>}
      <button type="button" onClick={() => void window.agentswitch.ext.reveal(path)} className={actionClass}><IconFolder size={13} />{t('common.showInFinder')}</button>
    </>
  )
}

function DetailPath({ path }: { path: string }) {
  const { copy } = useDetailActions()
  return (
    <button type="button" onClick={() => void copy(path)} aria-label={t('ext.detail.copyPath', { path })}
      className="flex max-w-full items-start gap-1.5 rounded-md px-1 py-0.5 text-left font-mono text-[11px] break-all text-ink-2 hover:bg-fill hover:text-ink">
      <IconCopy size={12} className="mt-0.5 shrink-0" />{path}
    </button>
  )
}

function DetailFields({ fields }: { fields: [string, string | undefined | null][] }) {
  return (
    <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-[12px] leading-relaxed tabular-nums">
      {fields.map(([label, value]) => value ? (
        <div key={label} className="contents">
          <dt className="text-ink-2">{label}</dt>
          <dd className="font-mono break-all whitespace-pre-wrap text-ink select-text">{value}</dd>
        </div>
      ) : null)}
    </dl>
  )
}

function InventoryDetail({ row, kind, pins, original, revision, onEdit }: {
  row: InventoryRow
  kind: ProfileKind
  pins: string[]
  original: boolean
  revision: number
  onEdit: (rule: RuleFile) => void
}) {
  const { copy } = useDetailActions()
  const { type, item } = row
  if (type === 'skills' || type === 'agents') {
    return (
      <>
        <div className="flex flex-wrap items-start justify-between gap-2">
          <h2 className={`text-[18px] font-semibold break-all text-ink ${type === 'skills' ? 'font-mono' : ''}`}>{row.label}</h2>
          {type === 'skills' && <SkillPin kind={kind} skill={item} pinned={pins.includes(item.name)} />}
        </div>
        <PackBadges item={item} showSource />
        <DescriptionPreview item={item} original={original} />
        {type === 'agents' && <DetailFields fields={[[t('ext.detail.model'), item.model], [t('ext.detail.tools'), item.tools]]} />}
        {(type === 'skills' || item.path) && (
          <div className="flex flex-wrap items-center gap-1">
            {type === 'skills' && <button type="button" className={actionClass} onClick={() => void copy(item.insert)}><IconCopy size={13} />{t('ext.detail.copyCommand')}</button>}
            {item.path && <DetailFileActions path={item.path} />}
          </div>
        )}
        {item.path && <><DetailPath path={item.path} /><DetailFile key={`${item.path}:${revision}`} path={item.path} /></>}
      </>
    )
  }
  if (type === 'plugins') {
    return (
      <>
        <h2 className="text-[18px] font-semibold break-words text-ink">{item.name}</h2>
        <p className="text-[12px] tabular-nums text-ink-2">{[item.version, item.marketplace || sourceLabel(item.source), !item.enabled && t('ext.disabled')].filter(Boolean).join(' · ')}</p>
        <DescriptionPreview item={item} original={original} />
        <DetailFields fields={[
          [t('ext.tab.skills'), item.skills.join('\n')], [t('ext.tab.agents'), item.agents.join('\n')], ['MCP', item.mcp.join('\n')],
          [t('ext.hooks'), item.hooks.join('\n')], [t('ext.rules'), item.rules.join('\n')]
        ]} />
        <DetailPath path={item.path} />
      </>
    )
  }
  if (type === 'mcp') {
    const status = item.state === 'off' ? t('ext.mcpOff') : item.state === 'pending' ? t('ext.mcpPending')
      : item.local ? t('ext.mcpLocal') : item.managed ? t('ext.mcpManaged') : ''
    const fields: [string, string | undefined][] = [
      [t('ext.mcpCmd'), item.command], [t('ext.mcpUrl'), item.url], [t('ext.mcpCwd'), item.cwd],
      [t('ext.mcpEnv'), item.envKeys?.join(', ')], [t('ext.mcpHeaders'), item.headerKeys?.join(', ')]
    ]
    return (
      <>
        <h2 className="text-[18px] font-semibold break-words text-ink">{item.name}</h2>
        <p className="flex items-center gap-2 text-[12px] text-ink-2">
          <span className={`h-1.5 w-1.5 rounded-full ${STATE_DOT[item.state]}`} />
          {[item.transport, item.plugin || sourceLabel(item.source), status].filter(Boolean).join(' · ')}
        </p>
        {fields.some(([, value]) => value) ? <DetailFields fields={fields} /> : <p className="text-[12px] text-ink-2">{t('ext.mcpNoDetail')}</p>}
        {item.configPath && <><DetailFileActions path={item.configPath} editable={false} /><DetailPath path={item.configPath} /></>}
      </>
    )
  }
  if (type === 'rules') {
    return (
      <>
        <h2 className="font-mono text-[16px] font-semibold break-all text-ink">{item.display}</h2>
        <p className="text-[12px] tabular-nums text-ink-2">
          {[t(SCOPE_KEY[item.scope]), item.plugin, t('ext.ruleMeta', { size: fmtBytes(item.bytes), lines: item.lines }),
            item.importedBy && t('ext.importedBy', { file: item.importedBy }), item.truncated && t('ext.ruleTruncated')].filter(Boolean).join(' · ')}
        </p>
        <div className="flex flex-wrap items-center gap-1">
          {(item.scope === 'global' || item.scope === 'project') && <button type="button" className={actionClass} onClick={() => onEdit(item)}>{t('ext.ruleEdit')}</button>}
          <DetailFileActions path={item.path} />
        </div>
        <DetailPath path={item.path} />
        <DetailFile key={`${item.path}:${revision}`} path={item.path} />
      </>
    )
  }
  return (
    <>
      <h2 className="text-[18px] font-semibold break-words text-ink">{item.name || item.event}</h2>
      <p className="text-[12px] text-ink-2">{[item.event, item.type, item.plugin || sourceLabel(item.source), item.off && t('ext.disabled')].filter(Boolean).join(' · ')}</p>
      {item.matcher && <p className="font-mono text-[12px] break-all text-ink-2">{item.matcher}</p>}
      <pre className="font-mono text-[12px] break-all whitespace-pre-wrap text-ink select-text">{item.summary}</pre>
      {item.file && <DetailPath path={item.file} />}
    </>
  )
}

function ExtensionWorkspace({ account, data, tab, projectDir, revision, onReload }: {
  account: ProfileState
  data: ExtOverview
  tab: TabId
  projectDir: string | null
  revision: number
  onReload: () => void
}) {
  const { toast } = useApp()
  const original = useShowOriginalDesc()
  const pins = usePins(account.kind)
  const { locale } = useI18n()
  const [query, setQuery] = useState('')
  const [pinnedOnly, setPinnedOnly] = useState(false)
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set())
  const [selection, setSelection] = useState<string | null>(null)
  const [editing, setEditing] = useState<{ path: string; display: string; exists: boolean } | null>(null)
  const preparation = useRef(0)
  const q = query.trim()
  const sections = inventorySections(data, tab, q, pins, pinnedOnly, original, locale)
  const allRows = sections.flatMap((section) => section.rows)
  const visibleRows = sections.flatMap((section) => (!q && collapsed.has(section.pack.id)) ? [] : section.rows)
  const selected = allRows.find((row) => row.id === selection) ?? visibleRows[0] ?? allRows[0]
  const activeId = editing ? selection : selected?.id ?? null
  const canCreate = tab === 'context' && getProviderCapabilities(account.kind).supportsExtensions
  const createGlobal = canCreate && !data.rules.some((rule) => rule.scope === 'global')
  const createProject = canCreate && !!projectDir && !data.rules.some((rule) => rule.scope === 'project')
  const startCreate = async (scope: 'global' | 'project') => {
    const request = ++preparation.current
    try {
      const target = await window.agentswitch.ext.prepareRule(account.id, projectDir, scope)
      if (request !== preparation.current) return
      setSelection(target.path)
      setEditing(target)
    } catch {
      if (request === preparation.current) toast({ kind: 'error', title: t('ext.detail.openFailed') })
    }
  }
  const empty = q ? 'ext.noMatchAny' : tab === 'skills' ? (pinnedOnly ? 'ext.noPinned' : 'ext.noSkills')
    : tab === 'agents' ? (data.agentsDynamic ? 'ext.agentsDynamic' : 'ext.noAgents')
    : tab === 'plugins' ? 'ext.noPlugins' : tab === 'mcp' ? 'ext.mcpEmpty' : 'ext.noRules'
  return (
    <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,42fr)_minmax(0,58fr)] bg-editor-canvas">
      <aside className="flex min-h-0 min-w-0 flex-col border-r border-hairline bg-editor-chrome">
        <div className="flex h-9 shrink-0 items-center gap-2 border-b border-hairline px-3">
          <IconSearch size={14} className="shrink-0 text-ink-2" />
          <input value={query} onChange={(event) => setQuery(event.target.value)} aria-label={t('ext.search')}
            placeholder={t('ext.search')} spellCheck={false}
            className="min-w-0 flex-1 bg-transparent text-[13px] text-ink outline-none placeholder:text-ink-2" />
        </div>
        {tab === 'skills' && (
          <div className="flex shrink-0 gap-1 px-2 pt-1 text-[11.5px]">
            {[false, true].map((value) => (
              <button key={String(value)} type="button" aria-pressed={pinnedOnly === value} onClick={() => setPinnedOnly(value)}
                className={`rounded-md px-2 py-1 hover:bg-fill ${pinnedOnly === value ? 'bg-accent/10 text-accent' : 'text-ink-2'}`}>
                {t(value ? 'ext.filter.pinned' : 'ext.filter.all')}
              </button>
            ))}
          </div>
        )}
        {(createGlobal || createProject) && <div className="flex shrink-0 flex-wrap gap-1 px-2 pt-1">
          {createGlobal && <button type="button" className={actionClass} onClick={() => void startCreate('global')}>{t('ext.newGlobalRule')}</button>}
          {createProject && <button type="button" className={actionClass} onClick={() => void startCreate('project')}>{t('ext.newProjectRule')}</button>}
        </div>}
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-1.5">
          {sections.map(({ pack, rows }) => {
            const expanded = !!q || !collapsed.has(pack.id)
            return (
              <div key={pack.id} className="pb-1">
                <PackHeading pack={pack} expanded={expanded} locked={!!q} onToggle={() => {
                  if (q) return
                  setCollapsed((previous) => {
                    const next = new Set(previous)
                    if (!next.delete(pack.id)) next.add(pack.id)
                    return next
                  })
                }} />
                {expanded && rows.map((row) => (
                  <div key={row.id} className={`group flex min-h-7 min-w-0 items-center rounded-md pl-3 ${row.id === activeId ? 'bg-accent/10' : 'hover:bg-fill'}`}>
                    <button type="button" aria-pressed={row.id === activeId} onClick={() => {
                      preparation.current++
                      setSelection(row.id)
                      setEditing(null)
                    }} className="flex min-w-0 flex-1 items-center gap-1.5 px-1.5 py-1 text-left">
                      {row.type === 'mcp' && <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${STATE_DOT[row.item.state]}`} />}
                      <span className="min-w-0">
                        <span className={`block truncate text-[12.5px] leading-4 ${row.type === 'skills' || row.type === 'rules' ? 'font-mono' : ''} ${row.id === activeId ? 'text-accent' : 'text-ink'}`}>{row.label}</span>
                        {row.subtitle && <span className="block truncate text-[11.5px] leading-4 text-ink-2">{row.subtitle}</span>}
                      </span>
                    </button>
                    {row.type === 'skills' && <SkillPin kind={account.kind} skill={row.item} pinned={pins.includes(row.item.name)}
                      className={`mr-1 ${pins.includes(row.item.name) ? '' : 'opacity-0 group-hover:opacity-100 focus-visible:opacity-100'}`} />}
                  </div>
                ))}
              </div>
            )
          })}
          {!sections.length && <p className="px-2 py-3 text-[12px] text-ink-2">{t(empty)}</p>}
          {tab === 'mcp' && data.remoteNote && <p className="px-2 py-2 text-[11px] text-ink-2">{t('ext.remoteNote')}</p>}
          {tab === 'context' && !data.hooks.length && data.rules.length > 0 && <p className="px-2 py-2 text-[11px] text-ink-2">{t('ext.noHooks')}</p>}
        </div>
      </aside>
      <main className="flex min-h-0 min-w-0 flex-col overflow-hidden">
        {editing ? (
          <div key={editing.path} className="min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain p-4">
            <h2 className="font-mono text-[16px] font-semibold break-all text-ink">{editing.display}</h2>
            <DetailPath path={editing.path} />
            <RuleEditor path={editing.path} exists={editing.exists} onCancel={() => setEditing(null)} onSaved={() => {
              setEditing(null)
              toast({ kind: 'success', title: t('ext.ruleSaved') })
              onReload()
            }} />
          </div>
        ) : selected ? (
          <div key={selected.id} className="min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain px-4 py-4">
            <InventoryDetail row={selected} kind={account.kind} pins={pins} original={original} revision={revision}
              onEdit={(rule) => setEditing({ path: rule.path, display: rule.display, exists: true })} />
          </div>
        ) : <InventoryGuide tab={tab} />}
      </main>
    </div>
  )
}

/** Inline editor for global/project rule markdown files. */
function RuleEditor({
  path,
  exists,
  onSaved,
  onCancel
}: {
  path: string
  exists: boolean
  onSaved: () => void
  onCancel: () => void
}) {
  const [draft, setDraft] = useState('')
  const [initial, setInitial] = useState('')
  const [loading, setLoading] = useState(exists)
  const [tooLarge, setTooLarge] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const areaRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    let live = true
    setError(null)
    setTooLarge(false)
    if (!exists) {
      setDraft('')
      setInitial('')
      setLoading(false)
      setTimeout(() => areaRef.current?.focus(), 0)
      return
    }
    setLoading(true)
    window.agentswitch.ext.read(path).then(
      (res) => {
        if (!live) return
        setLoading(false)
        if (res.truncated) {
          setTooLarge(true)
          return
        }
        setDraft(res.text)
        setInitial(res.text)
        setTimeout(() => areaRef.current?.focus(), 0)
      },
      () => {
        if (!live) return
        setLoading(false)
        setError(t('ext.previewFailed'))
      }
    )
    return () => {
      live = false
    }
  }, [path, exists])

  const dirty = !exists ? draft.length > 0 : draft !== initial
  const lines = draft ? draft.split('\n').length - (draft.endsWith('\n') ? 1 : 0) : 0

  const save = async () => {
    if (saving || tooLarge) return
    setSaving(true)
    setError(null)
    try {
      await window.agentswitch.ext.writeRule(path, draft)
      onSaved()
    } catch {
      setError(t('ext.ruleSaveFailed'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="border-t border-hairline pt-3">
      {loading ? (
        <div className="py-3 text-[12px] text-ink-3">{t('ext.loading')}</div>
      ) : tooLarge ? (
        <div className="py-2 text-[12px] text-warn">{t('ext.ruleTooLarge')}</div>
      ) : (
        <>
          <textarea
            ref={areaRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
                e.preventDefault()
                void save()
              } else if (e.key === 'Escape') {
                e.stopPropagation()
                onCancel()
              }
            }}
            placeholder={t('ext.rulePlaceholder')}
            className="min-h-[160px] max-h-[280px] w-full resize-y rounded-lg bg-surface px-2.5 py-2 font-mono text-[12px] leading-[18px] text-ink shadow-[inset_0_0_0_1px_var(--ring)] outline-none placeholder:text-ink-3 focus:shadow-[inset_0_0_0_1.5px_var(--accent)]"
          />
          <div className="mt-2 flex items-center gap-2 text-[11px] text-ink-3">
            <span className="tabular-nums">{t('ext.ruleMeta', { size: fmtBytes(new Blob([draft]).size), lines })}</span>
            <span>·</span>
            <span>{t('ext.ruleSaveHint')}</span>
            {error && <span className="text-danger">{error}</span>}
            <span className="flex-1" />
            <button onClick={onCancel} className="rounded-md px-2.5 py-1 text-[11.5px] font-medium text-ink-2 hover:bg-black/[0.06] hover:text-ink">
              {t('ext.ruleCancel')}
            </button>
            <button
              onClick={() => void save()}
              disabled={saving || (!dirty && exists)}
              className="rounded-md bg-accent px-2.5 py-1 text-[11.5px] font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-45"
            >
              {saving ? '…' : t('ext.ruleSave')}
            </button>
          </div>
        </>
      )}
    </div>
  )
}

export function QuickSkillsButton({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      data-quick-skills-toggle
      aria-expanded={open}
      title={t('ext.quickSkillsTip')}
      onMouseDown={(event) => event.preventDefault()}
      onClick={onToggle}
      className={`flex h-7 items-center gap-1 rounded-full px-2.5 text-[12px] font-medium hover:bg-fill hover:text-ink ${open ? 'bg-accent/10 text-accent' : 'text-ink-2'}`}
    >
      <IconSlash size={13} />
      {t('ext.quickSkills')}
    </button>
  )
}

function PackHeading({ pack, expanded, locked = false, onToggle }: { pack: ExtensionPackFilter; expanded: boolean; locked?: boolean; onToggle: () => void }) {
  const { locale } = useI18n()
  return (
    <button
      type="button"
      aria-expanded={expanded}
      aria-disabled={locked}
      onMouseDown={(event) => event.preventDefault()}
      onClick={onToggle}
      className="flex h-7 w-full items-center gap-1.5 rounded-md px-2 text-left text-[11.5px] font-medium text-ink-2 hover:bg-fill hover:text-ink"
    >
      <Chevron open={expanded} />
      <span className="min-w-0 flex-1 truncate">{extensionPackLabel(pack, locale)}</span>
      <span className="text-ink-3 tabular-nums">{pack.count}</span>
    </button>
  )
}

function DescriptionPreview({ item, original }: { item: ExtDescription; original: boolean }) {
  const description = displayExtDescription(item, original)
  const compare = !original && !!item.description && !!item.translatedDescription && item.description !== item.translatedDescription
  return (
    <div className="space-y-3">
      <p className="text-[13px] leading-relaxed break-words whitespace-pre-wrap text-ink select-text">{description || t('ext.detail.noDescription')}</p>
      {compare && (
        <div className="border-l border-hairline pl-3 text-[12px] leading-relaxed break-words whitespace-pre-wrap text-ink-2 select-text">
          <p className="mb-0.5 text-[11px] font-medium">{t('ext.detail.original')}</p>
          {item.description}
        </div>
      )}
    </div>
  )
}

function PackBadges({ item, showSource = false }: { item: ExtPackMeta & { source: ExtSource; plugin?: string }; showSource?: boolean }) {
  const { locale } = useI18n()
  const pack = extensionPackLabel(extensionPack(item), locale)
  const source = sourceLabel(item.source)
  const labels = new Set([pack, ...(showSource ? [source] : []), item.category, ...(item.tags ?? [])].filter(Boolean))
  return (
    <div className="flex flex-wrap gap-1.5">
      {[...labels].map((label) => <span key={label} className="max-w-full rounded-md bg-fill px-1.5 py-0.5 text-[11px] break-words text-ink-2">{label}</span>)}
    </div>
  )
}

function SkillPin({ kind, skill, pinned, className = '' }: { kind: ProfileKind; skill: SkillItem; pinned: boolean; className?: string }) {
  return (
    <button
      type="button"
      aria-label={t(pinned ? 'ext.unpin' : 'ext.pin')}
      aria-pressed={pinned}
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => togglePin(kind, skill.name)}
      className={`shrink-0 rounded-md p-1 hover:bg-fill ${pinned ? 'text-warn' : 'text-ink-2'} ${className}`}
    >
      <IconStar size={14} filled={pinned} />
    </button>
  )
}

export function QuickSkillsPopover({
  mode, query, groups, packFilter, onPackFilter, onTogglePack,
  kind, pins, loading, active, onQuery, onPick, onHover, onDismiss, onCancel, onManage
}: {
  mode: 'inline' | 'picker'
  query: string
  groups: ReturnType<typeof buildQuickSkillsView>
  packFilter?: string
  onPackFilter: (id: string) => void
  onTogglePack: (id: string) => void
  kind: ProfileKind | undefined
  pins: string[]
  loading: boolean
  active: number
  onQuery: (query: string) => void
  onPick: (skill: SkillItem) => void
  onHover: (index: number) => void
  onDismiss: () => void
  onCancel: () => void
  onManage: () => void
}) {
  const root = useRef<HTMLDivElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const filters = useRef<HTMLDivElement>(null)
  const picker = mode === 'picker'
  const { locale } = useI18n()
  const original = useShowOriginalDesc()
  const { packs, sections, flat } = groups
  const searching = !!query.trim()
  const selected = flat[active]
  const selectedFilter = packs.findIndex((pack) => pack.id === packFilter)
  const filterIndex = Math.max(0, selectedFilter)
  const rowIndices = new Map(flat.map((item, index) => [item, index]))

  useEffect(() => {
    list.current?.querySelector<HTMLElement>(`[data-skill-index="${active}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [active, flat])
  useEffect(() => {
    filters.current?.querySelector('[aria-pressed=true]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [filterIndex])
  useEffect(() => {
    const outside = (event: PointerEvent) => {
      const target = event.target
      if (!(target instanceof Element) || root.current?.contains(target) || target.closest('[data-quick-skills-toggle]')) return
      onDismiss()
    }
    window.addEventListener('pointerdown', outside)
    return () => window.removeEventListener('pointerdown', outside)
  }, [onDismiss])
  useEscape(onCancel, picker, onCancel)

  return (
    <div ref={root} data-quick-skills-popover onKeyDown={(event) => {
      if (!picker && event.key === 'Escape' && !event.nativeEvent.isComposing) {
        event.preventDefault()
        onCancel()
      }
    }} className="@container flex h-[min(410px,calc(100dvh-12rem))] w-[min(660px,100%,calc(100vw-32px))] flex-col overflow-hidden rounded-xl border border-editor-hairline bg-elevated shadow-[0_12px_32px_rgba(0,0,0,0.14)]">
      {picker && (
        <div className="flex h-9 shrink-0 items-center gap-2 px-3">
          <IconSearch size={14} className="shrink-0 text-ink-3" />
          <input
            autoFocus
            value={query}
            aria-label={t('ext.quickSearchPlaceholder')}
            placeholder={t('ext.quickSearchPlaceholder')}
            spellCheck={false}
            onChange={(event) => onQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return
              if (!query && ['Tab', 'ArrowLeft', 'ArrowRight'].includes(event.key) && !event.metaKey && !event.ctrlKey && !event.altKey) {
                const delta = event.key === 'ArrowLeft' || (event.key === 'Tab' && event.shiftKey) ? -1 : 1
                const next = filterIndex + delta
                if (event.key !== 'Tab' || (next >= 0 && next < packs.length)) {
                  event.preventDefault()
                  onPackFilter(packs[(next + packs.length) % packs.length].id)
                }
                return
              }
              if (!flat.length) return
              if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault()
                const delta = event.key === 'ArrowDown' ? 1 : -1
                onHover((active + delta + flat.length) % flat.length)
              } else if (event.key === 'Enter' && selected) {
                event.preventDefault()
                onPick(selected)
              }
            }}
            className="min-w-0 flex-1 bg-transparent text-[13px] text-ink outline-none placeholder:text-ink-3"
          />
        </div>
      )}
      <div ref={filters} role="group" aria-label={t('ext.pack.filter')} className="flex h-8 shrink-0 items-center gap-1 overflow-x-auto border-b border-hairline px-2">
        {packs.map((pack, index) => (
          <button
            key={pack.id}
            type="button"
            aria-pressed={index === filterIndex}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => onPackFilter(pack.id)}
            className={`flex h-6 shrink-0 items-center gap-1.5 rounded-md px-2 text-[11.5px] hover:bg-fill ${index === filterIndex ? 'bg-accent/10 font-medium text-accent' : 'text-ink-2'}`}
          >
            {extensionPackLabel(pack, locale)} <span className="tabular-nums opacity-80">{pack.count}</span>
          </button>
        ))}
      </div>
      <div className={`grid min-h-0 flex-1 grid-cols-1 ${selected ? '@[560px]:grid-cols-[minmax(0,52fr)_minmax(0,48fr)]' : ''}`}>
        <div ref={list} tabIndex={-1} className="min-h-0 min-w-0 overflow-y-auto overscroll-contain bg-editor-canvas p-1.5">
          {sections.map(({ pack, items, expanded }) => (
            <div key={pack.id} className="pb-1">
              <PackHeading pack={pack} expanded={expanded} locked={searching} onToggle={() => { if (!searching) onTogglePack(pack.id) }} />
              {expanded && items.map((skill) => {
                const index = rowIndices.get(skill)!
                const starred = pins.includes(skill.name)
                const description = displayExtDescription(skill, original)
                return (
                  <div key={`${skill.insert}:${skill.path ?? ''}`} data-skill-index={index} onMouseEnter={() => onHover(index)}
                    className={`group relative rounded-md ${index === active ? 'bg-accent/10' : 'hover:bg-fill'}`}>
                    <button type="button" aria-pressed={index === active} onFocus={() => onHover(index)} onMouseDown={(event) => event.preventDefault()}
                      onClick={() => onPick(skill)} className={`block w-full min-w-0 px-2 py-1 text-left ${kind ? 'pr-8' : ''}`}>
                      <span className="block truncate font-mono text-[12.5px] leading-4 text-ink">{skill.insert}</span>
                      {description && <span className="block truncate text-[11.5px] leading-4 text-ink-2">{description}</span>}
                    </button>
                    {kind && <SkillPin kind={kind} skill={skill} pinned={starred} className={`absolute top-1 right-1.5 ${starred || index === active ? '' : 'opacity-0 group-hover:opacity-100 focus-visible:opacity-100'}`} />}
                  </div>
                )
              })}
            </div>
          ))}
          {!sections.length && <div className="px-2.5 py-3 text-[12px] text-ink-2">{t(loading ? 'ext.quickLoading' : searching ? 'ext.noMatch' : filterIndex === 1 ? 'ext.noPinned' : 'ext.quickEmpty')}</div>}
          {filterIndex === 0 && !searching && sections.length > 0 && packs[0].count === 1 && packs.some((pack) => pack.id === 'builtin') && (
            <p className="px-2.5 py-2 text-[12px] text-ink-2">{t(loading ? 'ext.quickLoading' : 'ext.quickEmpty')}</p>
          )}
        </div>
        {selected && (
          <aside className="hidden min-h-0 min-w-0 flex-col border-l border-hairline bg-editor-chrome @[560px]:flex">
            <div key={active} tabIndex={-1} className="min-h-0 flex-1 space-y-2.5 overflow-y-auto overscroll-contain px-3.5 py-3">
              <div className="flex items-start justify-between gap-2">
                <h2 className="min-w-0 font-mono text-[15px] font-semibold break-all text-ink">{selected.insert}</h2>
                {kind && <SkillPin kind={kind} skill={selected} pinned={pins.includes(selected.name)} />}
              </div>
              <PackBadges item={selected} />
              <DescriptionPreview item={selected} original={original} />
            </div>
            <div className="flex shrink-0 justify-end border-t border-hairline px-2.5 py-1">
              <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => onPick(selected)}
                className="rounded-md px-2 py-0.5 text-[11.5px] font-medium text-accent hover:bg-accent/10">{t('ext.quickInsert')}</button>
            </div>
          </aside>
        )}
      </div>
      <div className="flex min-h-[25px] shrink-0 items-center justify-between gap-x-2 border-t border-hairline px-3 text-[11px] text-ink-2">
        <span>{t('ext.quickNavHint')}</span>
        <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={onManage}
          className="rounded-md px-1 py-0.5 text-right hover:text-ink">{t('ext.manageAll')}</button>
      </div>
    </div>
  )
}

export function ExtensionsSettingsView() {
  const { toast } = useApp()
  const { locale } = useI18n()
  const chat = useChat()
  const draft = useDraft()
  const accounts = useSortedAccounts()
  const context = activeThread(chat) ?? draft
  const projectDir = context.projectDir
  const participants = context.participants.length ? context.participants : accounts.filter(isSignedIn).map((account) => account.id)
  const [accountId, setAccountId] = useState('')
  const account = accounts.find((item) => item.id === accountId) ?? pickDriver(context, accounts, participants)
  const { data, loading, reload } = useOverview(account?.id ?? null, projectDir)
  const [tab, setTab] = useState<TabId>('skills')
  const [revision, setRevision] = useState(0)
  const refresh = () => {
    void reload().then(() => setRevision((current) => current + 1))
  }
  const original = useShowOriginalDesc()
  const progress = useTranslateProgress()
  const [launching, setLaunching] = useState(false)
  const running = progress?.status === 'running'
  const count = data?.untranslatedCount ?? 0
  const translateLabel = running ? t('ext.translate.running', { done: progress.done, total: progress.total })
    : !data ? t('ext.translate.button')
      : count ? t('ext.translate.count', { n: count }) : t('ext.translate.complete')
  const translateDescriptions = async () => {
    if (running) {
      await window.agentswitch.ext.cancelTranslate().catch(() => {
        toast({ kind: 'error', title: t('ext.translate.cancelFailed') })
      })
      return
    }
    if (!account || !count || launching) return
    setLaunching(true)
    try {
      const result = await window.agentswitch.ext.translateDescriptions({ profileId: account.id, cwd: projectDir, locale })
      if (result.status === 'noop') invalidateExtCache()
      if (result.status === 'busy') toast({ kind: 'info', title: t('ext.translate.busy') })
      if (result.status === 'error') {
        toast({
          kind: 'error',
          title: t(result.error === 'cache-write' ? 'ext.translate.cacheWrite' : 'ext.translate.unavailable'),
          desc: result.translated ? t('ext.translate.partial', { n: result.translated }) : undefined
        })
      }
      if (result.status === 'cancelled' && result.translated) {
        toast({ kind: 'info', title: t('ext.translate.cancelledPartial', { n: result.translated }) })
      }
    } catch {
      toast({ kind: 'error', title: t('ext.translate.unavailable') })
    } finally {
      setLaunching(false)
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-editor-canvas">
      <div className="flex h-[39px] shrink-0 items-center gap-2 overflow-x-auto border-b border-hairline bg-elevated px-3 whitespace-nowrap">
        <label className="flex shrink-0 items-center gap-1.5 text-[12px] text-ink-2">
          {t('ext.accountSelect')}
          <select
            value={account?.id ?? ''}
            disabled={!accounts.length}
            onChange={(event) => setAccountId(event.target.value)}
            className="max-w-[132px] rounded-md bg-fill px-2 py-1 text-[12px] text-ink"
          >
            {!accounts.length && <option value="">{t('ext.noAccount')}</option>}
            {accounts.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
        </label>
        <div role="group" aria-label={t('set.extensions')} className="flex h-full shrink-0 items-stretch gap-1">
          {TABS.map((id) => (
            <button key={id} type="button" aria-pressed={tab === id} onClick={() => setTab(id)}
              className={`border-b-2 px-1.5 pt-0.5 text-[12px] ${tab === id ? 'border-accent font-medium text-accent' : 'border-transparent text-ink-2 hover:text-ink'}`}>
              {t(`ext.tab.${id}`)}
            </button>
          ))}
        </div>
        <span className="flex-1" />
        <div className="flex shrink-0 items-center gap-1 whitespace-nowrap">
          {data?.hasTranslations && (
            <div role="group" className="flex items-center text-[11.5px]">
              {[false, true].map((value) => (
                <button
                  key={String(value)}
                  type="button"
                  aria-pressed={original === value}
                  onClick={() => setShowOriginalDesc(value)}
                  className={`rounded-md px-1.5 py-1 hover:bg-fill ${original === value ? 'bg-accent/10 text-accent' : 'text-ink-3'}`}
                >
                  {t(value ? 'ext.translate.original' : 'ext.translate.translated')}
                </button>
              ))}
            </div>
          )}
          <button
            type="button"
            onClick={() => void translateDescriptions()}
            disabled={!running && (!count || loading || launching)}
            className="flex items-center gap-1.5 rounded-md px-2 py-1 text-[12px] text-ink-2 tabular-nums enabled:hover:bg-fill enabled:hover:text-ink disabled:text-ink-3"
            title={t('ext.translate.tooltip')}
          >
            {running && <Spinner size={11} />}
            <span>{translateLabel}</span>
            {running && <span className="text-ink-3">· {t('common.cancel')}</span>}
          </button>
          <button
            onClick={refresh}
            disabled={loading || !account}
            className="flex shrink-0 items-center gap-1 rounded-md px-2 py-1.5 text-[12px] text-ink-2 hover:bg-fill hover:text-ink disabled:opacity-60"
            title={t('ext.reload')}
          >
            {loading ? <Spinner size={11} /> : <IconRefresh size={12} />} {t('common.refresh')}
          </button>
        </div>
      </div>
      {account && data ? (
        <ExtensionWorkspace key={JSON.stringify([account.id, projectDir, tab])}
          account={account} data={data} tab={tab} projectDir={projectDir} revision={revision} onReload={refresh} />
      ) : <InventoryGuide tab={tab} message={t(!account ? 'ext.noAccount' : loading ? 'ext.loading' : 'ext.previewFailed')} />}
      {data && (
        <div className="shrink-0 border-t border-hairline bg-elevated px-3.5 py-1.5 text-[11px] text-ink-2 tabular-nums">
          <div className="truncate">
            {t('ext.readFrom', { dir: data.configDir })}
            {data.project ? ` · ${data.project.split('/').filter(Boolean).pop()}` : ''}
            {data.errors > 0 && <span className="text-warn"> · {t('ext.parseErrors', { n: data.errors })}</span>}
          </div>
        </div>
      )}
    </div>
  )
}
