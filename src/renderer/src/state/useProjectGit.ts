import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { GitMutation, GitMutationResult, GitStatus } from '@shared/types'
import { useApp } from './AppContext'
import { t } from './i18n'
import { getSettings } from './settings'

export type RunGit = (op: GitMutation, options?: { errorToast?: boolean }) => Promise<GitMutationResult>

const pendingByDir = new Map<string, GitMutation['kind']>()
const pendingListeners = new Set<() => void>()
const subscribePending = (listener: () => void) => {
  pendingListeners.add(listener)
  return () => { pendingListeners.delete(listener) }
}
const notifyPending = () => pendingListeners.forEach((listener) => listener())

export function useGitPending(dir: string | null) {
  return useSyncExternalStore(subscribePending, () => dir ? pendingByDir.get(dir) ?? null : null)
}

const resultTitle = (op: GitMutation, result: Extract<GitMutationResult, { ok: true }>) => {
  const outcome = result.outcome
  switch (outcome?.kind) {
    case 'switch': return t('git.switched', { name: outcome.branch })
    case 'createBranch': return t('git.created', { name: outcome.branch })
    case 'pull': return outcome.count === 0 ? t('git.upToDate')
      : outcome.count === null ? t('git.pulled') : t('git.pulledCount', { n: outcome.count })
    case 'push': {
      const name = outcome.target
      if (outcome.published) return t('git.published', { name })
      if (outcome.count === 0) return t('git.upToDate')
      return outcome.count === null ? t('git.pushed', { name }) : t('git.pushedCount', { n: outcome.count, name })
    }
    case 'commit': return outcome.sha ? t('git.committed', { sha: outcome.sha, subject: outcome.subject }) : t('git.commitDone')
    case 'abortOperation': return t('git.operationAborted', { op: t(`git.op.${outcome.operation}`) })
  }
  switch (op.kind) {
    case 'fetch': return t('git.fetched')
    case 'stage': return t('git.stagedFile', { path: op.path })
    case 'unstage': return t('git.unstagedFile', { path: op.path })
    case 'discard': return t(op.untracked ? 'git.deletedFile' : 'git.discardedFile', { path: op.path })
    case 'stageAll': return t('git.stagedAll')
    case 'unstageAll': return t('git.unstagedAll')
    default: return t('git.failed')
  }
}

const errorTitles = {
  invalidBranch: 'git.invalidBranch', busy: 'git.repoBusy', switchChanges: 'git.errSwitchChanges',
  diverged: 'git.errDiverged', noUpstream: 'git.errNoUpstream', auth: 'git.errAuth',
  pushRejected: 'git.errPushRejected', indexLocked: 'git.errIndexLocked',
  operationInProgress: 'git.errOperationInProgress', unmerged: 'git.errUnmerged', localChanges: 'git.errLocalChanges',
  pullConflict: 'git.errPullConflict'
} as const

export function gitErrorTitle(result: Extract<GitMutationResult, { ok: false }>): string {
  return t(result.code ? errorTitles[result.code] : 'git.failed')
}

export function gitErrorDetail(result: Extract<GitMutationResult, { ok: false }>): string | undefined {
  if (result.code === 'busy') return undefined
  if (result.code !== 'pullConflict' || !result.files?.length) return result.error
  const { files } = result
  const visible = files.slice(0, 8).map((file) => file.replace(/\r/g, '\\r').replace(/\n/g, '\\n'))
  const rest = files.length - visible.length
  return [t('git.pullConflictHint', { n: files.length }), ...visible, ...(rest ? [t('git.moreFiles', { n: rest })] : [])].join('\n')
}

export function useProjectGit(dir: string | null, threadId: string | null, agentRunning: boolean, refreshFiles: () => void) {
  const { toast } = useApp()
  const [snapshot, setSnapshot] = useState<{ dir: string; status: GitStatus } | null>(null)
  const request = useRef(0)
  const status = dir && snapshot?.dir === dir && snapshot.status.repo ? snapshot.status : null
  const repoPath = status?.repoPath ?? dir
  const pending = useGitPending(repoPath)

  const refresh = useCallback(() => {
    const id = ++request.current
    if (!dir || !getSettings().showGitTools) return setSnapshot(null)
    void window.agentswitch.git.status(dir).then((result) => {
      if (id !== request.current) return
      if (result.ok) setSnapshot({ dir, status: result })
      else setSnapshot(null)
    }).catch(() => {
      if (id === request.current) setSnapshot(null)
    })
  }, [dir])

  useEffect(() => {
    refresh()
    if (!dir) return
    window.addEventListener('focus', refresh)
    return () => {
      request.current++
      window.removeEventListener('focus', refresh)
    }
  }, [dir, refresh])

  const wasRunning = useRef(agentRunning)
  useEffect(() => {
    if (wasRunning.current && !agentRunning) refresh()
    wasRunning.current = agentRunning
  }, [agentRunning, refresh])

  const refreshAll = () => {
    refresh()
    refreshFiles()
  }
  const current = useRef({ dir, threadId, repoPath, refreshAll })
  current.current = { dir, threadId, repoPath, refreshAll }

  const run: RunGit = async (op, { errorToast = true } = {}) => {
    const context = current.current
    if (!getSettings().showGitTools) return { ok: false, error: t('git.failed') }
    if (!dir || !repoPath || dir !== context.dir || threadId !== context.threadId || repoPath !== context.repoPath) {
      return { ok: false, error: t('git.failed') }
    }
    if (pendingByDir.has(repoPath)) {
      const error = t('git.repoBusy')
      if (errorToast) toast({ kind: 'error', title: error })
      return { ok: false, code: 'busy', error }
    }
    pendingByDir.set(repoPath, op.kind)
    notifyPending()
    try {
      const result = await window.agentswitch.git.mutate(dir, op, threadId)
      if (!getSettings().showGitTools) return result
      if (result.ok) toast({ kind: 'success', title: resultTitle(op, result) })
      else if (errorToast) toast({
        kind: 'error',
        title: gitErrorTitle(result),
        desc: gitErrorDetail(result)
      })
      return result
    } catch (error) {
      const detail = String(error)
      if (errorToast && getSettings().showGitTools) toast({ kind: 'error', title: t('git.failed'), desc: detail })
      return { ok: false, error: detail }
    } finally {
      pendingByDir.delete(repoPath)
      notifyPending()
      if (current.current.repoPath === repoPath || current.current.dir === dir) current.current.refreshAll()
    }
  }

  return { status, disabled: pending !== null, pending, run, refresh, refreshAll }
}
