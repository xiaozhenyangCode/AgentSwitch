import { useCallback, useEffect, useId, useState } from 'react'
import { createPortal } from 'react-dom'
import type { CheckpointChoice, CheckpointPlan, CheckpointStatus, TurnCheckpoint } from '@shared/checkpoints'
import { btnPrimary, btnSecondary } from '../lib/ui'
import { useApp } from '../state/AppContext'
import { t } from '../state/i18n'
import { Modal } from './common'
import { IconCheck, IconFile, IconUndo, Spinner } from './icons'

export function useCheckpoints(threadId: string | undefined) {
  const [snapshot, setSnapshot] = useState<{ threadId: string; turns: TurnCheckpoint[] } | null>(null)
  const [revision, setRevision] = useState(0)
  const refresh = useCallback(() => setRevision((n) => n + 1), [])

  useEffect(() => window.agentswitch.chat.onEvent((event) => {
    if (event.kind === 'turn-end') refresh()
  }), [refresh])

  useEffect(() => {
    if (!threadId) return
    let current = true
    void window.agentswitch.chat.checkpoints(threadId).then((turns) => {
      if (current) setSnapshot({ threadId, turns })
    }).catch(() => {})
    return () => { current = false }
  }, [threadId, revision])

  return { turns: snapshot?.threadId === threadId ? snapshot?.turns : undefined, refresh }
}

export function CheckpointUndo({ threadId, turnId, status, busy, onChange }: {
  threadId: string
  turnId: string
  status: CheckpointStatus
  busy: boolean
  onChange: () => void
}) {
  const { toast } = useApp()
  const [plan, setPlan] = useState<CheckpointPlan | null>(null)
  const [pending, setPending] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const [undone, setUndone] = useState(false)
  const titleId = useId()
  const descriptionId = useId()

  const action = async (choice?: CheckpointChoice) => {
    setPending(true)
    try {
      const result = await window.agentswitch.chat.checkpointAction(threadId, turnId, choice ? plan?.token : undefined, choice)
      switch (result.kind) {
        case 'plan':
          setPlan(result)
          setExpanded(false)
          break
        case 'undone':
          setUndone(true)
          setPlan(null)
          onChange()
          toast({ kind: 'success', title: result.skipped ? t('checkpoint.resultSkipped', { n: result.skipped }) : t('checkpoint.undone') })
          break
        case 'partial':
          setPlan(null)
          onChange()
          toast({ kind: 'warn', title: t('checkpoint.partial', { n: result.failed }) })
          break
        case 'busy':
        case 'unavailable':
        case 'failed':
          setPlan(null)
          if (result.kind === 'unavailable') onChange()
          toast({ kind: 'warn', title: t(`checkpoint.${result.kind}`) })
          break
      }
    } catch {
      toast({ kind: 'error', title: t('checkpoint.failed') })
    } finally {
      setPending(false)
    }
  }

  if (status === 'tooLarge' || status === 'overlap') return <p className="mt-2 text-[12px] text-ink-3">{t(status === 'overlap' ? 'checkpoint.overlap' : 'checkpoint.tooLarge')}</p>

  const finished = undone || status === 'undone'
  const conflicts = new Set(plan?.conflicts)
  const ordered = plan ? [...plan.conflicts, ...plan.files.filter((file) => !conflicts.has(file))] : []
  const canCollapse = ordered.length > 8
  const visible = canCollapse && !expanded ? ordered.slice(0, 5) : ordered
  return (
    <>
      <button
        className="mt-1 -ml-2 flex h-7 items-center gap-1.5 rounded-lg px-2 text-[12px] text-ink-3 enabled:hover:bg-fill enabled:hover:text-ink disabled:cursor-default"
        disabled={finished || pending || busy}
        title={busy && !finished ? t('checkpoint.busy') : undefined}
        onClick={() => void action()}
      >
        {pending && !plan ? <Spinner size={13} /> : finished ? <IconCheck size={13} /> : <IconUndo size={13} />}
        {t(finished ? 'checkpoint.undone' : 'checkpoint.undo')}
      </button>
      {plan && createPortal(
        <Modal onClose={() => { if (!pending) setPlan(null) }} width={520} escClose={!pending}>
          <div role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={descriptionId} className="p-6">
            <h2 id={titleId} className="text-[18px] font-semibold text-ink">{t('checkpoint.undo')}</h2>
            <p id={descriptionId} className="mt-2 text-[14px] leading-relaxed text-ink-2">
              {t('checkpoint.description')}
            </p>
            {conflicts.size > 0 && (
              <p role="status" className="mt-4 rounded-xl bg-warn-soft px-3 py-2 text-[13px] text-warn">
                {t('checkpoint.conflicts')}
              </p>
            )}
            <p className="mt-4 mb-2 text-[13px] font-medium text-ink">{t('checkpoint.fileCount', { n: ordered.length })}</p>
            <div className="overflow-hidden rounded-xl border border-hairline bg-fill">
              <ul className="max-h-56 divide-y divide-hairline overflow-y-auto" tabIndex={expanded ? 0 : undefined}>
                {visible.map((file) => (
                  <li key={file} className="flex items-center gap-2 px-3 py-2 text-[13px] text-ink">
                    <IconFile size={14} className="shrink-0 text-ink-3" />
                    <span className="min-w-0 flex-1 break-all whitespace-pre-wrap" dir="auto">{file}</span>
                    {conflicts.has(file) && <span className="shrink-0 text-[12px] text-warn">{t('checkpoint.conflict')}</span>}
                  </li>
                ))}
              </ul>
              {canCollapse && (
                <button className="w-full border-t border-hairline px-3 py-2 text-left text-[13px] text-accent hover:bg-fill-hover"
                  aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
                  {expanded ? t('checkpoint.collapse') : t('checkpoint.expand', { n: ordered.length - visible.length })}
                </button>
              )}
            </div>
            <div className="mt-6 flex flex-wrap justify-end gap-2">
              <button autoFocus className={btnSecondary} onClick={() => setPlan(null)} disabled={pending}>{t('common.cancel')}</button>
              {conflicts.size > 0 && (
                <button className={btnSecondary} onClick={() => void action('overwrite')} disabled={pending || busy}>
                  {t('checkpoint.overwrite')}
                </button>
              )}
              <button className={btnPrimary} onClick={() => void action('skip')} disabled={pending || busy}>
                {pending && <Spinner size={14} />}
                {t(conflicts.size ? 'checkpoint.skip' : 'checkpoint.confirm')}
              </button>
            </div>
          </div>
        </Modal>, document.body
      )}
    </>
  )
}
