import { useEffect, useState } from 'react'
import type { GitCommandLogEntry } from '@shared/types'
import { currentLocale, t } from '../state/i18n'
import { IconChevronDown, Spinner } from './icons'

const button = 'rounded-md px-2 py-1 text-[11.5px] font-medium text-ink-2 hover:bg-surface-2 disabled:opacity-45'

export function GitCommandLogDrawer({ dir, revision }: { dir: string; revision: number }) {
  const [open, setOpen] = useState(false)
  const [repoOnly, setRepoOnly] = useState(true)
  const [failuresOnly, setFailuresOnly] = useState(false)
  const [request, setRequest] = useState(0)
  const [entries, setEntries] = useState<GitCommandLogEntry[] | null>(null)
  const [error, setError] = useState('')
  const [clearing, setClearing] = useState(false)

  useEffect(() => {
    if (!open) return
    let active = true
    setError('')
    void window.agentswitch.git.commandLog(repoOnly ? dir : null).then(
      (result) => { if (active) setEntries(result) },
      (error) => { if (active) setError(String(error)) }
    )
    return () => { active = false }
  }, [dir, open, repoOnly, request, revision])

  const clear = async () => {
    setClearing(true)
    try {
      await window.agentswitch.git.clearCommandLog()
      setEntries([])
      setRequest((value) => value + 1)
    } catch (error) {
      setError(String(error))
    } finally {
      setClearing(false)
    }
  }
  const shown = failuresOnly ? entries?.filter((entry) => !entry.ok) : entries
  return (
    <section className="flex max-h-[42vh] shrink-0 flex-col border-t border-hairline bg-surface">
      <button className="flex w-full shrink-0 items-center gap-2 px-3 py-2 text-left text-[12px] font-semibold hover:bg-surface-2"
        type="button" aria-expanded={open} onClick={() => setOpen(!open)}>
        <IconChevronDown size={13} className={open ? '' : '-rotate-90'} />
        {t('git.commandLog')}
      </button>
      {open && <>
        <div className="flex shrink-0 flex-wrap items-center gap-x-2 border-y border-hairline px-3 py-1 text-[11px]">
          <label className="inline-flex items-center gap-1">
            <input type="checkbox" checked={repoOnly}
              onChange={(event) => { setEntries(null); setRepoOnly(event.target.checked) }} />
            {t('git.currentRepoOnly')}
          </label>
          <label className="inline-flex items-center gap-1">
            <input type="checkbox" checked={failuresOnly} onChange={(event) => setFailuresOnly(event.target.checked)} />
            {t('git.failedCommandsOnly')}
          </label>
          <div className="flex-1" />
          <button type="button" className={button} onClick={() => setRequest((value) => value + 1)}>{t('common.refresh')}</button>
          <button type="button" className={button} disabled={clearing} onClick={() => void clear()}>{t('common.clear')}</button>
        </div>
        <div className="min-h-0 overflow-y-auto px-3 py-1">
          {error ? <p role="alert" className="whitespace-pre-wrap break-words py-1 text-[12px] text-danger">{error}</p>
            : !shown ? <Spinner size={14} />
              : !shown.length ? <p className="py-2 text-[12px] text-ink-3">{t('git.noCommands')}</p>
                : shown.map((entry) => <CommandEntry key={entry.id} entry={entry} />)}
        </div>
      </>}
    </section>
  )
}

function CommandEntry({ entry }: { entry: GitCommandLogEntry }) {
  return (
    <details className="border-b border-hairline py-1.5 last:border-b-0">
      <summary className="cursor-pointer text-[11.5px]">
        <span className={`break-all font-mono ${entry.ok ? 'text-ink' : 'text-danger'}`}>
          git {entry.args.map((arg) => /\s/.test(arg) ? JSON.stringify(arg) : arg || '""').join(' ')}
        </span>
        <span className="block break-all pl-3 text-[10.5px] text-ink-3">{entry.repoPath}</span>
        <span className="block pl-3 text-[10.5px] text-ink-3">
          {new Date(entry.timestamp).toLocaleTimeString(currentLocale())} · {t('git.commandExit', { code: entry.exitCode ?? '—', ms: entry.durationMs })}
        </span>
      </summary>
      {(['stdout', 'stderr'] as const).map((field) => <div key={field} className="mt-1.5 text-[11px] text-ink-2">
        <strong className="font-mono">{field}</strong>
        <pre className="max-h-28 overflow-auto rounded bg-surface-2 p-1.5 whitespace-pre-wrap break-all">{entry[field] || t('git.commandNoOutput')}</pre>
      </div>)}
    </details>
  )
}
