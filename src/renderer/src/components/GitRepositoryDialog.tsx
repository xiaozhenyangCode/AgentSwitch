import { useEffect, useState } from 'react'
import type { GitRemote, GitResult, GitTag } from '@shared/types'
import { btnPrimary, btnSecondary } from '../lib/ui'
import { useApp } from '../state/AppContext'
import { currentLocale, t } from '../state/i18n'
import type { ProjectGitTools, RunGit } from '../state/useProjectGit'
import { Modal, Segmented } from './common'
import { gitInput } from './GitBranchMenu'
import { Spinner } from './icons'

const action = 'rounded px-2 py-1 text-[12px] text-ink-2 hover:bg-surface-2 disabled:opacity-45'
const label = 'block space-y-1 text-[12px] font-medium text-ink-2'
type Tab = 'tags' | 'remotes'
type TagSource = 'local' | 'fetch' | 'push'

export function GitTagForm({ target, run, disabled, onClose, onSaved }: {
  target?: string; run: RunGit; disabled: boolean; onClose: () => void; onSaved?: () => void
}) {
  const [name, setName] = useState('')
  const [annotated, setAnnotated] = useState(false)
  const [message, setMessage] = useState('')
  return (
    <Modal onClose={onClose} width={400}>
      <form className="space-y-3 p-5" onSubmit={async (event) => {
        event.preventDefault()
        if (disabled || !name.trim() || (annotated && !message.trim())) return
        const result = await run({ kind: 'createTag', name: name.trim(), target, message: annotated ? message : undefined })
        if (result.ok) { onSaved?.(); onClose() }
      }}>
        <h2 className="text-[16px] font-semibold">{t('git.createTag')}</h2>
        {target && <p className="break-all font-mono text-[12px] text-ink-2">{target}</p>}
        <label className={label}>{t('git.tagName')}
          <input className={gitInput} value={name} onChange={(event) => setName(event.target.value)} autoFocus required />
        </label>
        <label className="flex items-center gap-2 text-[12px]">
          <input type="checkbox" checked={annotated} onChange={(event) => setAnnotated(event.target.checked)} />
          {t('git.tagAnnotated')}
        </label>
        {annotated && <label className={label}>{t('git.tagMessage')}
          <textarea className={gitInput} rows={3} value={message} onChange={(event) => setMessage(event.target.value)} required />
        </label>}
        <div className="flex justify-end gap-2">
          <button type="button" className={btnSecondary} onClick={onClose}>{t('common.cancel')}</button>
          <button type="submit" className={btnPrimary} disabled={disabled || !name.trim() || (annotated && !message.trim())}>{t('git.createTag')}</button>
        </div>
      </form>
    </Modal>
  )
}

function RemoteForm({ remote, run, disabled, onClose, onSaved }: {
  remote?: GitRemote; run: RunGit; disabled: boolean; onClose: () => void; onSaved: () => void
}) {
  const [name, setName] = useState(remote?.name ?? '')
  const [url, setUrl] = useState(remote?.fetchUrl ?? '')
  const [pushUrl, setPushUrl] = useState(remote?.pushUrl ?? '')
  const title = t(remote ? 'git.editRemote' : 'git.addRemote')
  return (
    <Modal onClose={onClose} width={445}>
      <form className="space-y-3 p-5" onSubmit={async (event) => {
        event.preventDefault()
        if (disabled || !name || !url || (remote && !pushUrl)) return
        const result = await run(remote
          ? { kind: 'setRemoteUrl', name, url, pushUrl: pushUrl === remote.pushUrl ? undefined : pushUrl }
          : { kind: 'addRemote', name, url })
        if (result.ok) { onSaved(); onClose() }
      }}>
        <h2 className="text-[16px] font-semibold">{title}</h2>
        <label className={label}>{t('git.remoteName')}
          <input className={gitInput} autoFocus={!remote} readOnly={!!remote} required value={name} onChange={(event) => setName(event.target.value)} />
        </label>
        <label className={label}>{t('git.fetchUrl')}
          <input className={gitInput} autoFocus={!!remote} required value={url} onChange={(event) => setUrl(event.target.value)} />
        </label>
        {remote && <label className={label}>{t('git.pushUrl')}
          <input className={gitInput} required value={pushUrl} onChange={(event) => setPushUrl(event.target.value)} />
        </label>}
        <div className="flex justify-end gap-2">
          <button type="button" className={btnSecondary} onClick={onClose}>{t('common.cancel')}</button>
          <button type="submit" className={btnPrimary} disabled={disabled || !name || !url || (!!remote && !pushUrl)}>{t('common.save')}</button>
        </div>
      </form>
    </Modal>
  )
}

