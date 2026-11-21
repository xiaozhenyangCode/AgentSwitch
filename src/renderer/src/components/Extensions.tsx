import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { MsgKey } from '@shared/i18n'
import type { ExtFileText, ExtOverview, ExtSource, McpServer, ProfileKind, ProfileState, RuleScope, SkillItem } from '@shared/types'
import { pinnedFirst, togglePin, usePins } from '../state/extensions'
import { t } from '../state/i18n'
import { IconChevronDown, IconFile, IconFolder, IconPuzzle, IconRefresh, IconSearch, IconSlash, IconStar, IconX, Spinner } from './icons'

const popover = 'rounded-2xl bg-surface/95 p-1.5 shadow-[0_0_0_1px_var(--ring),0_12px_40px_rgba(0,0,0,0.16)] backdrop-blur-xl'

const SOURCE_KEY = { project: 'ext.src.project', global: 'ext.src.global', plugin: 'ext.src.plugin', builtin: 'ext.src.builtin' } as const
export const sourceLabel = (s: ExtSource): string => t(SOURCE_KEY[s])
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

const Tag = ({ children, title }: { children: string; title?: string }) => (
  <span title={title} className="shrink-0 rounded-[5px] px-1.5 py-px text-[10.5px] leading-4 text-ink-3 shadow-[inset_0_0_0_1px_var(--ring)]">
    {children}
  </span>
)

/** The / menu above the composer. Keyboard handling lives in the composer. */
export function SlashMenu({
  account,
  items,
  total,
  loading,
  active,
  pinned = [],
  onPick,
  onHover
}: {
  account: ProfileState | null
  items: SkillItem[]
  /** Pinned skill names (marked with a star; the caller puts them first). */
  pinned?: string[]
  /** Skills available before filtering (0 → empty state). */
  total: number
  loading: boolean
  active: number
  onPick: (it: SkillItem) => void
  onHover: (i: number) => void
}) {
  const listRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-i="${active}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [active, items])
  return (
    <div className={popover + ' flex max-h-[380px] w-[460px] flex-col'}>
      <div className="flex items-center gap-1.5 px-2.5 pt-1 pb-1.5 text-[12px] text-ink-3">
        <IconSlash size={13} /> <span className="min-w-0 flex-1 truncate">{account ? t('ext.skillsOf', { name: account.name }) : t('ext.skills')}</span>
        {loading && <Spinner size={11} />}
        {total > 0 && <span className="tabular-nums">{t('ext.count', { n: total })}</span>}
      </div>
      <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto">
        {items.map((it, i) => (
          <div
            key={it.insert + it.source}
            data-i={i}
            onMouseDown={(e) => e.preventDefault() /* keep textarea focus */}
            onMouseMove={() => i !== active && onHover(i)}
            onClick={() => onPick(it)}
            className={`flex cursor-default items-center gap-2.5 rounded-[10px] px-2.5 py-1.5 ${i === active ? 'bg-accent/10' : ''}`}
          >
            <span className="min-w-0 flex-1">
              <span className="block truncate font-mono text-[13px] leading-5 text-ink">{it.insert}</span>
              {it.description && <span className="block truncate text-[11.5px] leading-4 text-ink-3">{it.description}</span>}
            </span>
            {pinned.includes(it.name) && <IconStar size={12} filled className="shrink-0 text-warn" />}
            <Tag title={it.plugin}>{sourceLabel(it.source)}</Tag>
          </div>
        ))}
        {!items.length && <div className="px-2.5 py-2.5 text-[13px] text-ink-3">{loading && !total ? t('ext.loading') : total ? t('ext.noMatch') : t('ext.noSkills')}</div>}
      </div>
    </div>
  )
}

const STATE_DOT: Record<McpServer['state'], string> = { on: 'bg-ok', off: 'bg-ink-3/40', pending: 'bg-warn' }

