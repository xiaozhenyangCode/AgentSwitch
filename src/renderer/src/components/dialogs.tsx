import { useEffect, useRef, useState } from 'react'
import { API_KEY_PAGES, type ApiKeyConfig, type ProfileKind, type ProfileState } from '@shared/types'
import { ipcError, useApp } from '../state/AppContext'
import { KIND_META, btnGhost, btnPrimary, btnSecondary, inputCls } from '../lib/ui'
import { KindAvatar, Modal, ProfileAvatar } from './common'
import { IconX } from './icons'
import { t } from '../state/i18n'

type Conn = 'subscription' | ApiKeyConfig['provider']

function suggestName(kind: ProfileKind, used: string[], conn: Conn = 'subscription'): string {
  for (let n = 1; ; n++) {
    const name =
      conn === 'deepseek' ? t('acct.deepseekName', { n }) : conn === 'custom' ? t('acct.customName', { n }) : t('acct.defaultName', { kind: KIND_META[kind].name, n })
    if (!used.includes(name)) return name
  }
}

const CONNS: Record<ProfileKind, Conn[]> = {
  claude: ['subscription', 'official', 'deepseek', 'custom'],
  codex: ['subscription', 'official'],
  gemini: ['subscription', 'official']
}

const connLabel = (kind: ProfileKind, c: Conn): string =>
  c === 'subscription'
    ? t(`add.conn.subscription.${kind}`)
    : c === 'official'
      ? t(`add.conn.official.${kind}`)
      : c === 'deepseek'
        ? t('add.conn.deepseek')
        : t('add.conn.custom')