type RepositoryEntries = { kind: 'tags'; tags: GitTag[] } | { kind: 'remotes'; remotes: GitRemote[] }
type DialogForm = { kind: 'tag' } | { kind: 'remote'; remote?: GitRemote }
const visibleUrl = (url: string) => url.replace(/(\w+:\/\/)[^\s/?#]*@/gi, '$1***@')
  .replace(/\?.*$/, '?…')

export function GitRepositoryDialog({ dir, initialTab, tools, onClose }: {
  dir: string; initialTab: Tab; tools: ProjectGitTools; onClose: () => void
}) {
  const { confirm } = useApp()
  const { run, disabled, status } = tools
  const [tab, setTab] = useState(initialTab)
  const [remoteName, setRemoteName] = useState('')
  const [tagSource, setTagSource] = useState<TagSource>('local')
  const [form, setForm] = useState<DialogForm | null>(null)
  const [request, setRequest] = useState(0)
  const [result, setResult] = useState<GitResult<RepositoryEntries> | null>(null)
  const remote = status.remotes.includes(remoteName) ? remoteName : status.remotes[0] ?? ''
  const lookupRemote = tab === 'tags' && tagSource !== 'local' ? remote || undefined : undefined
  const pushDestination = !!lookupRemote && tagSource === 'push'
  const reload = () => { setResult(null); setRequest((value) => value + 1) }
  useEffect(() => {
    let active = true
    const read = async (): Promise<GitResult<RepositoryEntries>> => {
      if (tab === 'remotes') {
        const result = await window.agentswitch.git.remotes(dir)
        return result.ok ? { ...result, kind: 'remotes' } : result
      }
      const result = await window.agentswitch.git.tags(dir, lookupRemote, pushDestination)
      return result.ok ? { ...result, kind: 'tags' } : result
    }
    void read().then((next) => { if (active) setResult(next) },
      (error) => { if (active) setResult({ ok: false, error: String(error) }) })
    return () => { active = false }
  }, [dir, tab, lookupRemote, pushDestination, request])

  const deleteTag = async (name: string) => {
    const title = t(lookupRemote ? 'git.deleteRemoteTag' : 'git.deleteTag')
    const message = lookupRemote ? t('git.deleteRemoteTagConfirm', { name, remote: lookupRemote }) : t('git.deleteTagConfirm', { name })
    if (!(await confirm({ title, confirmLabel: title, message, destructive: true }))) return
    const result = await run(lookupRemote ? { kind: 'deleteRemoteTag', name, remote: lookupRemote } : { kind: 'deleteTag', name })
    if (result.ok) reload()
  }
  const deleteRemote = async (name: string) => {
    const title = t('git.removeRemote')
    if (!(await confirm({ title, confirmLabel: title, message: t('git.removeRemoteConfirm', { name }), destructive: true }))) return
    if ((await run({ kind: 'removeRemote', name })).ok) reload()
  }

  return (
    <>
      <Modal onClose={onClose} width={690}>
        <div role="dialog" aria-label={t(`git.${tab}`)} className="max-w-[94vw] space-y-3 p-5">
          <header className="flex flex-wrap items-center gap-2">
            <Segmented size="sm" value={tab} onChange={(next) => {
              if (next !== tab) { setResult(null); setTab(next) }
            }} options={[
              { value: 'tags', label: t('git.tags') }, { value: 'remotes', label: t('git.remotes') }
            ]} />
            <div className="flex-1" />
            <button type="button" className={action} onClick={reload} disabled={!result || disabled}>{t('common.refresh')}</button>
            <button type="button" className={action} onClick={onClose}>{t('common.close')}</button>
          </header>
          {tab === 'tags' ? (
            <div className="flex flex-wrap items-center gap-2 border-y border-hairline py-2">
              <select className={gitInput + ' w-auto!'} aria-label={t('git.tagSource')} value={lookupRemote ? tagSource : 'local'}
                onChange={(event) => { setResult(null); setTagSource(event.target.value as TagSource) }}>
                <option value="local">{t('git.localTags')}</option>
                <option value="fetch" disabled={!remote}>{t('git.fetchTags')}</option>
                <option value="push" disabled={!remote}>{t('git.pushDestinationTags')}</option>
              </select>
              <select className={gitInput + ' w-auto!'} aria-label={t('git.remoteTarget')} value={remote} disabled={!remote}
                onChange={(event) => {
                  if (lookupRemote) setResult(null)
                  setRemoteName(event.target.value)
                }}>
                {!remote && <option value="">{t('git.noRemotes')}</option>}
                {status.remotes.map((name) => <option key={name}>{name}</option>)}
              </select>
              {!lookupRemote && <>
                <button type="button" className={action} disabled={disabled || !status.headCommit}
                  onClick={() => setForm({ kind: 'tag' })}>{t('git.createTag')}</button>
                <button type="button" className={action} disabled={disabled || !remote || !result?.ok || result.kind !== 'tags' || !result.tags.length}
                  onClick={() => void run({ kind: 'pushTag', remote, all: true })}>{t('git.pushAllTags')}</button>
              </>}
            </div>
          ) : <button type="button" className={btnSecondary} disabled={disabled} onClick={() => setForm({ kind: 'remote' })}>{t('git.addRemote')}</button>}
          {!result && <div className="py-3"><Spinner size={15} /></div>}
          {result && !result.ok && <p role="alert" className="whitespace-pre-wrap break-words text-[12px] text-danger">{result.error}</p>}
          {result?.ok && <div className="max-h-[54vh] divide-y divide-hairline overflow-y-auto">
            {result.kind === 'tags' ? (
              result.tags.length ? result.tags.map((tag) => (
                <div key={tag.name} className="flex flex-wrap items-start gap-2 py-2">
                  <div className="min-w-44 flex-1">
                    <div className="break-all text-[13px] font-medium">{tag.name}</div>
                    <div className="text-[11px] text-ink-3">
                      <span className="font-mono">{tag.shortHash}</span> · {t(tag.annotated ? 'git.tagAnnotated' : 'git.tagLightweight')}
                      {tag.tagger && ` · ${tag.tagger}`}{tag.timestamp > 0 && ` · ${new Date(tag.timestamp).toLocaleString(currentLocale())}`}
                    </div>
                    {tag.message && <p className="whitespace-pre-wrap break-words text-[12px] text-ink-2">{tag.message}</p>}
                  </div>
                  {!lookupRemote && <button type="button" className={action} disabled={disabled || !remote}
                    onClick={() => void run({ kind: 'pushTag', name: tag.name, remote })}>{t('git.pushTag')}</button>}
                  {(!lookupRemote || pushDestination) && <button type="button" className={action + ' text-danger!'} disabled={disabled}
                    onClick={() => void deleteTag(tag.name)}>{t(lookupRemote ? 'git.deleteRemoteTag' : 'git.deleteTag')}</button>}
                </div>
              )) : <p className="py-3 text-[12px] text-ink-3">{t('git.noTags')}</p>
            ) : (
              result.remotes.length ? result.remotes.map((item) => (
                <div key={item.name} className="flex flex-wrap items-start gap-2 py-2">
                  <div className="min-w-44 flex-1 space-y-0.5">
                    <div className="break-all text-[13px] font-medium">{item.name}</div>
                    <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-2 text-[11px] text-ink-2">
                      <dt>{t('git.fetchUrl')}</dt><dd className="break-all font-mono">{visibleUrl(item.fetchUrl)}</dd>
                      <dt>{t('git.pushUrl')}</dt><dd className="break-all font-mono">{visibleUrl(item.pushUrl)}</dd>
                    </dl>
                  </div>
                  <button type="button" className={action} disabled={disabled}
                    onClick={() => setForm({ kind: 'remote', remote: item })}>{t('git.editRemote')}</button>
                  <button type="button" className={action + ' text-danger!'} disabled={disabled}
                    onClick={() => void deleteRemote(item.name)}>{t('git.removeRemote')}</button>
                </div>
              )) : <p className="py-3 text-[12px] text-ink-3">{t('git.noRemotes')}</p>
            )}
          </div>}
        </div>
      </Modal>
      {form?.kind === 'tag' && <GitTagForm run={run} disabled={disabled} onSaved={reload} onClose={() => setForm(null)} />}
      {form?.kind === 'remote' && <RemoteForm remote={form.remote} run={run} disabled={disabled} onSaved={reload} onClose={() => setForm(null)} />}
    </>
  )
}