function McpRow({ s }: { s: McpServer }) {
  const note = s.state === 'off' ? t('ext.mcpOff') : s.state === 'pending' ? t('ext.mcpPending') : s.local ? t('ext.mcpLocal') : s.managed ? t('ext.mcpManaged') : ''
  return (
    <div className="flex h-8 items-center gap-2.5 rounded-[10px] px-2.5">
      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${STATE_DOT[s.state]}`} />
      <span className={`min-w-0 truncate text-[13px] ${s.state === 'on' ? 'text-ink' : 'text-ink-3'}`}>{s.name}</span>
      {s.plugin && <span className="min-w-0 truncate text-[11px] text-ink-3">{s.plugin}</span>}
      <span className="flex-1" />
      {note && <span className="shrink-0 text-[11px] text-ink-3">{note}</span>}
      <span className="shrink-0 font-mono text-[10.5px] text-ink-3">{s.transport}</span>
    </div>
  )
}

// ---- extensions entry + panel ---------------------------------------------------------------

type TabId = 'skills' | 'agents' | 'plugins' | 'mcp' | 'context'
const TABS: TabId[] = ['skills', 'agents', 'plugins', 'mcp', 'context']
type SkillFilter = 'all' | 'pinned' | ExtSource
const SKILL_FILTERS: SkillFilter[] = ['all', 'pinned', 'project', 'global', 'plugin', 'builtin']

const has = (q: string, ...fields: (string | null | undefined)[]) => !q || fields.some((f) => f && f.toLowerCase().includes(q))
const fmtBytes = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`)
const SCOPE_KEY: Record<RuleScope, MsgKey> = {
  managed: 'ext.scope.managed',
  global: 'ext.src.global',
  project: 'ext.src.project',
  plugin: 'ext.src.plugin'
}

/** Counts behind the toolbar entry (what is in effect). */
function counts(d: ExtOverview | null) {
  if (!d) return null
  return {
    skills: d.skills.length,
    agents: d.agents.length,
    plugins: d.plugins.filter((p) => p.enabled).length,
    mcp: d.mcp.filter((s) => s.state === 'on').length,
    rules: d.rules.length,
    hooks: d.hooks.filter((h) => !h.off).length
  }
}

/**
 * Toolbar entry next to the model capsule: puzzle icon + total of what loads for this account and
 * project; the tooltip breaks it down. Clicking toggles the panel (rendered by the composer).
 */
export function ExtensionsButton({ data, open, onToggle }: { data: ExtOverview | null; open: boolean; onToggle: () => void }) {
  const c = counts(data)
  const total = c ? c.skills + c.agents + c.mcp + c.rules + c.hooks : 0
  const tip = c
    ? t('ext.tip', {
        skills: c.skills,
        agents: c.agents,
        plugins: c.plugins,
        mcp: c.mcp,
        rules: c.rules,
        hooks: c.hooks
      })
    : t('ext.title')
  return (
    <button
      // the panel closes on outside mousedown: keep this one from counting as outside
      onMouseDown={(e) => e.stopPropagation()}
      onClick={onToggle}
      className={`flex h-7 items-center gap-1 rounded-full px-2.5 text-[12px] font-medium tabular-nums text-ink-2 transition-colors hover:bg-black/[0.07] hover:text-ink ${open ? 'bg-black/[0.08] text-ink' : 'bg-black/[0.045]'}`}
      title={tip}
    >
      <IconPuzzle size={13} className="text-ink-3" />
      {t('ext.title')}
      {total > 0 && <span className="text-ink-3">· {total}</span>}
    </button>
  )
}

/** Read-only text of a scanned file (main process whitelist, 64 KB). */
function FilePreview({ path }: { path: string }) {
  const [state, setState] = useState<{
    text: ExtFileText | null
    failed: boolean
  }>({ text: null, failed: false })
  useEffect(() => {
    let live = true
    setState({ text: null, failed: false })
    window.agentswitch.ext.read(path).then(
      (text) => live && setState({ text, failed: false }),
      () => live && setState({ text: null, failed: true })
    )
    return () => {
      live = false
    }
  }, [path])
  return (
    <div className="mx-2.5 mt-1 mb-2 rounded-[10px] bg-black/[0.035] shadow-[inset_0_0_0_1px_var(--ring)]">
      <div className="flex items-center gap-2 px-2.5 pt-1.5 text-[11px] text-ink-3">
        <span className="min-w-0 flex-1 truncate font-mono" title={path}>
          {path}
        </span>
        <button onClick={() => void window.agentswitch.ext.reveal(path)} className="flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 hover:bg-black/[0.06] hover:text-ink">
          <IconFolder size={11} /> {t('common.showInFinder')}
        </button>
      </div>
      {state.failed ? (
        <div className="px-2.5 py-2 text-[12px] text-ink-3">{t('ext.previewFailed')}</div>
      ) : !state.text ? (
        <div className="px-2.5 py-2 text-[12px] text-ink-3">{t('ext.loading')}</div>
      ) : (
        <>
          <pre className="max-h-56 overflow-auto px-2.5 py-1.5 font-mono text-[11.5px] leading-[17px] whitespace-pre-wrap text-ink-2 select-text">{state.text.text || t('ext.previewEmpty')}</pre>
          {state.text.truncated && <div className="px-2.5 pb-1.5 text-[11px] text-ink-3">{t('ext.previewTruncated', { size: fmtBytes(state.text.bytes) })}</div>}
        </>
      )}
    </div>
  )
}

const Chevron = ({ open }: { open: boolean }) => <IconChevronDown size={12} className={`shrink-0 text-ink-3 transition-transform ${open ? '' : '-rotate-90'}`} />

const rowBtn = 'shrink-0 rounded-md px-2 py-0.5 text-[11.5px] font-medium text-accent hover:bg-accent/10'
const Empty = ({ children }: { children: ReactNode }) => <div className="px-3 py-8 text-center text-[13px] leading-5 text-ink-3">{children}</div>
const Section = ({ children, n }: { children: string; n?: number }) => (
  <div className="flex items-center gap-1.5 px-2.5 pt-2 pb-1 text-[11px] font-medium text-ink-3">
    {children}
    {n !== undefined && <span className="tabular-nums">{n}</span>}
  </div>
)

function SkillsTab({ items, kind, q, onInsert }: { items: SkillItem[]; kind: ProfileKind | null; q: string; onInsert: (token: string) => void }) {
  const [filter, setFilter] = useState<SkillFilter>('all')
  const [open, setOpen] = useState<string | null>(null)
  const pins = usePins(kind)
  const list = pinnedFirst(
    items.filter((it) => (filter === 'all' ? true : filter === 'pinned' ? pins.includes(it.name) : it.source === filter) && has(q, it.name, it.description, it.path, it.plugin)),
    pins
  )
  return (
    <>
      <div className="flex flex-wrap gap-1 px-2 pt-1 pb-1.5">
        {SKILL_FILTERS.map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={`rounded-full px-2.5 py-0.5 text-[11.5px] transition-colors ${filter === f ? 'bg-accent/12 font-medium text-accent' : 'text-ink-2 hover:bg-black/[0.05]'}`}
          >
            {f === 'all' ? t('ext.filter.all') : f === 'pinned' ? t('ext.filter.pinned') : sourceLabel(f)}
          </button>
        ))}
      </div>
      {list.map((it) => {
        const id = it.insert + it.source + (it.plugin ?? '')
        const pinned = pins.includes(it.name)
        const expanded = open === id
        return (
          <div key={id}>
            <div className="group flex items-center gap-2 rounded-[10px] px-2.5 py-1.5 hover:bg-black/[0.035]">
              <button onClick={() => kind && togglePin(kind, it.name)} className={`shrink-0 ${pinned ? 'text-warn' : 'text-ink-3/50 hover:text-ink-2'}`} title={pinned ? t('ext.unpin') : t('ext.pin')}>
                <IconStar size={13} filled={pinned} />
              </button>
              <button className="flex min-w-0 flex-1 cursor-default items-center gap-2 text-left" onClick={() => it.path && setOpen(expanded ? null : id)}>
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-mono text-[13px] leading-5 text-ink">{it.insert}</span>
                  {it.description && <span className="block truncate text-[11.5px] leading-4 text-ink-3">{it.description}</span>}
                </span>
                {it.kind === 'command' && <Tag>{t('ext.command')}</Tag>}
                <Tag title={it.plugin}>{it.plugin ? `${sourceLabel(it.source)} · ${it.plugin}` : sourceLabel(it.source)}</Tag>
                {it.path && <Chevron open={expanded} />}
              </button>
              <button className={rowBtn} onClick={() => onInsert(it.insert)} title={t('ext.insertHint', { token: it.insert })}>
                {t('ext.insert')}
              </button>
            </div>
            {expanded && it.path && <FilePreview path={it.path} />}
          </div>
        )
      })}
      {!list.length && <Empty>{items.length ? (filter === 'pinned' && !q ? t('ext.noPinned') : t('ext.noMatchAny')) : t('ext.noSkills')}</Empty>}
    </>
  )
}

