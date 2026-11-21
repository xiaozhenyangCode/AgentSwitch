import { useEffect, useRef, useState } from 'react'
import { KINDS, installSessionId, type ProfileKind, type ProfileState } from '@shared/types'
import { useApp } from '../state/AppContext'
import { KIND_META, TONE, btnGhost, btnRow, btnRowPrimary } from '../lib/ui'
import { KindAvatar, Pill, StatusBadge } from '../components/common'
import { IconDownload, IconGear, IconRefresh, Spinner } from '../components/icons'

export function EnginesPage() {
  const { profiles, loaded } = useApp()
  return (
    <div className="h-full overflow-y-auto">
      <div className="drag h-14" />
      <div className="mx-auto max-w-[760px] px-10 pb-16">
        <h1 className="text-[26px] leading-tight font-semibold tracking-tight text-ink">模型引擎</h1>
        <p className="mt-2 text-[14px] leading-relaxed text-ink-2">
          安装命令行工具并添加账号。每个账号的登录信息相互独立，可以同时使用多个账号。
        </p>
        {loaded && (
          <div className="mt-9 space-y-9">
            {KINDS.map((k) => (
              <EngineGroup key={k} kind={k} accounts={profiles.filter((p) => p.kind === k)} />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

/** Briefly highlights an element when another page navigates here with a focus target. */
function useFlash(match: (target: string) => boolean): boolean {
  const { engineFocus } = useApp()
  const [on, setOn] = useState(false)
  useEffect(() => {
    if (!engineFocus || !match(engineFocus.target)) return
    setOn(true)
    const t = setTimeout(() => setOn(false), 1600)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engineFocus])
  return on
}

function EngineGroup({ kind, accounts }: { kind: ProfileKind; accounts: ProfileState[] }) {
  const { install, refresh, openDrawer, toast, kindState, openCliConfig, openAddAccount } = useApp()
  const meta = KIND_META[kind]
  const ks = kindState(kind)
  const ref = useRef<HTMLElement>(null)
  const installed = !!ks?.binaryPath
  const installing = !!ks?.installing
  const [version, setVersion] = useState<string | null>(null)
  const [checking, setChecking] = useState(false)
  const flash = useFlash((t) => t === kind || accounts.some((a) => a.id === t))

  useEffect(() => {
    if (flash) ref.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }, [flash])

  const binPath = ks?.binaryPath ?? null
  useEffect(() => {
    if (!binPath) {
      setVersion(null)
      return
    }
    void window.agentmux.cli.version(kind).then(setVersion)
  }, [kind, binPath])

  const recheck = async () => {
    setChecking(true)
    const s = await refresh()
    setChecking(false)
    const found = !!s.kinds.find((k) => k.kind === kind)?.binaryPath
    toast({ kind: found ? 'success' : 'warn', title: found ? `已找到 ${meta.cli}` : `没有找到 ${meta.cli}` })
  }

  return (
    <section ref={ref}>
      <div className="mb-2.5 flex items-baseline gap-2 px-1">
        <h2 className="text-[17px] font-semibold text-ink">{meta.name}</h2>
        <span className="text-[13px] text-ink-3">{meta.vendor}</span>
      </div>

      <div className={`card overflow-hidden transition-shadow duration-300 ${flash ? 'ring-4 ring-[#FF9F0A]/25' : ''}`}>
        {/* CLI row */}
        <div className="flex min-h-[64px] items-center gap-3.5 px-5 py-3">
          <KindAvatar kind={kind} size={36} />
          <div className="min-w-0 flex-1">
            <div className="text-[14px] leading-5 font-medium text-ink">{meta.cli}</div>
            <div className="truncate text-[13px] leading-5 text-ink-2" title={ks?.binaryPath ?? ks?.installCommand}>
              {installing ? (installed ? '正在更新…' : '正在安装，通常需要 1–2 分钟…') : installed ? (version ? `版本 ${version}` : '已安装') : '尚未安装到这台 Mac'}
            </div>
          </div>
          {installing ? (
            <>
              <button className={btnGhost} onClick={() => openDrawer(installSessionId(kind))}>
                查看进度
              </button>
              <span className="flex h-8 items-center gap-2 rounded-lg bg-[#E8F1FF] px-3.5 text-[13px] font-medium text-[#0A5FCC]">
                <Spinner size={14} /> 安装中
              </span>
            </>
          ) : installed ? (
            <>
              <Pill meta={{ label: '已安装', ...TONE.green }} />
              <button className={btnGhost + ' w-8 px-0'} onClick={() => void recheck()} disabled={checking} title="重新检测">
                {checking ? <Spinner size={14} /> : <IconRefresh size={15} />}
              </button>
              <button className={btnRow} onClick={() => void install(kind, true)} title={ks?.updateCommand || ks?.installCommand}>
                更新
              </button>
            </>
          ) : (
            <>
              <button className={btnGhost + ' w-8 px-0'} onClick={() => void recheck()} disabled={checking} title="已经手动安装过？重新检测">
                {checking ? <Spinner size={14} /> : <IconRefresh size={15} />}
              </button>
              <button className={btnRowPrimary} onClick={() => void install(kind)} title={ks?.installCommand}>
                <IconDownload size={14} /> 一键安装
              </button>
            </>
          )}
          <button className={btnGhost + ' w-8 px-0'} onClick={() => openCliConfig(kind)} title="命令行工具设置">
            <IconGear size={18} strokeWidth={1.6} />
          </button>
        </div>

        {/* accounts (inset dividers, System Settings style) */}
        {accounts.length === 0 ? (
          <div className="relative flex min-h-[64px] items-center px-5 py-3">
            <div className="absolute top-0 right-0 left-[70px] h-px bg-hairline" />
            <div className="w-9" />
            <div className="ml-3.5 text-[14px] text-ink-2">还没有 {meta.name} 账号</div>
          </div>
        ) : (
          accounts.map((a) => <AccountRow key={a.id} account={a} cliReady={installed && !installing} />)
        )}

        {/* add */}
        <button
          onClick={() => openAddAccount(kind)}
          className="relative flex h-12 w-full items-center gap-3.5 px-5 text-left text-[14px] font-medium text-accent transition-colors hover:bg-black/[0.02] active:bg-black/[0.04]"
        >
          <div className="absolute top-0 right-0 left-[70px] h-px bg-hairline" />
          <span className="flex w-9 justify-center">
            <span className="flex h-6 w-6 items-center justify-center rounded-full bg-accent/10 text-[17px] leading-none">+</span>
          </span>
          添加账号
        </button>
      </div>
    </section>
  )
}

function AccountRow({ account: a, cliReady }: { account: ProfileState; cliReady: boolean }) {
  const { openLogin, openConfig, removeAccount, toast } = useApp()
  const flash = useFlash((t) => t === a.id)
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState(a.name)
  const needsLogin = a.status === 'not_logged_in'
  useEffect(() => setName(a.name), [a.name])

  const commitRename = async () => {
    setEditing(false)
    const n = name.trim()
    if (!n || n === a.name) return setName(a.name)
    await window.agentmux.profiles.update(a.id, { name: n })
    toast({ kind: 'success', title: `已重命名为「${n}」` })
  }

  return (
    <div className={`relative flex min-h-[64px] items-center gap-3.5 py-2.5 pr-4 pl-5 transition-colors duration-300 ${flash ? 'bg-[#FFF8EB]' : ''}`}>
      <div className="absolute top-0 right-0 left-[70px] h-px bg-hairline" />
      <div className="flex w-9 justify-center">
        <div
          className="flex h-8 w-8 items-center justify-center rounded-full text-[14px] font-semibold text-white"
          style={{ background: KIND_META[a.kind].color + 'CC' }}
        >
          {[...a.name.trim()][0]?.toUpperCase() ?? '?'}
        </div>
      </div>
      <div className="min-w-0 flex-1">
        {editing ? (
          <input
            autoFocus
            className="h-7 w-full max-w-[260px] rounded-md bg-white px-2 text-[14px] font-medium text-ink ring-2 ring-accent/40 outline-none select-text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={() => void commitRename()}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void commitRename()
              if (e.key === 'Escape') {
                setName(a.name)
                setEditing(false)
              }
            }}
          />
        ) : (
          <div className="truncate text-[14px] leading-5 font-medium text-ink" onDoubleClick={() => setEditing(true)} title="双击重命名">
            {a.name}
          </div>
        )}
        <div className="truncate text-[13px] leading-5 text-ink-3" title={a.resolvedConfigDir}>
          {a.imported ? `本机已有配置 · ${a.configDir}` : '独立配置目录'}
        </div>
      </div>
      <StatusBadge profile={a} />
      <button
        className={`${needsLogin ? btnRowPrimary : btnRow} w-[88px]`}
        disabled={!cliReady || a.sessionMode === 'login'}
        onClick={() => openLogin(a.id)}
        title={cliReady ? undefined : '请先安装命令行工具'}
      >
        {a.loggedIn ? '重新登录' : '登录'}
      </button>
      <RowMenu
        items={[
          { label: '重命名', run: () => setEditing(true) },
          { label: '账号设置…', run: () => openConfig(a.id) },
          { label: '删除账号…', run: () => void removeAccount(a.id), destructive: true }
        ]}
      />
    </div>
  )
}

function RowMenu({ items }: { items: { label: string; run: () => void; destructive?: boolean }[] }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false)
    window.addEventListener('mousedown', close)
    return () => window.removeEventListener('mousedown', close)
  }, [open])
  return (
    <div ref={ref} className="relative">
      <button className={btnGhost + ` w-8 px-0 ${open ? 'bg-black/[0.05] text-ink' : ''}`} onClick={() => setOpen((o) => !o)} title="更多">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
          <circle cx="5.5" cy="12" r="1.6" />
          <circle cx="12" cy="12" r="1.6" />
          <circle cx="18.5" cy="12" r="1.6" />
        </svg>
      </button>
      {open && (
        <div className="absolute top-9 right-0 z-20 w-44 rounded-xl bg-white/95 p-1.5 shadow-[0_0_0_1px_rgba(0,0,0,0.07),0_12px_32px_rgba(0,0,0,0.16)] backdrop-blur-xl">
          {items.map((it, i) => (
            <div key={it.label}>
              {it.destructive && i > 0 && <div className="mx-2 my-1 h-px bg-hairline" />}
              <button
                className={`flex h-8 w-full items-center rounded-md px-2.5 text-left text-[14px] ${
                  it.destructive ? 'text-[#D70015] hover:bg-[#FDECEC]' : 'text-ink hover:bg-accent hover:text-white'
                }`}
                onClick={() => {
                  setOpen(false)
                  it.run()
                }}
              >
                {it.label}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
