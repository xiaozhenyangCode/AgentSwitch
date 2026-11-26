import { useEffect, useState } from 'react'
import type { FileChange, GitConflictChoice, GitConflictFile, GitInProgressOp, GitResult } from '@shared/types'
import { btnSecondary } from '../lib/ui'
import { useApp } from '../state/AppContext'
import { t } from '../state/i18n'
import type { ProjectGitTools, RunGit } from '../state/useProjectGit'
import { Modal } from './common'
import { IconFile, Spinner } from './icons'

const actions = 'rounded-md px-2 py-1 text-[12px] font-medium hover:bg-black/[0.06] dark:hover:bg-white/[0.07] disabled:opacity-45'
const opLabels = {
  merge: 'git.opMerge', rebase: 'git.opRebase', 'cherry-pick': 'git.opCherryPick', revert: 'git.opRevert'
} as const

/** Why branch/sync actions are unavailable while a merge, rebase, cherry-pick or revert is in progress. */
export function gitOperationReason(operation: GitInProgressOp | null) {
  return operation ? t('git.blockedByOperation', { op: t(opLabels[operation]) }) : undefined
}

export function gitConflictLabel(operation: GitInProgressOp | null, count: number) {
  return count ? t('git.conflictFiles', { n: count }) : operation ? t(opLabels[operation]) : null
}

export function GitConflictBar({ tools }: { tools: ProjectGitTools }) {
  const { confirm } = useApp()
  const { status: { inProgress, conflicts }, disabled, run } = tools
  if (!inProgress && !conflicts) return null
  const changeOperation = async (kind: 'abortOperation' | 'skipOperation') => {
    if (!inProgress) return
    const title = t(`git.${kind}`)
    if (await confirm({
      title, confirmLabel: title, destructive: true,
      message: t(kind === 'abortOperation' ? 'git.abortConfirm' : 'git.skipConfirm')
    })) await run({ kind, expectedOperation: inProgress })
  }
  return (
    <section className="shrink-0 space-y-1 border-b border-hairline bg-surface-2 px-3 py-2" aria-live="polite">
      <div className="flex flex-wrap items-center gap-x-2 text-[12px]">
        {inProgress && <strong>{t(opLabels[inProgress])}</strong>}
        <span className={conflicts ? 'font-medium text-danger' : 'text-ink-3'}>{t('git.conflictFiles', { n: conflicts })}</span>
      </div>
      {inProgress && <div className="flex flex-wrap items-center gap-1">
        <button type="button" className={actions} disabled={disabled || conflicts > 0}
          title={conflicts ? t('git.continueResolveFirst') : undefined}
          onClick={() => void run({ kind: 'continueOperation', expectedOperation: inProgress })}>{t('git.continueOperation')}</button>
        {inProgress !== 'merge' && <button type="button" className={actions} disabled={disabled}
          onClick={() => void changeOperation('skipOperation')}>{t('git.skipOperation')}</button>}
        <button type="button" className={actions + ' text-danger'} disabled={disabled}
          onClick={() => void changeOperation('abortOperation')}>{t('git.abortOperation')}</button>
      </div>}
      {inProgress && conflicts > 0 && <div className="text-[11px] text-ink-3">{t('git.continueResolveFirst')}</div>}
    </section>
  )
}

export function GitConflictList({ files, count, resolve }: {
  files: FileChange[]; count: number; resolve: (path: string) => void
}) {
  if (!files.length) return null
  return (
    <section className="mb-2">
      <h3 className="px-2 py-1.5 text-[11.5px] font-semibold text-danger">{t('git.conflictFiles', { n: count || files.length })}</h3>
      {files.map((file) => <button key={file.abs} type="button"
        className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12px] hover:bg-surface-2"
        onClick={() => resolve(file.conflictPath ?? file.path)} title={file.conflictPath ?? file.path}>
        <IconFile size={14} className="shrink-0 text-danger" />
        <span className="min-w-0 flex-1 truncate">{file.conflictPath ?? file.path}</span>
        <span className="shrink-0 text-[11px] text-ink-2">{t('git.resolveConflict')}</span>
      </button>)}
    </section>
  )
}

const choices = [
  ['current', 'git.acceptCurrent'], ['incoming', 'git.acceptIncoming'], ['both', 'git.acceptBoth']
] as const

function ChoiceButtons({ disabled, choose }: { disabled: boolean; choose: (choice: GitConflictChoice) => void }) {
  return <div className="flex flex-wrap gap-1">
    {choices.map(([choice, label]) => <button key={choice} type="button" className={actions} disabled={disabled}
      onClick={() => choose(choice)}>{t(label)}</button>)}
  </div>
}

function ConflictSide({ title, label, content }: { title: string; label?: string; content: string }) {
  return <div className="min-w-0 bg-surface-2">
    <h4 title={label} className="truncate border-b border-hairline px-2 py-1 text-[11px] font-medium">
      {title}{label ? ` · ${label}` : ''}
    </h4>
    <pre className="max-h-40 min-h-8 overflow-auto px-2 py-1.5 font-mono text-[11.5px]">{content || '∅'}</pre>
  </div>
}