function AgentsTab({ data, kind, q, onInsert }: { data: ExtOverview; kind: ProfileKind | null; q: string; onInsert: (token: string) => void }) {
  const [open, setOpen] = useState<string | null>(null)
  const list = data.agents.filter((a) => has(q, a.name, a.description, a.path, a.plugin))
  const phrase = (name: string) => t(kind === 'codex' ? 'ext.agentPhraseCodex' : 'ext.agentPhrase', { name })
  return (
    <>
      {list.map((a) => {
        const id = a.path + a.name
        const expanded = open === id
        return (
          <div key={id}>
            <div className="flex items-center gap-2 rounded-[10px] px-2.5 py-1.5 hover:bg-black/[0.035]">
              <button className="flex min-w-0 flex-1 cursor-default items-center gap-2 text-left" onClick={() => setOpen(expanded ? null : id)}>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] leading-5 font-medium text-ink">{a.name}</span>
                  {a.description && <span className="block truncate text-[11.5px] leading-4 text-ink-3">{a.description}</span>}
                </span>
                {a.model && <Tag>{a.model}</Tag>}
                <Tag title={a.plugin}>{a.plugin ? `${sourceLabel(a.source)} · ${a.plugin}` : sourceLabel(a.source)}</Tag>
                <Chevron open={expanded} />
              </button>
              <button className={rowBtn} onClick={() => onInsert(phrase(a.name))} title={phrase(a.name)}>
                {t('ext.use')}
              </button>
            </div>
            {expanded && (
              <>
                {a.tools && <div className="truncate px-2.5 pb-0.5 pl-5 text-[11px] text-ink-3">{t('ext.agentTools', { tools: a.tools })}</div>}
                <FilePreview path={a.path} />
              </>
            )}
          </div>
        )
      })}
      {!list.length && <Empty>{data.agents.length ? t('ext.noMatchAny') : data.agentsDynamic ? t('ext.agentsDynamic') : t('ext.noAgents')}</Empty>}
    </>
  )
}

