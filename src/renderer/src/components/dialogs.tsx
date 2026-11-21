import { useEffect, useRef, useState } from 'react'
import type { ProfileKind } from '@shared/types'
import { useApp } from '../state/AppContext'
import { KIND_META, btnGhost, btnPrimary, btnSecondary, inputCls } from '../lib/ui'
import { KindAvatar, Modal } from './common'
import { IconX } from './icons'
import { t } from '../state/i18n'

function suggestName(kind: ProfileKind, used: string[]): string {
  for (let n = 1; ; n++) {
    const name = t('acct.defaultName', { kind: KIND_META[kind].name, n })
    if (!used.includes(name)) return name
  }
}

/** Create a new isolated account; optionally go straight into login. */
export function AddAccountModal() {
  const { addRequest, closeAddAccount, profiles, kindState, openLogin, toast } = useApp()
  const kind = addRequest!.kind
  const meta = KIND_META[kind]
  const [name, setName] = useState(() => suggestName(kind, profiles.map((p) => p.name)))
  const [busy, setBusy] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const installed = !!kindState(kind)?.binaryPath

  useEffect(() => {
    inputRef.current?.select()
  }, [])

  const create = async (andLogin: boolean) => {
    setBusy(true)
    try {
      const id = await window.agentswitch.profiles.add(kind, name)
      addRequest?.onCreated?.(id)
      closeAddAccount()
      if (andLogin) openLogin(id)
      else toast({ kind: 'success', title: t('add.added', { name: name.trim() || t('add.newAccount') }) })
    } catch (e) {
      toast({ kind: 'error', title: t('add.failed'), desc: String(e) })
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

        <div className="mt-6">
          <div className="mb-1.5 text-[13px] font-medium text-ink">{t('add.name')}</div>
          <input ref={inputRef} className={inputCls + ' h-10'} value={name} onChange={(e) => setName(e.target.value)} placeholder={t('add.namePlaceholder', { name: meta.name })} />
          <div className="mt-1.5 text-[12px] text-ink-3">{t('add.nameHint')}</div>
        </div>

        {!installed && (
          <div className="mt-4 rounded-xl bg-warn-soft px-4 py-3 text-[13px] leading-relaxed text-warn">
            {t('add.notInstalled', { cli: meta.cli })}
          </div>
        )}

        <div className="mt-7 flex justify-end gap-2.5">
          <button type="button" className={btnSecondary} onClick={closeAddAccount}>
            {t('common.cancel')}
          </button>
          {installed ? (
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