export function GitConflictModal({ dir, path, run, disabled, onClose }: {
  dir: string; path: string; run: RunGit; disabled: boolean; onClose: () => void
}) {
  const { confirm, toast } = useApp()
  const [result, setResult] = useState<GitResult<{ file: GitConflictFile }> | null>(null)
  const [request, setRequest] = useState(0)
  const [checking, setChecking] = useState(false)
  const unavailable = disabled || checking
  const close = () => { if (!checking) onClose() }
  const reload = () => { setResult(null); setRequest((value) => value + 1) }
  useEffect(() => {
    let active = true
    void window.agentswitch.git.conflictFile(dir, path, true).then(
      (value) => { if (active) setResult(value) },
      (error) => { if (active) setResult({ ok: false, error: String(error) }) }
    )
    return () => { active = false }
  }, [dir, path, request])
  const file = result?.ok ? result.file : null
  const choose = async (choice: GitConflictChoice, hunkIndex?: number) => {
    if (!file?.version) return
    await run({ kind: 'resolveConflict', path, hunkIndex, choice, repoRelative: true, expectedVersion: file.version })
    reload()
  }
  const mark = async () => {
    setChecking(true)
    try {
      const latest = await window.agentswitch.git.conflictFile(dir, path, true)
      setResult(latest)
      if (!latest.ok) return
      const title = t('git.markResolved')
      const { unresolvedCount, malformed, truncated, version } = latest.file
      if ((unresolvedCount || malformed || truncated) && !(await confirm({
        title, confirmLabel: title, message: t('git.markResolvedConfirm', { path }), destructive: true
      }))) return
      const mutation = await run({ kind: 'markResolved', path, repoRelative: true, expectedVersion: version })
      if (mutation.ok) onClose()
      else reload()
    } catch (error) {
      toast({ kind: 'error', title: t('git.markResolved'), desc: String(error) })
    } finally {
      setChecking(false)
    }
  }
  const open = async () => {
    if (!file) return
    try {
      await window.agentswitch.sys.openPath(file.abs)
    } catch (error) {
      toast({ kind: 'error', title: t('git.openInEditor'), desc: String(error) })
    }
  }
  return (
    <Modal onClose={close} width={780}>
      <div role="dialog" aria-label={t('git.resolveConflict')} className="max-w-[94vw] space-y-3 p-5">
        <header className="space-y-1">
          <h2 className="text-[16px] font-semibold">{t('git.resolveConflict')}</h2>
          <p className="break-all font-mono text-[12px] text-ink-2">{path}</p>
        </header>
        {!result && <Spinner size={15} />}
        {result && !result.ok && <p role="alert" className="whitespace-pre-wrap break-words text-[12px] text-danger">{result.error}</p>}
        {file && (file.missing || file.binary || file.truncated || file.malformed || !file.hunks.length) &&
          <p className="text-[13px] text-ink-2">{t(file.missing ? 'git.conflictMissing'
            : file.binary || file.truncated || file.malformed ? 'git.conflictExternal' : 'git.conflictNoBlocks')}</p>}
        {!!file?.hunks.length && <>
          <div className="flex flex-wrap items-center gap-x-2 rounded-lg bg-surface-2 px-2 py-1">
            <span className="text-[12px] font-medium">{t('git.conflictAll')}</span>
            <ChoiceButtons disabled={unavailable || !!file.malformed} choose={(choice) => void choose(choice)} />
          </div>
          <div className="max-h-[48vh] space-y-2 overflow-auto">
            {file.hunks.map((hunk) => <section key={hunk.index} className="overflow-hidden rounded-lg border border-hairline">
              <div className="flex flex-wrap items-center justify-between gap-1 px-2 py-1">
                <h3 className="text-[12px] font-medium">{t('git.conflictLines', { start: hunk.startLine, end: hunk.endLine })}</h3>
                <ChoiceButtons disabled={unavailable || !!file.malformed} choose={(choice) => void choose(choice, hunk.index)} />
              </div>
              <div className={`grid gap-px border-t border-hairline bg-hairline ${hunk.base === undefined ? 'grid-cols-2' : 'grid-cols-3'}`}>
                <ConflictSide title={t('git.conflictCurrent')} label={hunk.currentLabel} content={hunk.current} />
                {hunk.base !== undefined && <ConflictSide title={t('git.conflictBase')} content={hunk.base} />}
                <ConflictSide title={t('git.conflictIncoming')} label={hunk.incomingLabel} content={hunk.incoming} />
              </div>
            </section>)}
          </div>
        </>}
        <footer className="flex flex-wrap items-center gap-2">
          <button type="button" className={btnSecondary} onClick={reload} disabled={unavailable || !result}>{t('common.refresh')}</button>
          <button type="button" className={btnSecondary} onClick={() => void open()} disabled={!file || file.missing || file.nonRegular}>{t('git.openInEditor')}</button>
          <button type="button" className={btnSecondary} onClick={() => void mark()} disabled={!file || unavailable}>{t('git.markResolved')}</button>
          <button type="button" className={btnSecondary + ' ml-auto'} onClick={close} disabled={checking}>{t('common.close')}</button>
        </footer>
      </div>
    </Modal>
  )
}
