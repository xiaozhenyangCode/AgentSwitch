import { useEffect, useRef, useState } from 'react'
import type { ProfileKind } from '@shared/types'
import { useApp } from '../state/AppContext'
import { KIND_META, btnGhost, btnPrimary, btnSecondary, inputCls } from '../lib/ui'
import { KindAvatar, Modal } from './common'
import { IconX } from './icons'

function suggestName(kind: ProfileKind, used: string[]): string {
  for (let n = 1; ; n++) {
    const name = `${KIND_META[kind].name} 账号 ${n}`
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
      const id = await window.agentmux.profiles.add(kind, name)
      addRequest?.onCreated?.(id)
      closeAddAccount()
      if (andLogin) openLogin(id)
      else toast({ kind: 'success', title: `已添加「${name.trim() || '新账号'}」` })
    } catch (e) {
      toast({ kind: 'error', title: '添加账号失败', desc: String(e) })
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
            <div className="text-[20px] leading-6 font-semibold tracking-tight text-ink">添加 {meta.name} 账号</div>
            <div className="mt-1 text-[14px] leading-relaxed text-ink-2">每个账号使用独立的配置目录，登录信息互不影响。</div>
          </div>
          <button type="button" className="rounded-full p-1.5 text-ink-3 hover:bg-fill hover:text-ink" onClick={closeAddAccount}>
            <IconX size={16} />
          </button>
        </div>

        <div className="mt-6">
          <div className="mb-1.5 text-[13px] font-medium text-ink">账号名称</div>
          <input ref={inputRef} className={inputCls + ' h-10'} value={name} onChange={(e) => setName(e.target.value)} placeholder={`${meta.name} 账号`} />
          <div className="mt-1.5 text-[12px] text-ink-3">例如「工作号」「个人号」，之后可以随时重命名。</div>
        </div>

        {!installed && (
          <div className="mt-4 rounded-xl bg-[#FFF8EB] px-4 py-3 text-[13px] leading-relaxed text-[#9A5B13]">
            {meta.cli} 还没有安装。账号会先创建好，安装完成后再登录即可。
          </div>
        )}

        <div className="mt-7 flex justify-end gap-2.5">
          <button type="button" className={btnSecondary} onClick={closeAddAccount}>
            取消
          </button>
          {installed ? (
            <>
              <button type="button" className={btnSecondary} disabled={busy} onClick={() => void create(false)}>
                仅添加
              </button>
              <button type="submit" className={btnPrimary} disabled={busy}>
                添加并登录
              </button>
            </>
          ) : (
            <button type="submit" className={btnPrimary} disabled={busy}>
              添加账号
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
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && c?.resolve(false)
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
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
              className="mt-[3px] accent-[#FF3B30]"
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
            取消
          </button>
          <button
            ref={okRef}
            className={c.destructive ? btnPrimary.replace('bg-accent', 'bg-[#FF3B30]').replace('hover:bg-accent-hover', 'hover:bg-[#E0352B]') + ' shadow-none' : btnPrimary}
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
    await window.agentmux.cli.update(kind, { binary, installCommand, updateCommand })
    toast({ kind: 'success', title: `${meta.cli} 设置已保存` })
    close()
  }
  const reset = async () => {
    await window.agentmux.cli.reset(kind)
    close()
  }

  return (
    <Modal onClose={close} width={560}>
      <div className="flex items-center gap-3.5 border-b border-hairline px-7 py-5">
        <KindAvatar kind={kind} size={36} />
        <div className="flex-1">
          <div className="text-[17px] font-semibold text-ink">{meta.cli}</div>
          <div className="text-[13px] text-ink-2">命令行工具设置 · 所有 {meta.name} 账号共用</div>
        </div>
        <button className="rounded-full p-1.5 text-ink-3 hover:bg-fill hover:text-ink" onClick={close}>
          <IconX size={16} />
        </button>
      </div>
      <div className="space-y-5 px-7 py-6">
        <div>
          <div className="mb-1.5 text-[13px] font-medium text-ink">可执行文件</div>
          <input className={mono} value={binary} onChange={(e) => setBinary(e.target.value)} />
          <div className="mt-1.5 text-[12px] text-ink-3">在 PATH 中查找它来判断是否已安装{k.binaryPath ? `，当前：${k.binaryPath}` : ''}</div>
        </div>
        <div>
          <div className="mb-1.5 text-[13px] font-medium text-ink">安装命令</div>
          <input className={mono} value={installCommand} onChange={(e) => setInstallCommand(e.target.value)} />
          <div className="mt-1.5 text-[12px] text-ink-3">使用真实 HOME 与登录 Shell 执行，安装到全局 PATH</div>
        </div>
        <div>
          <div className="mb-1.5 text-[13px] font-medium text-ink">更新命令</div>
          <input className={mono} value={updateCommand} onChange={(e) => setUpdateCommand(e.target.value)} placeholder="留空则重新执行安装命令" />
          <div className="mt-1.5 text-[12px] text-ink-3">已安装时点击「更新」执行</div>
        </div>
      </div>
      <div className="flex items-center justify-between border-t border-hairline px-7 py-4">
        <button className={btnGhost} onClick={() => void reset()}>
          恢复默认
        </button>
        <div className="flex gap-2.5">
          <button className={btnSecondary} onClick={close}>
            取消
          </button>
          <button className={btnPrimary} onClick={() => void save()}>
            保存
          </button>
        </div>
      </div>
    </Modal>
  )
}