/** Create a new isolated account; optionally go straight into login. */
export function AddAccountModal() {
  const { addRequest, closeAddAccount, profiles, kindState, openLogin, toast } = useApp()
  const kind = addRequest!.kind
  const meta = KIND_META[kind]
  const used = profiles.map((p) => p.name)
  const [name, setName] = useState(() => suggestName(kind, used))
  const [nameEdited, setNameEdited] = useState(false)
  const [conn, setConn] = useState<Conn>('subscription')
  const [key, setKey] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [models, setModels] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const usesKey = conn !== 'subscription'
  const keyPage = conn === 'deepseek' ? API_KEY_PAGES.deepseek : conn === 'official' ? API_KEY_PAGES[kind] : null

  const pickConn = (c: Conn) => {
    setConn(c)
    setError(null)
    if (!nameEdited) setName(suggestName(kind, used, c))
  }
  const inputRef = useRef<HTMLInputElement>(null)
  const installed = !!kindState(kind)?.binaryPath

  useEffect(() => {
    inputRef.current?.select()
  }, [])

  const create = async (andLogin: boolean) => {
    if (usesKey && !key.trim()) return setError(t('apikey.empty'))
    setBusy(true)
    setError(null)
    try {
      const connect = usesKey
        ? {
            apiKey: {
              provider: conn,
              ...(conn === 'custom' ? { baseUrl, models: models.split(/[,\n]/).map((m) => m.trim()).filter(Boolean) } : {})
            } as ApiKeyConfig,
            key
          }
        : undefined
      const id = await window.agentswitch.profiles.add(kind, name, connect)
      setKey('')
      addRequest?.onCreated?.(id)
      closeAddAccount()
      if (andLogin && !usesKey) openLogin(id)
      else toast({ kind: 'success', title: t('add.added', { name: name.trim() || t('add.newAccount') }) })
    } catch (e) {
      if (usesKey) setError(ipcError(e))
      else toast({ kind: 'error', title: t('add.failed'), desc: ipcError(e) })
      setBusy(false)
    }
  }

  return (
    <Modal onClose={closeAddAccount} width={440}>
      <form
        className="p-7"
        onSubmit={(e) => {
          e.preventDefault()
          void create(installed)
        }}
      >
        <div className="flex items-start gap-3.5">
          <KindAvatar kind={kind} size={44} />
          <div className="flex-1 pt-0.5">
            <div className="text-[20px] leading-6 font-semibold tracking-tight text-ink">{t('add.title', { name: meta.name })}</div>
            <div className="mt-1 text-[14px] leading-relaxed text-ink-2">{t('add.desc')}</div>
          </div>
          <button type="button" className="rounded-full p-1.5 text-ink-3 hover:bg-fill hover:text-ink" onClick={closeAddAccount}>
            <IconX size={16} />
          </button>
        </div>

        <div className="mt-6" role="radiogroup" aria-label={t('add.connect')}>
          <div className="mb-1.5 text-[13px] font-medium text-ink">{t('add.connect')}</div>
          <div className="flex flex-col gap-1">
            {CONNS[kind].map((c) => (
              <label key={c} className="flex cursor-pointer items-center gap-2.5 rounded-lg px-2 py-1.5 text-[14px] text-ink hover:bg-fill">
                <input type="radio" name="conn" checked={conn === c} onChange={() => pickConn(c)} className="accent-accent" />
                {connLabel(kind, c)}
              </label>
            ))}
          </div>
        </div>

        {usesKey && (
          <div className="mt-4 flex flex-col gap-4">
            {conn === 'custom' && (
              <>
                <div>
                  <div className="mb-1.5 text-[13px] font-medium text-ink">{t('apikey.baseUrl')}</div>
                  <input className={inputCls + ' h-10'} value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://example.com/anthropic" spellCheck={false} />
                </div>
                <div>
                  <div className="mb-1.5 text-[13px] font-medium text-ink">{t('apikey.models')}</div>
                  <textarea className={inputCls + ' min-h-[64px] py-2'} value={models} onChange={(e) => setModels(e.target.value)} spellCheck={false} />
                  <div className="mt-1.5 text-[12px] text-ink-3">{t('apikey.modelsHint')}</div>
                </div>
              </>
            )}
            <div>
              <div className="mb-1.5 flex items-center justify-between">
                <span className="text-[13px] font-medium text-ink">{t('apikey.key')}</span>
                {keyPage && (
                  <button type="button" className="text-[13px] font-medium text-accent hover:text-accent-hover" onClick={() => void window.agentswitch.sys.openExternal(keyPage)}>
                    {t('apikey.getKey')}
                  </button>
                )}
              </div>
              <input
                type="password"
                className={inputCls + ' h-10'}
                value={key}
                onChange={(e) => setKey(e.target.value)}
                placeholder={t('apikey.keyPlaceholder')}
                autoComplete="off"
                spellCheck={false}
              />
              <div className="mt-1.5 text-[12px] text-ink-3">{t('apikey.keyHint')}</div>
            </div>
          </div>
        )}

        <div className="mt-6">
          <div className="mb-1.5 text-[13px] font-medium text-ink">{t('add.name')}</div>
          <input
            ref={inputRef}
            className={inputCls + ' h-10'}
            value={name}
            onChange={(e) => {
              setName(e.target.value)
              setNameEdited(true)
            }}
            placeholder={t('add.namePlaceholder', { name: meta.name })}
          />
          <div className="mt-1.5 text-[12px] text-ink-3">{t('add.nameHint')}</div>
        </div>

        {error && <div className="mt-4 rounded-xl bg-danger-soft px-4 py-3 text-[13px] leading-relaxed text-danger">{error}</div>}

        {!installed && (
          <div className="mt-4 rounded-xl bg-warn-soft px-4 py-3 text-[13px] leading-relaxed text-warn">
            {t('add.notInstalled', { cli: meta.cli })}
          </div>
        )}

        <div className="mt-7 flex justify-end gap-2.5">
          <button type="button" className={btnSecondary} onClick={closeAddAccount}>
            {t('common.cancel')}
          </button>
          {installed && !usesKey ? (
            <>
              <button type="button" className={btnSecondary} disabled={busy} onClick={() => void create(false)}>
                {t('add.onlyAdd')}
              </button>
              <button type="submit" className={btnPrimary} disabled={busy}>
                {t('add.addAndLogin')}
              </button>
            </>
          ) : (
            <button type="submit" className={btnPrimary} disabled={busy}>
              {t('add.add')}
            </button>
          )}
        </div>
      </form>
    </Modal>
  )
}

