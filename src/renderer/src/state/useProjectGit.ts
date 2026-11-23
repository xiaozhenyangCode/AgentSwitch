import { useCallback, useEffect, useRef, useState } from 'react'
import type { GitMutation, GitMutationResult, GitStatus } from '@shared/types'
import { useApp } from './AppContext'
import { t } from './i18n'
import { getSettings } from './settings'

export type RunGit = (op: GitMutation) => Promise<GitMutationResult>

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
  invalidBranch: 'git.invalidBranch', busy: 'git.agentBusy', switchChanges: 'git.errSwitchChanges',
  diverged: 'git.errDiverged', noUpstream: 'git.errNoUpstream', auth: 'git.errAuth',
  pushRejected: 'git.errPushRejected', indexLocked: 'git.errIndexLocked'
} as const

export function useProjectGit(dir: string | null, threadId: string | null, busy: boolean, refreshFiles: () => void) {
  const { toast } = useApp()
  const [snapshot, setSnapshot] = useState<{ dir: string; status: GitStatus } | null>(null)
  const [pending, setPending] = useState<{ dir: string; kind: GitMutation['kind'] } | null>(null)
  const operation = useRef(false)
  const request = useRef(0)

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

  const wasBusy = useRef(busy)
  useEffect(() => {
    if (wasBusy.current && !busy) refresh()
    wasBusy.current = busy
  }, [busy, refresh])

  const refreshAll = () => {
    refresh()
    refreshFiles()
  }
  const current = useRef({ dir, threadId, busy, refreshAll })
  current.current = { dir, threadId, busy, refreshAll }

  const run: RunGit = async (op) => {
    const context = current.current
    if (!getSettings().showGitTools) return { ok: false, error: t('git.failed') }
    if (!dir || dir !== context.dir || threadId !== context.threadId || context.busy || operation.current) {
      if (context.busy) toast({ kind: 'error', title: t('git.agentBusy') })
      return { ok: false, error: context.busy ? t('git.agentBusy') : t('git.failed') }
    }
    operation.current = true
    setPending({ dir, kind: op.kind })
    try {
      const result = await window.agentswitch.git.mutate(dir, op, threadId)
      if (!getSettings().showGitTools) return result
      if (result.ok) toast({ kind: 'success', title: resultTitle(op, result) })
      else toast({
        kind: 'error',
        title: t(result.code ? errorTitles[result.code] : 'git.failed'),
        desc: result.code === 'busy' ? undefined : result.error
      })
      return result
    } catch (error) {
      const detail = String(error)
      if (getSettings().showGitTools) toast({ kind: 'error', title: t('git.failed'), desc: detail })
      return { ok: false, error: detail }
    } finally {
      operation.current = false
      setPending(null)
      current.current.refreshAll()
    }
  }

  const status = dir && snapshot?.dir === dir && snapshot.status.repo ? snapshot.status : null
  return { status, disabled: busy || pending !== null, pending: pending?.dir === dir ? pending.kind : null, run, refreshAll }
}