function PluginsTab({ data, q }: { data: ExtOverview; q: string }) {
  const [open, setOpen] = useState<string | null>(null)
  const list = data.plugins.filter((p) => has(q, p.name, p.key, p.description, p.path))
  const groups: {
    key: 'skills' | 'agents' | 'mcp' | 'hooks' | 'rules'
    label: string
  }[] = [
    { key: 'skills', label: 'Skills' },
    { key: 'agents', label: 'Agents' },
    { key: 'mcp', label: 'MCP' },
    { key: 'hooks', label: 'Hooks' },
    { key: 'rules', label: t('ext.rules') }
  ]
  return (
    <>
      {list.map((p) => {
        const expanded = open === p.key
        const parts = groups.filter((g) => p[g.key].length).map((g) => `${g.label} ${p[g.key].length}`)
        return (
          <div key={p.key} className={p.enabled ? '' : 'opacity-55'}>
            <button className="flex w-full cursor-default items-center gap-2 rounded-[10px] px-2.5 py-1.5 text-left hover:bg-black/[0.035]" onClick={() => setOpen(expanded ? null : p.key)}>
              <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${p.enabled ? 'bg-ok' : 'bg-ink-3/40'}`} />
              <span className="min-w-0 flex-1">
                <span className="flex items-baseline gap-1.5">
                  <span className="truncate text-[13px] leading-5 font-medium text-ink">{p.name}</span>
                  {p.version && <span className="shrink-0 font-mono text-[10.5px] text-ink-3">{p.version}</span>}
                </span>
                <span className="block truncate text-[11.5px] leading-4 text-ink-3">{parts.length ? parts.join(' · ') : p.description || t('ext.pluginNoContent')}</span>
              </span>
              {!p.enabled && <Tag>{t('ext.disabled')}</Tag>}
              <Tag title={p.key}>{p.marketplace ?? sourceLabel(p.source)}</Tag>
              <Chevron open={expanded} />
            </button>
            {expanded && (
              <div className="mx-2.5 mt-0.5 mb-2 space-y-1 rounded-[10px] bg-black/[0.035] px-2.5 py-2 text-[12px] shadow-[inset_0_0_0_1px_var(--ring)]">
                {p.description && <div className="text-ink-2">{p.description}</div>}
                {groups.map(
                  (g) =>
                    p[g.key].length > 0 && (
                      <div key={g.key} className="flex gap-2">
                        <span className="w-12 shrink-0 text-ink-3">{g.label}</span>
                        <span className="min-w-0 flex-1 font-mono text-[11.5px] break-words text-ink-2">{p[g.key].join(', ')}</span>
                      </div>
                    )
                )}
                <div className="truncate font-mono text-[11px] text-ink-3" title={p.path}>
                  {p.key} · {p.path}
                </div>
              </div>
            )}
          </div>
        )
      })}
      {!list.length && <Empty>{data.plugins.length ? t('ext.noMatchAny') : t('ext.noPlugins')}</Empty>}
    </>
  )
}

function McpTab({ data, q }: { data: ExtOverview; q: string }) {
  const servers = data.mcp.filter((s) => has(q, s.name, s.plugin))
  const groups = (['project', 'global', 'plugin', 'builtin'] as const).map((src) => ({ src, list: servers.filter((s) => s.source === src) })).filter((g) => g.list.length)
  return (
    <>
      {groups.map((g) => (
        <div key={g.src} className="pb-1">
          <Section n={g.list.length}>{sourceLabel(g.src)}</Section>
          {g.list.map((s) => (
            <McpRow key={g.src + s.name + (s.plugin ?? '')} s={s} />
          ))}
        </div>
      ))}
      {!servers.length && <Empty>{data.mcp.length ? t('ext.noMatchAny') : t('ext.mcpEmpty')}</Empty>}
      {data.remoteNote && <div className="px-2.5 pt-1 text-[11px] text-ink-3">{t('ext.remoteNote')}</div>}
    </>
  )
}

function ContextTab({ data, q }: { data: ExtOverview; q: string }) {
  const [open, setOpen] = useState<string | null>(null)
  const rules = data.rules.filter((r) => has(q, r.display, r.path, r.plugin))
  const hooks = data.hooks.filter((h) => has(q, h.event, h.matcher, h.summary, h.plugin, h.name, h.file, h.type))
  const events = [...new Set(hooks.map((h) => h.event))]
  return (
    <>
      <Section n={rules.length}>{t('ext.rules')}</Section>
      {rules.map((r) => {
        const expanded = open === r.path
        return (
          <div key={r.path}>
            <button className="flex w-full cursor-default items-center gap-2 rounded-[10px] px-2.5 py-1.5 text-left hover:bg-black/[0.035]" onClick={() => setOpen(expanded ? null : r.path)}>
              <IconFile size={13} className="shrink-0 text-ink-3" />
              <span className="min-w-0 flex-1">
                <span className="block truncate font-mono text-[12.5px] leading-5 text-ink" title={r.path}>
                  {r.display}
                </span>
                <span className="block truncate text-[11px] leading-4 text-ink-3">
                  {t('ext.ruleMeta', {
                    size: fmtBytes(r.bytes),
                    lines: r.lines
                  })}
                  {r.importedBy ? ` · ${t('ext.importedBy', { file: r.importedBy })}` : ''}
                  {r.truncated ? ` · ${t('ext.ruleTruncated')}` : ''}
                </span>
              </span>
              {r.truncated && <span className="shrink-0 text-[11px] text-warn">{t('ext.partial')}</span>}
              <Tag title={r.plugin}>{r.plugin ? `${t(SCOPE_KEY[r.scope])} · ${r.plugin}` : t(SCOPE_KEY[r.scope])}</Tag>
              <Chevron open={expanded} />
            </button>
            {expanded && <FilePreview path={r.path} />}
          </div>
        )
      })}
      {!rules.length && <div className="px-2.5 py-2 text-[12.5px] text-ink-3">{data.rules.length ? t('ext.noMatchAny') : t('ext.noRules')}</div>}

      <Section n={hooks.filter((h) => !h.off).length}>{t('ext.hooks')}</Section>
      {events.map((ev) => (
        <div key={ev} className="pb-1">
          <div className="px-2.5 pt-1 font-mono text-[11.5px] font-medium text-ink-2">{ev}</div>
          {hooks
            .filter((h) => h.event === ev)
            .map((h, i) => (
              <div key={i} className={`flex items-center gap-2 rounded-[10px] px-2.5 py-1 ${h.off ? 'opacity-55' : ''}`} title={h.file}>
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-mono text-[12px] leading-5 text-ink">
                    {h.matcher ? <span className="text-ink-3">{h.matcher} · </span> : null}
                    {h.summary || h.type}
                  </span>
                  <span className="block truncate text-[11px] leading-4 text-ink-3">{[h.name, h.file].filter(Boolean).join(' · ')}</span>
                </span>
                {h.off && <Tag>{t('ext.disabled')}</Tag>}
                <Tag>{h.type}</Tag>
                <Tag title={h.plugin}>{h.plugin ? `${sourceLabel(h.source)} · ${h.plugin}` : sourceLabel(h.source)}</Tag>
              </div>
            ))}
        </div>
      ))}
      {!hooks.length && <div className="px-2.5 py-2 text-[12.5px] text-ink-3">{data.hooks.length ? t('ext.noMatchAny') : t('ext.noHooks')}</div>}
    </>
  )
}

/**
 * Read-only panel over the composer: what the lead account loads in this project (skills,
 * agents, plugins, MCP, rule files, hooks). Reads local config only; no CLI run, no model call.
 */
export function ExtensionsPanel({
  account,
  data,
  loading,
  onReload,
  onInsert,
  onClose
}: {
  account: ProfileState | null
  data: ExtOverview | null
  loading: boolean
  onReload: () => void
  onInsert: (token: string) => void
  onClose: () => void
}) {
  const [tab, setTab] = useState<TabId>('skills')
  const [query, setQuery] = useState('')
  const ref = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const q = query.trim().toLowerCase()

  useEffect(() => {
    input.current?.focus()
    const h = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && onClose()
    const k = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      if (input.current && input.current.value) setQuery('')
      else onClose()
    }
    window.addEventListener('mousedown', h)
    window.addEventListener('keydown', k)
    return () => {
      window.removeEventListener('mousedown', h)
      window.removeEventListener('keydown', k)
    }
  }, [onClose])

  const c = counts(data)
  const n: Record<TabId, number> = c
    ? {
        skills: c.skills,
        agents: c.agents,
        plugins: data!.plugins.length,
        mcp: c.mcp,
        context: c.rules + c.hooks
      }
    : { skills: 0, agents: 0, plugins: 0, mcp: 0, context: 0 }
  const kind = account?.kind ?? null

  return (
    <div ref={ref} className={popover + ' flex h-[520px] w-[720px] max-w-[calc(100vw-64px)] flex-col p-0'}>
      <div className="flex items-center gap-2 border-b border-hairline px-3.5 py-2.5">
        <IconSearch size={14} className="shrink-0 text-ink-3" />
        <input
          ref={input}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('ext.search')}
          className="min-w-0 flex-1 bg-transparent text-[13.5px] text-ink outline-none placeholder:text-ink-3"
        />
        <span className="shrink-0 truncate text-[12px] text-ink-3">{account ? t('ext.panelOf', { name: account.name }) : ''}</span>
        <button onClick={onClose} className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-ink-3 hover:bg-black/[0.06] hover:text-ink" title={t('common.close')}>
          <IconX size={13} />
        </button>
      </div>
      <div className="flex gap-0.5 px-2 pt-1.5">
        {TABS.map((id) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            className={`flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-[12.5px] transition-colors ${tab === id ? 'bg-black/[0.07] font-medium text-ink' : 'text-ink-2 hover:bg-black/[0.04]'}`}
          >
            {t(`ext.tab.${id}`)}
            <span className="text-[11px] text-ink-3 tabular-nums">{n[id]}</span>
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-1.5 py-1">
        {!account ? (
          <Empty>{t('ext.noAccount')}</Empty>
        ) : !data ? (
          <Empty>{t('ext.loading')}</Empty>
        ) : tab === 'skills' ? (
          <SkillsTab items={data.skills} kind={kind} q={q} onInsert={onInsert} />
        ) : tab === 'agents' ? (
          <AgentsTab data={data} kind={kind} q={q} onInsert={onInsert} />
        ) : tab === 'plugins' ? (
          <PluginsTab data={data} q={q} />
        ) : tab === 'mcp' ? (
          <McpTab data={data} q={q} />
        ) : (
          <ContextTab data={data} q={q} />
        )}
      </div>
      <div className="flex items-center gap-2 border-t border-hairline px-3.5 py-2 text-[11px] text-ink-3">
        <span className="min-w-0 flex-1 truncate" title={data ? [data.configDir, data.project].filter(Boolean).join('\n') : ''}>
          {data ? t('ext.readFrom', { dir: data.configDir }) + (data.project ? ` · ${data.project.split('/').filter(Boolean).pop()}` : '') : ''}
          {data && data.errors > 0 && <span className="text-warn"> · {t('ext.parseErrors', { n: data.errors })}</span>}
        </span>
        <span className="shrink-0">{t('ext.readOnly')}</span>
        <button
          onClick={onReload}
          disabled={loading || !account}
          className="flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 hover:bg-black/[0.05] hover:text-ink disabled:opacity-60"
          title={t('ext.reload')}
        >
          {loading ? <Spinner size={11} /> : <IconRefresh size={12} />} {t('common.refresh')}
        </button>
      </div>
    </div>
  )
}