/** Vendor page where the account's kind of key is created. */
export const keyPageOf = (p: Pick<ProfileState, 'kind' | 'apiKey'>): string | null =>
  p.apiKey?.provider === 'deepseek' ? API_KEY_PAGES.deepseek : p.apiKey?.provider === 'official' ? API_KEY_PAGES[p.kind] : null

/** Replace an API-key account's key. The old key is never shown. */
export function ChangeKeyModal({ profile, onClose }: { profile: ProfileState; onClose: () => void }) {
  const { toast } = useApp()
  const [key, setKey] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const page = keyPageOf(profile)
  const submit = async () => {
    if (!key.trim()) return setError(t('apikey.empty'))
    setBusy(true)
    try {
      await window.agentswitch.profiles.setKey(profile.id, key)
      setKey('')
      onClose()
      toast({ kind: 'success', title: t('apikey.changed') })
    } catch (e) {
      setError(ipcError(e))
      setBusy(false)
    }
  }
  return (
    <Modal onClose={onClose} width={420}>
      <form
        className="p-7"
        onSubmit={(e) => {
          e.preventDefault()
          void submit()
        }}
      >
        <div className="flex items-start gap-3.5">
          <ProfileAvatar profile={profile} size={36} />
          <div className="flex-1">
            <div className="text-[17px] font-semibold text-ink">{t('apikey.changeTitle', { name: profile.name })}</div>
            <div className="mt-1 text-[13px] leading-relaxed text-ink-2">{t('apikey.changeDesc')}</div>
          </div>
        </div>
        <div className="mt-5">
          <div className="mb-1.5 flex items-center justify-between">
            <span className="text-[13px] font-medium text-ink">{t('apikey.key')}</span>
            {page && (
              <button type="button" className="text-[13px] font-medium text-accent hover:text-accent-hover" onClick={() => void window.agentswitch.sys.openExternal(page)}>
                {t('apikey.getKey')}
              </button>
            )}
          </div>
          <input
            autoFocus
            type="password"
            className={inputCls + ' h-10'}
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder={t('apikey.keyPlaceholder')}
            autoComplete="off"
            spellCheck={false}
          />
        </div>
        {error && <div className="mt-3 text-[13px] text-danger">{error}</div>}
        <div className="mt-6 flex justify-end gap-2.5">
          <button type="button" className={btnSecondary} onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button type="submit" className={btnPrimary} disabled={busy}>
            {t('common.save')}
          </button>
        </div>
      </form>
    </Modal>
  )
}

export function ConfirmDialog() {
  const { confirmState: c } = useApp()
  const okRef = useRef<HTMLButtonElement>(null)
  const [checked, setChecked] = useState(false)
  useEffect(() => {
    okRef.current?.focus()
  }, [c])
  if (!c) return null
  return (
    <Modal onClose={() => c.resolve(false)} width={400}>
      <div className="p-7">
        <div className="text-[17px] font-semibold text-ink">{c.title}</div>
        <div className="mt-2 text-[14px] leading-relaxed text-ink-2">{c.message}</div>
        {c.option && (
          <label className="mt-4 flex cursor-default items-start gap-2.5 rounded-xl bg-fill px-3 py-2.5">
            <input
              type="checkbox"
              className="mt-[3px] accent-red"
              checked={checked}
              onChange={(e) => {
                setChecked(e.target.checked)
                c.option!.onChange(e.target.checked)
              }}
            />
            <span>
              <span className="block text-[13px] font-medium text-ink">{c.option.label}</span>
              {c.option.hint && <span className="mt-0.5 block text-[12px] leading-relaxed text-ink-3">{c.option.hint}</span>}
            </span>
          </label>
        )}
        <div className="mt-7 flex justify-end gap-2.5">
          <button className={btnSecondary} onClick={() => c.resolve(false)}>
            {t('common.cancel')}
          </button>
          <button
            ref={okRef}
            className={c.destructive ? btnPrimary.replace('bg-accent', 'bg-red').replace('hover:bg-accent-hover', 'hover:bg-red') + ' shadow-none' : btnPrimary}
            onClick={() => c.resolve(true)}
          >
            {c.confirmLabel}
          </button>
        </div>
      </div>
    </Modal>
  )
}

