import { useEffect, useRef, useState } from 'react'
import type { ExtSource, McpServer, ProfileState, SkillItem } from '@shared/types'
import { useMcp } from '../state/extensions'
import { t } from '../state/i18n'
import { IconPlug, IconRefresh, IconSlash, Spinner } from './icons'

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
  onPick,
  onHover
}: {
  account: ProfileState | null
  items: SkillItem[]
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

/**
 * Read-only MCP indicator next to the model capsule: `MCP · n` (servers that load), or a faint
 * plug when nothing is configured. The popover lists what the account + project would load.
 */
export function McpButton({ account, cwd }: { account: ProfileState | null; cwd: string | null }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const { data, loading, reload } = useMcp(account?.id ?? null, cwd)
  useEffect(() => {
    if (!open) return
    void reload()
    const h = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false)
    const k = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    window.addEventListener('mousedown', h)
    window.addEventListener('keydown', k)
    return () => {
      window.removeEventListener('mousedown', h)
      window.removeEventListener('keydown', k)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const servers = data?.servers ?? []
  const on = servers.filter((s) => s.state === 'on').length
  const groups = (['project', 'global', 'plugin', 'builtin'] as const).map((src) => ({ src, list: servers.filter((s) => s.source === src) })).filter((g) => g.list.length)

  return (
    <div ref={ref} className="relative">
      {servers.length ? (
        <button
          onClick={() => setOpen((o) => !o)}
          className={`flex h-7 items-center gap-1 rounded-full px-2.5 text-[12px] font-medium tabular-nums text-ink-2 transition-colors hover:bg-black/[0.07] hover:text-ink ${open ? 'bg-black/[0.08] text-ink' : 'bg-black/[0.045]'}`}
          title={t('ext.mcpHint')}
        >
          <IconPlug size={12} className="text-ink-3" />
          MCP · {on}
        </button>
      ) : (
        <button
          onClick={() => setOpen((o) => !o)}
          className={`flex h-7 w-7 items-center justify-center rounded-full text-ink-3/70 transition-colors hover:bg-black/[0.05] hover:text-ink-2 ${open ? 'bg-black/[0.06] text-ink-2' : ''}`}
          title={t('ext.mcpNone')}
        >
          <IconPlug size={14} />
        </button>
      )}
      {open && (
        <div className={popover + ' absolute bottom-9 left-0 z-30 flex max-h-[440px] w-80 flex-col'}>
          <div className="flex items-center gap-2 px-2.5 pt-1 pb-1.5 text-[12px] text-ink-3">
            <span className="min-w-0 flex-1 truncate">{account ? t('ext.mcpTitle', { name: account.name }) : t('ext.mcp')}</span>
            <button
              onClick={() => void reload()}
              disabled={loading}
              className="flex items-center gap-1 rounded-md px-1.5 py-0.5 hover:bg-black/[0.05] hover:text-ink disabled:opacity-60"
              title={t('ext.reload')}
            >
              {loading ? <Spinner size={11} /> : <IconRefresh size={12} />} {t('common.refresh')}
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {groups.map((g) => (
              <div key={g.src} className="pb-1">
                <div className="px-2.5 pt-1 pb-0.5 text-[11px] font-medium text-ink-3">{sourceLabel(g.src)}</div>
                {g.list.map((s) => (
                  <McpRow key={g.src + s.name + (s.plugin ?? '')} s={s} />
                ))}
              </div>
            ))}
            {(data || !account) && !servers.length && <div className="px-2.5 py-3 text-[13px] text-ink-3">{t('ext.mcpEmpty')}</div>}
            {!data && account && <div className="px-2.5 py-3 text-[13px] text-ink-3">{t('ext.loading')}</div>}
          </div>
          {data && (
            <div className="mt-1 space-y-0.5 border-t border-hairline px-2.5 pt-1.5 pb-0.5 text-[11px] leading-4 text-ink-3">
              <div className="truncate" title={[data.configDir, data.project].filter(Boolean).join('\n')}>
                {t('ext.readFrom', { dir: data.configDir })}
                {data.project ? ` · ${data.project.split('/').filter(Boolean).pop()}` : ''}
              </div>
              {data.remoteNote && <div>{t('ext.remoteNote')}</div>}
              {data.errors > 0 && <div className="text-warn">{t('ext.parseErrors', { n: data.errors })}</div>}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
