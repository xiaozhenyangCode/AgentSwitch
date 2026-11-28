import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useChat } from '../state/chat'
import { useEscape } from '../lib/escStack'
import { baseName } from '../lib/fileUrl'
import { t } from '../state/i18n'
import { IconCheck, IconChevronDown, IconCopy, IconFolder, IconLock, IconPlus, IconX } from './icons'

/** /Users/name/x -> ~/x (display only). */
export const tildePath = (p: string) => p.replace(/^\/(?:Users|home)\/[^/]+(?=\/|$)/, '~')

const RECENT_MAX = 8

/** Project folders used by earlier chats, most recent first. */
function useRecentProjects(): string[] {
  const chat = useChat()
  return useMemo(() => {
    const seen = new Set<string>()
    for (const th of [...chat.threads].sort((a, b) => b.updatedAt - a.updatedAt)) {
      if (th.projectDir && !seen.has(th.projectDir)) seen.add(th.projectDir)
      if (seen.size >= RECENT_MAX) break
    }
    return [...seen]
  }, [chat.threads])
}

const item = 'flex h-9 w-full items-center gap-2.5 rounded-[10px] px-2.5 text-left text-[13px] text-ink transition-colors hover:bg-black/[0.05] dark:hover:bg-white/[0.07]'

/**
 * Context line under the composer: the chat's project folder. Before the first message it can
 * be switched or cleared. Started chats rebind the project through a separate action.
 */
export function ProjectBar({
  dir,
  locked,
  projectMissing = false,
  onRebind,
  onChange,
  onPick,
  onNewHere,
  gitBranch
}: {
  dir: string | null
  locked: boolean
  projectMissing?: boolean
  onRebind?: () => void
  onChange: (dir: string | null) => void
  onPick: () => void
  onNewHere: (dir: string | null) => void
  gitBranch?: ReactNode
}) {
  const [open, setOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const recent = useRecentProjects()
  useEscape(() => setOpen(false), open)
  useEffect(() => {
    if (!open) return
    const down = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false)
    window.addEventListener('mousedown', down)
    return () => window.removeEventListener('mousedown', down)
  }, [open])
  const close = (fn: () => void) => () => {
    setOpen(false)
    fn()
  }

  return (
    <div className="relative mt-2 flex items-center px-2">
      <div ref={ref} className="min-w-0">
        <button
          onClick={() => setOpen((o) => !o)}
          className={`flex h-7 max-w-full min-w-0 items-center gap-1.5 rounded-lg px-2 text-[12.5px] transition-colors hover:bg-black/[0.05] dark:hover:bg-white/[0.07] ${open ? 'bg-black/[0.05] dark:bg-white/[0.07]' : ''}`}
          title={[dir ?? t('wb.projectHint'), projectMissing ? t(dir ? 'proj.missing' : 'proj.unlinked') : null, locked ? t('proj.lockedHint') : null].filter(Boolean).join('\n')}
        >
          <IconFolder size={14} className={`shrink-0 ${projectMissing ? 'text-warn' : dir ? 'text-accent' : 'text-ink-3'}`} />
          {dir ? (
            <>
              <span className={`max-w-[12rem] shrink-0 truncate font-medium ${projectMissing ? 'text-warn' : 'text-ink'}`}>{baseName(dir)}</span>
              <span className="min-w-0 truncate text-ink-3">{tildePath(dir)}</span>
            </>
          ) : (
            <span className={projectMissing ? 'text-warn' : 'text-ink-3'}>{t('nav.noProject')}</span>
          )}
          {locked ? <IconLock size={11} className="shrink-0 text-ink-3" /> : <IconChevronDown size={12} className="shrink-0 text-ink-3" />}
        </button>

        {open && (
          <div className="absolute bottom-full left-0 z-30 mb-1.5 w-[340px] rounded-xl border border-editor-hairline bg-elevated p-1.5 shadow-[0_12px_32px_rgba(0,0,0,0.14)]">
            {locked ? (
              <>
                <div className="px-2.5 pt-1 pb-1.5 text-[11.5px] leading-relaxed text-ink-3">{dir ? t('proj.lockedHint') : t('proj.lockedNone')}</div>
                {dir && (
                  <>
                    <button className={item + ' disabled:opacity-50'} disabled={projectMissing} onClick={close(() => void window.agentswitch.sys.showInFolder(dir))}>
                      <IconFolder size={15} className="shrink-0 text-ink-2" />
                      {t('common.showInFinder')}
                    </button>
                    <button
                      className={item}
                      onClick={() => {
                        void window.agentswitch.sys.copy(dir)
                        setCopied(true)
                        setTimeout(() => {
                          setCopied(false)
                          setOpen(false)
                        }, 700)
                      }}
                    >
                      {copied ? <IconCheck size={15} className="shrink-0 text-ok" /> : <IconCopy size={15} className="shrink-0 text-ink-2" />}
                      {copied ? t('common.copied') : t('proj.copyPath')}
                    </button>
                  </>
                )}
                {onRebind && (
                  <button className={item} onClick={close(onRebind)}>
                    <IconFolder size={15} className="shrink-0 text-accent" />
                    {t('proj.rebindMenu')}
                  </button>
                )}
                <button className={item} onClick={close(() => onNewHere(dir))}>
                  <IconPlus size={15} className="shrink-0 text-accent" />
                  {dir ? t('proj.newHere') : t('proj.newNone')}
                </button>
              </>
            ) : (
              <>
                {recent.length > 0 && <div className="px-2.5 pt-1 pb-1 text-[11.5px] text-ink-3">{t('proj.recent')}</div>}
                <div className="max-h-[300px] overflow-y-auto">
                  {recent.map((p) => (
                    <button key={p} className={item + ' h-11'} onClick={close(() => onChange(p))} title={p}>
                      <IconFolder size={15} className="shrink-0 text-accent" />
                      <span className="flex min-w-0 flex-1 flex-col leading-tight">
                        <span className="truncate font-medium">{baseName(p)}</span>
                        <span className="truncate text-[11.5px] text-ink-3">{tildePath(p)}</span>
                      </span>
                      {p === dir && <IconCheck size={14} className="shrink-0 text-accent" />}
                    </button>
                  ))}
                </div>
                {recent.length > 0 && <div className="mx-2 my-1 h-px bg-hairline" />}
                <button className={item} onClick={close(onPick)}>
                  <IconPlus size={15} className="shrink-0 text-ink-2" />
                  {t('proj.pickOther')}
                </button>
                <button className={item} onClick={close(() => onChange(null))}>
                  <IconX size={15} className="shrink-0 text-ink-2" />
                  <span className="min-w-0 flex-1 truncate">{t('proj.none')}</span>
                  {!dir && <IconCheck size={14} className="shrink-0 text-accent" />}
                </button>
              </>
            )}
          </div>
        )}
      </div>
      {gitBranch}
    </div>
  )
}
