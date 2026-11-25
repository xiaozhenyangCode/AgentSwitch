import type { GitMutationResult, GitStatus } from '@shared/types'
import { useApp } from '../state/AppContext'
import { t } from '../state/i18n'
import type { RunGit } from '../state/useProjectGit'

export function GitOperationBanner({ status, disabled, run, onDone, onError }: {
  status: Extract<GitStatus, { repo: true }>
  disabled: boolean
  run: RunGit
  onDone?: () => void
  onError?: (result: Extract<GitMutationResult, { ok: false }>) => void
}) {
  const { confirm } = useApp()
  const { operation, conflicts } = status
  if (!operation && !conflicts) return null
  const op = operation ? t(`git.op.${operation}`) : ''
  const label = t('git.abortOp', { op })
  const abort = async () => {
    if (!operation || disabled) return
    const confirmed = await confirm({
      title: label, message: t('git.abortConfirm', { op }), confirmLabel: label, destructive: true, native: true
    })
    if (!confirmed) return
    const result = await run({ kind: 'abortOperation', operation }, { errorToast: !onError })
    if (result.ok) onDone?.()
    else onError?.(result)
  }
  return (
    <div className="flex shrink-0 items-center justify-between gap-2 border-b border-hairline bg-warn/10 px-3 py-2 text-warn">
      <p role="status" className="min-w-0 text-[12px]">
        {operation
          ? t(conflicts ? 'git.operationBanner' : 'git.operationReady', { op, n: conflicts })
          : t('git.conflictsOnly', { n: conflicts })}
      </p>
      {operation && (
        <button type="button" disabled={disabled} onClick={() => void abort()}
          className="shrink-0 rounded-md border border-warn/30 px-2 py-1 text-[12px] font-medium hover:bg-warn/10 disabled:opacity-45">
          {label}
        </button>
      )}
    </div>
  )
}