/** Per-CLI settings: executable name and install command. */
export function CliConfigModal({ kind }: { kind: ProfileKind }) {
  const { kindState, openCliConfig, toast } = useApp()
  const k = kindState(kind)!
  const [binary, setBinary] = useState(k.binary)
  const [installCommand, setInstallCommand] = useState(k.installCommand)
  const [updateCommand, setUpdateCommand] = useState(k.updateCommand)
  const meta = KIND_META[kind]
  const mono = inputCls + ' font-mono text-[13px]'
  const close = () => openCliConfig(null)

  const save = async () => {
    await window.agentswitch.cli.update(kind, { binary, installCommand, updateCommand })
    toast({ kind: 'success', title: t('cli.saved', { cli: meta.cli }) })
    close()
  }
  const reset = async () => {
    await window.agentswitch.cli.reset(kind)
    close()
  }

  return (
    <Modal onClose={close} width={560}>
      <div className="flex items-center gap-3.5 border-b border-hairline px-7 py-5">
        <KindAvatar kind={kind} size={36} />
        <div className="flex-1">
          <div className="text-[17px] font-semibold text-ink">{meta.cli}</div>
          <div className="text-[13px] text-ink-2">{t('cli.subtitle', { name: meta.name })}</div>
        </div>
        <button className="rounded-full p-1.5 text-ink-3 hover:bg-fill hover:text-ink" onClick={close}>
          <IconX size={16} />
        </button>
      </div>
      <div className="space-y-5 px-7 py-6">
        <div>
          <div className="mb-1.5 text-[13px] font-medium text-ink">{t('cli.binary')}</div>
          <input className={mono} value={binary} onChange={(e) => setBinary(e.target.value)} />
          <div className="mt-1.5 text-[12px] text-ink-3">{t('cli.binaryHint')}{k.binaryPath ? t('cli.binaryCurrent', { path: k.binaryPath }) : ''}</div>
        </div>
        <div>
          <div className="mb-1.5 text-[13px] font-medium text-ink">{t('cli.installCmd')}</div>
          <input className={mono} value={installCommand} onChange={(e) => setInstallCommand(e.target.value)} />
          <div className="mt-1.5 text-[12px] text-ink-3">{t('cli.installHint')}</div>
        </div>
        <div>
          <div className="mb-1.5 text-[13px] font-medium text-ink">{t('cli.updateCmd')}</div>
          <input className={mono} value={updateCommand} onChange={(e) => setUpdateCommand(e.target.value)} placeholder={t('cli.updatePlaceholder')} />
          <div className="mt-1.5 text-[12px] text-ink-3">{t('cli.updateHint')}</div>
        </div>
      </div>
      <div className="flex items-center justify-between border-t border-hairline px-7 py-4">
        <button className={btnGhost} onClick={() => void reset()}>
          {t('cli.resetDefault')}
        </button>
        <div className="flex gap-2.5">
          <button className={btnSecondary} onClick={close}>
            {t('common.cancel')}
          </button>
          <button className={btnPrimary} onClick={() => void save()}>
            {t('common.save')}
          </button>
        </div>
      </div>
    </Modal>
  )
}
