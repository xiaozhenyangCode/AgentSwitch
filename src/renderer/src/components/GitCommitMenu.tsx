import { useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { GitGraphCommit, GitResetMode } from '@shared/types'
import { useLayer } from '../lib/escStack'
import { btnPrimary, btnSecondary } from '../lib/ui'
import { useApp } from '../state/AppContext'
import { t } from '../state/i18n'
import type { ProjectGitTools, RunGit } from '../state/useProjectGit'
import { Modal } from './common'
import { gitInput } from './GitBranchMenu'

export type GitMenuSelection = { commit: GitGraphCommit; x: number; y: number; trigger: HTMLElement }
const resetModes: GitResetMode[] = ['soft', 'mixed', 'hard']
const resetLabels = { soft: 'git.resetSoft', mixed: 'git.resetMixed', hard: 'git.resetHard' } as const

export function GitCommitMenu({ dir, tools, selection, host, onClose, onBranchForm, onTagForm, onCopyHash }: {
  dir: string
  tools: ProjectGitTools | null
  selection: GitMenuSelection
  host: HTMLElement
  onClose: () => void
  onBranchForm: () => void
  onTagForm: () => void
  onCopyHash: (hash: string) => void
}) {
  const { confirm, toast } = useApp()
  const menu = useRef<HTMLDivElement>(null)
  const { commit, x, y, trigger } = selection
  const close = () => { onClose(); trigger.focus({ preventScroll: true }) }
  useLayer({ onEsc: close, onClose: close })

  useLayoutEffect(() => {
    const el = menu.current
    if (!el) return
    const fit = () => {
      el.style.left = Math.max(8, Math.min(x, window.innerWidth - el.offsetWidth - 8)) + 'px'
      el.style.top = Math.max(8, Math.min(y, window.innerHeight - el.offsetHeight - 8)) + 'px'
    }
    const dismiss = (event: PointerEvent) => {
      if (!el.contains(event.target as Node)) onClose()
    }
    fit()
    el.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus({ preventScroll: true })
    window.addEventListener('pointerdown', dismiss, true)
    window.addEventListener('resize', fit)
    return () => {
      window.removeEventListener('pointerdown', dismiss, true)
      window.removeEventListener('resize', fit)
    }
  }, [x, y, onClose])

  const copyMessage = async () => {
    try {
      const result = await window.agentswitch.git.commitDetail(dir, commit.hash, true)
      if (!result.ok) throw new Error(result.error)
      await window.agentswitch.sys.copy(result.commit.message)
      toast({ kind: 'success', title: t('common.copied') })
    } catch (error) {
      toast({ kind: 'error', title: t('git.copyMessageFailed'), desc: String(error) })
    }
  }
  const reset = async (mode: GitResetMode) => {
    if (!tools) return
    if (mode === 'hard') {
      const title = t(resetLabels.hard)
      if (!(await confirm({ title, confirmLabel: title, destructive: true,
        message: t('git.resetHardConfirm', { hash: commit.shortHash })
      }))) return
    }
    await tools.run({ kind: 'reset', mode, hash: commit.hash })
  }
  const item = (label: string, action: () => void, disabled = false, destructive = false) => (
    <button role="menuitem" type="button" key={label} tabIndex={-1} disabled={disabled} onClick={() => { close(); action() }}
      className={`block w-full rounded-md px-2 py-1.5 text-left text-[12px] focus-visible:bg-surface-2 focus-visible:outline-none hover:bg-surface-2 disabled:opacity-45 ${destructive ? 'text-danger' : 'text-ink'}`}>
      {label}
    </button>
  )
  return createPortal(
    <div role="menu" aria-label={t('git.commitActions', { hash: commit.shortHash })} ref={menu}
      className="fixed z-10 max-h-[calc(100vh-16px)] w-max max-w-[calc(100vw-16px)] overflow-y-auto rounded-lg border border-editor-hairline bg-elevated p-1 shadow-lg"
      onContextMenu={(event) => event.preventDefault()}
      onKeyDown={(event) => {
        if (event.key === 'Tab') {
          event.preventDefault()
          close()
          return
        }
        if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return
        event.preventDefault()
        event.stopPropagation()
        const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role=menuitem]:not(:disabled)'))
        const index = items.indexOf(document.activeElement as HTMLButtonElement)
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
          : (index + (event.key === 'ArrowUp' ? -1 : 1) + items.length) % items.length
        items[next]?.focus()
      }}>
      {tools && <>
        {item(t('git.checkoutCommit'), () => void tools.run({ kind: 'checkoutCommit', hash: commit.hash }), tools.disabled)}
        {item(t('git.createBranch'), onBranchForm, tools.disabled)}
        {item(t('git.createTag'), onTagForm, tools.disabled)}
      </>}
      {item(t('git.copyFullHash'), () => onCopyHash(commit.hash))}
      {item(t('git.copyCommitMessage'), () => void copyMessage())}
      {tools && <>
        <div role="separator" className="my-1 border-t border-hairline" />
        {item(t('git.cherryPick'), () => void tools.run({ kind: 'cherryPick', hash: commit.hash }), tools.disabled)}
        {item(t('git.revertCommit'), () => void tools.run({ kind: 'revert', hash: commit.hash, mainline: commit.parents.length > 1 ? 1 : undefined }), tools.disabled)}
        {resetModes.map((mode) => item(t(resetLabels[mode]), () => void reset(mode), tools.disabled, mode === 'hard'))}
      </>}
    </div>,
    host
  )
}

export function GitBranchFromCommitForm({ commit, disabled, run, onClose }: {
  commit: GitGraphCommit; disabled: boolean; run: RunGit; onClose: () => void
}) {
  const [name, setName] = useState('')
  return (
    <Modal width={400} onClose={onClose}>
      <form className="space-y-3 p-5" onSubmit={async (event) => {
        event.preventDefault()
        if (disabled || !name.trim()) return
        if ((await run({ kind: 'createBranch', name: name.trim(), startPoint: commit.hash })).ok) onClose()
      }}>
        <h2 className="text-[16px] font-semibold">{t('git.branchBase', { name: commit.shortHash })}</h2>
        <label className="block space-y-1 text-[12px] text-ink-2">{t('git.branchName')}
          <input className={gitInput} value={name} onChange={(event) => setName(event.target.value)} autoFocus required />
        </label>
        <div className="flex justify-end gap-2">
          <button className={btnSecondary} type="button" onClick={onClose}>{t('common.cancel')}</button>
          <button className={btnPrimary} type="submit" disabled={disabled || !name.trim()}>{t('git.createBranch')}</button>
        </div>
      </form>
    </Modal>
  )
}
