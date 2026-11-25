import { useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import type { ProfileKind } from '@shared/types'
import { useEscape } from '../lib/escStack'
import { useApp } from '../state/AppContext'
import {
  applyThreadImport,
  buildThreadBundle,
  localProjectsByName,
  threadMessages,
  useChat,
  type ExportedThread,
  type ImportConflictMode,
  type Thread,
  type ThreadBundle
} from '../state/chat'
import { t } from '../state/i18n'
import { KindAvatar } from './common'
import { IconFolder, IconX } from './icons'

const pad = (n: number) => String(n).padStart(2, '0')
const fmtDate = (ts: number) => {
  const d = new Date(ts)
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}
const todayStamp = () => {
  const d = new Date()
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}
const folderBase = (p: string | null | undefined): string | null => {
  if (!p) return null
  return p.replace(/\/+$/, '').split('/').filter(Boolean).pop() || null
}

type DiffKind = 'new' | 'newer' | 'older' | 'same'

function diffOf(item: ExportedThread, local: Thread | undefined): DiffKind {
  if (!local) return 'new'
  const impCount = item.thread.messages.length
  const locCount = threadMessages(local).length
  if (item.thread.updatedAt > local.updatedAt) return 'newer'
  if (item.thread.updatedAt < local.updatedAt) return 'older'
  if (impCount > locCount) return 'newer'
  if (impCount < locCount) return 'older'
  return 'same'
}

export function ExportThreadsDialog({ onClose }: { onClose: () => void }) {
  const { profiles, byId, toast } = useApp()
  const chat = useChat()
  useEscape(onClose)

  const threads = useMemo(
    () => chat.threads.filter((th) => !th.preview).sort((a, b) => b.updatedAt - a.updatedAt),
    [chat.threads]
  )
  const [selected, setSelected] = useState<Set<string>>(() => new Set(threads.map((th) => th.id)))
  const [busy, setBusy] = useState(false)

  const groups = useMemo(() => {
    const map = new Map<string, { name: string | null; dir: string | null; items: Thread[] }>()
    for (const th of threads) {
      const name = folderBase(th.projectDir)
      const key = name ?? ''
      const cur = map.get(key)
      if (cur) cur.items.push(th)
      else map.set(key, { name, dir: th.projectDir, items: [th] })
    }
    return [...map.values()]
  }, [threads])

  const toggleOne = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const toggleGroup = (items: Thread[]) =>
    setSelected((prev) => {
      const allOn = items.every((it) => prev.has(it.id))
      const next = new Set(prev)
      for (const it of items) {
        if (allOn) next.delete(it.id)
        else next.add(it.id)
      }
      return next
    })

  const runExport = async () => {
    if (!selected.size || busy) return
    setBusy(true)
    try {
      const bundle = buildThreadBundle(selected, profiles)
      const res = await window.agentswitch.sys.exportThreadsFile(
        `AgentSwitch-chats-${todayStamp()}.json`,
        JSON.stringify(bundle, null, 2)
      )
      if (!res) return
      toast({ kind: 'success', title: t('xfer.exportDone', { n: bundle.threads.length }), desc: res.path })
      onClose()
    } catch (e) {
      toast({ kind: 'error', title: t('xfer.exportFailed'), desc: e instanceof Error ? e.message : String(e) })
    } finally {
      setBusy(false)
    }
  }

  const kindOf = (th: Thread): ProfileKind | null =>
    (th.driver.profileId ? byId(th.driver.profileId)?.kind : undefined) ??
    th.imported?.kind ??
    [...th.messages].reverse().find((m) => m.role === 'assistant')?.agent.kind ??
    null

  return createPortal(
    <div
      className="no-drag fixed inset-0 z-[60] flex items-center justify-center bg-(--scrim-soft) scrim-in"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="sheet-in flex h-[560px] max-h-[85vh] w-[660px] max-w-[92vw] flex-col overflow-hidden rounded-2xl bg-surface shadow-[0_0_0_1px_var(--ring),0_24px_64px_rgba(0,0,0,0.24)]">
        <div className="flex items-center gap-3 border-b border-hairline px-5 py-3.5">
          <div className="min-w-0 flex-1">
            <h3 className="text-[15px] font-semibold text-ink">{t('xfer.exportTitle')}</h3>
            <p className="mt-0.5 text-[12px] text-ink-3">{t('xfer.exportDesc')}</p>
          </div>
          <button onClick={onClose} className="grid h-7 w-7 place-items-center rounded-lg text-ink-3 hover:bg-black/[0.06] hover:text-ink" title={t('common.close')}>
            <IconX size={14} />
          </button>
        </div>

        <div className="flex items-center gap-2 border-b border-hairline bg-black/[0.02] px-5 py-2 text-[12px]">
          <button onClick={() => setSelected(new Set(threads.map((th) => th.id)))} className="rounded-md px-2 py-0.5 font-medium text-accent hover:bg-accent/10">
            {t('xfer.selectAll')}
          </button>
          <button onClick={() => setSelected(new Set())} className="rounded-md px-2 py-0.5 text-ink-2 hover:bg-black/[0.05] hover:text-ink">
            {t('xfer.selectNone')}
          </button>
          <span className="flex-1" />
          <span className="tabular-nums text-ink-3">{t('xfer.selectedCount', { n: selected.size, total: threads.length })}</span>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          {!threads.length && <div className="py-12 text-center text-[13px] text-ink-3">{t('xfer.emptyLocal')}</div>}
          {groups.map((g) => {
            const checkedCount = g.items.filter((it) => selected.has(it.id)).length
            const allOn = checkedCount === g.items.length
            return (
              <div key={g.name ?? '_'} className="mb-3 overflow-hidden rounded-xl border border-hairline bg-surface">
                <label className="flex cursor-pointer items-center gap-2 bg-black/[0.025] px-3 py-2 select-none">
                  <input type="checkbox" checked={allOn} onChange={() => toggleGroup(g.items)} className="h-3.5 w-3.5 accent-accent" />
                  <IconFolder size={14} className="shrink-0 text-ink-3" />
                  <span className="text-[13px] font-semibold text-ink">{g.name ?? t('nav.noProject')}</span>
                  {g.dir && (
                    <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-ink-3" title={g.dir}>
                      {g.dir}
                    </span>
                  )}
                  <span className="shrink-0 text-[11.5px] text-ink-3 tabular-nums">
                    {checkedCount}/{g.items.length}
                  </span>
                </label>
                <div className="divide-y divide-hairline">
                  {g.items.map((th) => {
                    const k = kindOf(th)
                    const count = threadMessages(th).length
                    return (
                      <label key={th.id} className="flex cursor-pointer items-center gap-2.5 px-3 py-2 hover:bg-black/[0.02] select-none">
                        <input type="checkbox" checked={selected.has(th.id)} onChange={() => toggleOne(th.id)} className="h-3.5 w-3.5 accent-accent" />
                        {k && <KindAvatar kind={k} size={16} />}
                        <span className="min-w-0 flex-1 truncate text-[13px] text-ink">{th.title}</span>
                        <span className="shrink-0 text-[11.5px] text-ink-3 tabular-nums">{t('xfer.msgCount', { n: count })}</span>
                        <span className="shrink-0 text-[11.5px] text-ink-3 tabular-nums">{fmtDate(th.updatedAt)}</span>
                      </label>
                    )
                  })}
                </div>
              </div>
            )
          })}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-hairline px-5 py-3">
          <button onClick={onClose} className="h-8 rounded-lg px-3.5 text-[13px] font-medium text-ink-2 hover:bg-black/[0.05] hover:text-ink">
            {t('common.cancel')}
          </button>
          <button
            onClick={() => void runExport()}
            disabled={!selected.size || busy}
            className="h-8 rounded-lg bg-accent px-4 text-[13px] font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-45"
          >
            {busy ? '…' : t('xfer.exportBtn', { n: selected.size })}
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}

export function ImportThreadsDialog({ bundle, filePath, onClose }: { bundle: ThreadBundle; filePath: string; onClose: () => void }) {
  const { profiles, toast } = useApp()
  const chat = useChat()
  useEscape(onClose)

  const localById = useMemo(() => new Map(chat.threads.filter((th) => !th.preview).map((th) => [th.id, th])), [chat.threads])

  const analyzed = useMemo(
    () =>
      bundle.threads.map((item) => {
        const local = localById.get(item.thread.id)
        return { item, local, diff: diffOf(item, local) }
      }),
    [bundle.threads, localById]
  )

  // Default: only select 'new' and 'newer' (never accidentally overwrite newer local threads!)
  const [selected, setSelected] = useState<Set<string>>(() => new Set(analyzed.filter((a) => a.diff === 'new' || a.diff === 'newer').map((a) => a.item.thread.id)))
  const [conflictMode, setConflictMode] = useState<ImportConflictMode>('replace')

  // Project folder mapping by basename (auto-matched from local threads' projectDir)
  const knownLocal = useMemo(() => localProjectsByName(), [])
  const [projectMap, setProjectMap] = useState<Record<string, string | null>>(() => {
    const out: Record<string, string | null> = {}
    for (const { item } of analyzed) {
      if (item.projectName && !(item.projectName in out)) {
        out[item.projectName] = knownLocal[item.projectName] ?? null
      }
    }
    return out
  })

  const groups = useMemo(() => {
    const map = new Map<string, { name: string | null; sourceDir: string | null; entries: typeof analyzed }>()
    for (const a of analyzed) {
      const key = a.item.projectName ?? ''
      const cur = map.get(key)
      if (cur) cur.entries.push(a)
      else map.set(key, { name: a.item.projectName, sourceDir: a.item.sourceProjectDir, entries: [a] })
    }
    return [...map.values()]
  }, [analyzed])

  const pickProjectDir = async (name: string) => {
    const picked = await window.agentswitch.sys.pickProject(projectMap[name] ?? undefined)
    if (picked) setProjectMap((m) => ({ ...m, [name]: picked }))
  }

  const toggleOne = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const toggleGroup = (entries: typeof analyzed) =>
    setSelected((prev) => {
      const allOn = entries.every((e) => prev.has(e.item.thread.id))
      const next = new Set(prev)
      for (const e of entries) {
        if (allOn) next.delete(e.item.thread.id)
        else next.add(e.item.thread.id)
      }
      return next
    })

  const selectedEntries = analyzed.filter((a) => selected.has(a.item.thread.id))
  const existingSelected = selectedEntries.filter((a) => a.diff !== 'new')
  const olderSelectedCount = selectedEntries.filter((a) => a.diff === 'older').length

  const runImport = () => {
    if (!selectedEntries.length) return
    const res = applyThreadImport(
      selectedEntries.map((a) => a.item),
      projectMap,
      profiles,
      conflictMode
    )
    toast({
      kind: 'success',
      title: t('xfer.importDone', { added: res.added, replaced: res.replaced })
    })
    onClose()
  }

  const badge = (diff: DiffKind) => {
    if (diff === 'new') return <span className="shrink-0 rounded bg-ok-soft px-1.5 py-px text-[11px] font-medium text-ok">{t('xfer.statusNew')}</span>
    if (diff === 'newer') return <span className="shrink-0 rounded bg-accent/12 px-1.5 py-px text-[11px] font-medium text-accent">{t('xfer.statusNewer')}</span>
    if (diff === 'older') return <span className="shrink-0 rounded bg-warn-soft px-1.5 py-px text-[11px] font-medium text-warn">{t('xfer.statusOlder')}</span>
    return <span className="shrink-0 rounded bg-black/[0.06] px-1.5 py-px text-[11px] text-ink-3">{t('xfer.statusSame')}</span>
  }

  return createPortal(
    <div
      className="no-drag fixed inset-0 z-[60] flex items-center justify-center bg-(--scrim-soft) scrim-in"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="sheet-in flex h-[600px] max-h-[88vh] w-[720px] max-w-[94vw] flex-col overflow-hidden rounded-2xl bg-surface shadow-[0_0_0_1px_var(--ring),0_24px_64px_rgba(0,0,0,0.24)]">
        <div className="flex items-center gap-3 border-b border-hairline px-5 py-3.5">
          <div className="min-w-0 flex-1">
            <h3 className="text-[15px] font-semibold text-ink">{t('xfer.importTitle')}</h3>
            <p className="mt-0.5 truncate font-mono text-[11.5px] text-ink-3" title={filePath}>
              {filePath} · {fmtDate(bundle.exportedAt)}
            </p>
          </div>
          <button onClick={onClose} className="grid h-7 w-7 place-items-center rounded-lg text-ink-3 hover:bg-black/[0.06] hover:text-ink" title={t('common.close')}>
            <IconX size={14} />
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-2 border-b border-hairline bg-black/[0.02] px-5 py-2 text-[12px]">
          <button
            onClick={() => setSelected(new Set(analyzed.filter((a) => a.diff === 'new' || a.diff === 'newer').map((a) => a.item.thread.id)))}
            className="rounded-md px-2 py-0.5 font-medium text-accent hover:bg-accent/10"
          >
            {t('xfer.selectRecommended')}
          </button>
          <button onClick={() => setSelected(new Set(analyzed.map((a) => a.item.thread.id)))} className="rounded-md px-2 py-0.5 text-ink-2 hover:bg-black/[0.05] hover:text-ink">
            {t('xfer.selectAll')}
          </button>
          <button onClick={() => setSelected(new Set())} className="rounded-md px-2 py-0.5 text-ink-2 hover:bg-black/[0.05] hover:text-ink">
            {t('xfer.selectNone')}
          </button>
          <span className="flex-1" />
          <span className="tabular-nums text-ink-3">{t('xfer.selectedCount', { n: selected.size, total: analyzed.length })}</span>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          {!analyzed.length && <div className="py-12 text-center text-[13px] text-ink-3">{t('xfer.emptyBundle')}</div>}
          {groups.map((g) => {
            const checkedCount = g.entries.filter((e) => selected.has(e.item.thread.id)).length
            const allOn = checkedCount === g.entries.length
            const mapped = g.name ? (projectMap[g.name] ?? null) : null
            return (
              <div key={g.name ?? '_'} className="mb-3 overflow-hidden rounded-xl border border-hairline bg-surface">
                <div className="flex flex-wrap items-center gap-2 bg-black/[0.025] px-3 py-2">
                  <label className="flex cursor-pointer items-center gap-2 select-none">
                    <input type="checkbox" checked={allOn} onChange={() => toggleGroup(g.entries)} className="h-3.5 w-3.5 accent-accent" />
                    <IconFolder size={14} className="shrink-0 text-ink-3" />
                    <span className="text-[13px] font-semibold text-ink">{g.name ?? t('nav.noProject')}</span>
                  </label>
                  {g.name && (
                    <>
                      {mapped ? (
                        <span className="min-w-0 flex-1 truncate rounded-md bg-ok-soft/60 px-2 py-0.5 font-mono text-[11px] text-ok" title={mapped}>
                          {t('xfer.matchedDir', { dir: mapped })}
                        </span>
                      ) : (
                        <span className="min-w-0 flex-1 truncate rounded-md bg-warn-soft/70 px-2 py-0.5 text-[11px] text-warn">
                          {t('xfer.unmatchedDir')}
                        </span>
                      )}
                      <button
                        onClick={() => void pickProjectDir(g.name!)}
                        className="shrink-0 rounded-md px-2 py-0.5 text-[11.5px] font-medium text-accent hover:bg-accent/10"
                      >
                        {mapped ? t('xfer.changeDir') : t('xfer.pickDir')}
                      </button>
                    </>
                  )}
                  {!g.name && <span className="flex-1" />}
                  <span className="shrink-0 text-[11.5px] text-ink-3 tabular-nums">
                    {checkedCount}/{g.entries.length}
                  </span>
                </div>
                <div className="divide-y divide-hairline">
                  {g.entries.map(({ item, local, diff }) => {
                    const th = item.thread
                    const on = selected.has(th.id)
                    return (
                      <label key={th.id} className={`flex cursor-pointer items-center gap-2.5 px-3 py-2 hover:bg-black/[0.02] select-none ${diff === 'same' && !on ? 'opacity-65' : ''}`}>
                        <input type="checkbox" checked={on} onChange={() => toggleOne(th.id)} className="h-3.5 w-3.5 accent-accent" />
                        {item.driverKind && <KindAvatar kind={item.driverKind} size={16} />}
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[13px] text-ink">{th.title}</span>
                          <span className="block truncate text-[11px] text-ink-3 tabular-nums">
                            {t('xfer.importMeta', { n: th.messages.length, time: fmtDate(th.updatedAt) })}
                            {local ? ` · ${t('xfer.localMeta', { n: threadMessages(local).length, time: fmtDate(local.updatedAt) })}` : ''}
                          </span>
                        </span>
                        {badge(diff)}
                      </label>
                    )
                  })}
                </div>
              </div>
            )
          })}
        </div>

        <div className="space-y-2 border-t border-hairline px-5 py-3">
          {existingSelected.length > 0 && (
            <div className="flex flex-wrap items-center gap-3 text-[12px]">
              <span className="text-ink-3">{t('xfer.conflictLabel')}</span>
              <label className="flex cursor-pointer items-center gap-1.5 text-ink">
                <input type="radio" name="conflictMode" checked={conflictMode === 'replace'} onChange={() => setConflictMode('replace')} className="accent-accent" />
                {t('xfer.conflictReplace')}
              </label>
              <label className="flex cursor-pointer items-center gap-1.5 text-ink">
                <input type="radio" name="conflictMode" checked={conflictMode === 'duplicate'} onChange={() => setConflictMode('duplicate')} className="accent-accent" />
                {t('xfer.conflictDuplicate')}
              </label>
            </div>
          )}
          <div className="flex items-center gap-2">
            {olderSelectedCount > 0 && conflictMode === 'replace' && (
              <span className="min-w-0 flex-1 text-[11.5px] font-medium text-warn">{t('xfer.olderWarn', { n: olderSelectedCount })}</span>
            )}
            {!(olderSelectedCount > 0 && conflictMode === 'replace') && <span className="flex-1" />}
            <button onClick={onClose} className="h-8 rounded-lg px-3.5 text-[13px] font-medium text-ink-2 hover:bg-black/[0.05] hover:text-ink">
              {t('common.cancel')}
            </button>
            <button
              onClick={runImport}
              disabled={!selectedEntries.length}
              className="h-8 rounded-lg bg-accent px-4 text-[13px] font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-45"
            >
              {t('xfer.importBtn', { n: selectedEntries.length })}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  )
}
