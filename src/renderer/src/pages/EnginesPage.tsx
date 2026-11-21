import { useEffect, useRef, useState } from 'react'
import { KINDS, installSessionId, type ProfileKind, type ProfileState } from '@shared/types'
import { useApp } from '../state/AppContext'
import { KIND_META } from '../lib/ui'
import { KindAvatar, Segmented } from '../components/common'
import { IconDownload, IconGear, Spinner } from '../components/icons'
import { AccountQuotaCells, QuotaGroupChip, RefreshUsage, UsageView, todayBrief } from '../components/Usage'
import { fmtTokens, setEnginesTab, tokenSum, useEnginesTab, useUsage } from '../state/usage'

/** macOS card material: white, hairline border, barely-there shadow. */
const CARD = 'rounded-xl border border-black/[0.07] bg-white shadow-[0_1px_2px_rgba(0,0,0,0.03)]'
const btnSolid =
  'inline-flex h-7 items-center justify-center gap-1.5 rounded-lg bg-accent px-3 text-[12.5px] font-medium text-white transition-colors hover:bg-accent-hover disabled:pointer-events-none disabled:opacity-40'
const btnText =
  'inline-flex h-7 items-center rounded-lg px-2.5 text-[12.5px] font-medium text-ink-2 transition-colors hover:bg-black/[0.05] hover:text-ink disabled:pointer-events-none disabled:opacity-40'
const btnIcon =
  'inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-ink-3 transition-colors hover:bg-black/[0.05] hover:text-ink active:bg-black/[0.08] disabled:pointer-events-none disabled:opacity-40'

/** One grid for every account row on the page: identity | 5h | 7d | menu — columns line up across cards. */
const ROW_GRID = 'grid grid-cols-[minmax(0,1fr)_11rem_11rem_2rem] items-center gap-x-6'

const DOT_COLOR: Record<ProfileState['status'], string> = {
  idle: '#30B158',
  running: '#0A84FF',
  not_logged_in: '#F5A524',
  rate_limited: '#F0524F',
  uninstalled: '#A1A1A6'
}
/** Tag shown only when something needs attention (healthy rows just get the dot). */
const ALERT: Partial<Record<ProfileState['status'] | 'login', { label: string; cls: string }>> = {
  login: { label: '登录中', cls: 'bg-[#0A84FF]/10 text-[#0A6AD6]' },
  not_logged_in: { label: '未登录', cls: 'bg-[#F5A524]/12 text-[#9A5B00]' },
  rate_limited: { label: '限流', cls: 'bg-[#F0524F]/10 text-[#C9302C]' },
  uninstalled: { label: '未安装', cls: 'bg-black/[0.05] text-ink-3' }
}

export function EnginesPage() {
  const { profiles, loaded } = useApp()
  const tab = useEnginesTab()
  return (
    <div className="h-full overflow-y-auto">
      <div className="drag h-14" />
      <div className="mx-auto max-w-4xl px-10 pb-16">
        <div className="flex items-center gap-4">
          <h1 className="text-[26px] leading-tight font-semibold tracking-tight text-ink">模型引擎</h1>
          <div className="no-drag flex-1">
            <Segmented
              value={tab}
              onChange={setEnginesTab}
              options={[
                { value: 'accounts', label: '引擎与账号' },
                { value: 'usage', label: '用量统计' }
              ]}
            />
          </div>
          <div className="no-drag">
            <RefreshUsage />
          </div>
        </div>
        <p className="mt-2 text-[13px] leading-relaxed text-ink-3">
          {tab === 'accounts' ? '安装命令行工具并添加账号。每个账号的登录信息相互独立，可以同时使用多个账号。' : '各账号的 Token 用量与额度窗口，随每次对话自动更新。'}
        </p>
        {loaded && (
          <div className="mt-7">
            {tab === 'accounts' ? (
              <div className="space-y-5">
                {KINDS.map((k) => (
                  <EngineGroup key={k} kind={k} accounts={profiles.filter((p) => p.kind === k)} />
                ))}
              </div>
            ) : (
              <UsageView />
            )}
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
    void window.agentswitch.cli.version(kind).then(setVersion)
  }, [kind, binPath])

  const recheck = async () => {
    setChecking(true)
    const s = await refresh()
    setChecking(false)
    const found = !!s.kinds.find((k) => k.kind === kind)?.binaryPath
    toast({
      kind: found ? 'success' : 'warn',
      title: found ? `已找到 ${meta.cli}` : `没有找到 ${meta.cli}`
    })
  }

  return (
    <section ref={ref} className={`${CARD} transition-shadow duration-300 ${flash ? 'ring-4 ring-[#FF9F0A]/25' : ''}`}>
      {/* CLI title bar */}
      <div className="flex h-[52px] items-center gap-3 rounded-t-xl border-b border-black/[0.06] bg-neutral-50/80 pr-3 pl-4">
        <KindAvatar kind={kind} size={26} />
        <div className="flex min-w-0 flex-1 items-baseline gap-2">
          <span className="shrink-0 text-[14px] font-semibold text-ink">{meta.cli}</span>
          {installing ? (
            <span className="truncate text-[12px] text-ink-3">{installed ? '正在更新…' : '正在安装，通常需要 1–2 分钟…'}</span>
          ) : installed ? (
            version && (
              <span className="text-[12px] text-ink-3 tabular-nums" title={ks?.binaryPath ?? undefined}>
                v{version.replace(/^v/, '')}
              </span>
            )
          ) : (
            <span className="text-[12px] text-ink-3">尚未安装</span>
          )}
        </div>
        {installing ? (
          <>
            <button className={btnText} onClick={() => openDrawer(installSessionId(kind))}>
              查看进度
            </button>
            <span className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-lg bg-accent/10 px-2.5 text-[12.5px] font-medium text-accent">
              <Spinner size={12} /> 安装中
            </span>
          </>
        ) : installed ? (
          <button className={btnText} onClick={() => void install(kind, true)} title={ks?.updateCommand || ks?.installCommand}>
            检查更新
          </button>
        ) : (
          <>
            <button className={btnText} onClick={() => void recheck()} disabled={checking} title="已经手动安装过？重新检测">
              {checking ? <Spinner size={12} /> : '重新检测'}
            </button>
            <button className={btnSolid} onClick={() => void install(kind)} title={ks?.installCommand}>
              <IconDownload size={13} /> 一键安装
            </button>
          </>
        )}
        <button className={btnIcon} onClick={() => openCliConfig(kind)} title="命令行工具设置">
          <IconGear size={16} strokeWidth={1.6} />
        </button>
      </div>

      {accounts.length === 0 ? (
        <div className="px-4 py-5 text-[13px] text-ink-3">还没有 {meta.name} 账号</div>
      ) : (
        <div className="divide-y divide-black/[0.05]">
          {accounts.map((a) => (
            <AccountRow key={a.id} account={a} cliReady={installed && !installing} />
          ))}
        </div>
      )}

      <button
        onClick={() => openAddAccount(kind)}
        className="flex h-10 w-full items-center gap-2 rounded-b-xl border-t border-black/[0.05] px-4 text-left text-[12.5px] font-medium text-ink-3 transition-colors hover:bg-black/[0.02] hover:text-accent active:bg-black/[0.04]"
      >
        <span className="text-[15px] leading-none">+</span>
        添加 {meta.name} 账号
      </button>
    </section>
  )
}

function AccountRow({ account: a, cliReady }: { account: ProfileState; cliReady: boolean }) {
  const { openLogin, openConfig, removeAccount, toast } = useApp()
  const flash = useFlash((t) => t === a.id)
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState(a.name)
  const usage = useUsage()?.accounts[a.id]
  useEffect(() => setName(a.name), [a.name])
  const loggingIn = a.sessionMode === 'login'
  const alert = ALERT[loggingIn ? 'login' : a.status]
  const where = a.imported ? `本机已有配置 · ${a.resolvedConfigDir}` : `独立配置目录 · ${a.resolvedConfigDir}`

  const commitRename = async () => {
    setEditing(false)
    const n = name.trim()
    if (!n || n === a.name) return setName(a.name)
    await window.agentswitch.profiles.update(a.id, { name: n })
    toast({ kind: 'success', title: `已重命名为「${n}」` })
  }

  return (
    <div className={`${ROW_GRID} min-h-[64px] px-4 py-3 transition-colors duration-300 ${flash ? 'bg-[#FFF8EB]' : ''}`}>
      {/* identity + today */}
      <div className="min-w-0">
        <div className="flex min-w-0 items-center gap-2">
          <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: loggingIn ? DOT_COLOR.running : DOT_COLOR[a.status] }} />
          {editing ? (
            <input
              autoFocus
              className="h-7 w-full max-w-[240px] rounded-md bg-white px-2 text-[14px] font-semibold text-ink ring-2 ring-accent/40 outline-none select-text"
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
            <span className="truncate text-[14px] font-semibold text-ink" onDoubleClick={() => setEditing(true)} title={`${where}\n双击重命名`}>
              {a.name}
            </span>
          )}
          {alert && <span className={`shrink-0 rounded-md px-1.5 py-px text-[11px] font-medium ${alert.cls}`}>{alert.label}</span>}
          {a.loggedIn && <QuotaGroupChip u={usage} model={a.defaultModel} />}
        </div>
        <div className="mt-0.5 pl-3.5 text-[12px] text-ink-3 tabular-nums" title={usage ? `本周 ${fmtTokens(tokenSum(usage.week))} · 累计 ${fmtTokens(tokenSum(usage.total))}` : undefined}>
          {a.loggedIn ? todayBrief(usage) : '登录后即可使用'}
        </div>
      </div>

      {/* 5h | 7d, or the login call to action */}
      {a.loggedIn ? (
        <AccountQuotaCells kind={a.kind} u={usage} model={a.defaultModel} />
      ) : (
        <div className="col-span-2 flex justify-end">
          <button className={btnSolid} disabled={!cliReady || loggingIn} onClick={() => openLogin(a.id)} title={cliReady ? undefined : '请先安装命令行工具'}>
            {loggingIn ? '登录中…' : '登录'}
          </button>
        </div>
      )}

      <RowMenu
        items={[
          ...(a.loggedIn ? [{ label: '重新登录', run: () => openLogin(a.id), disabled: !cliReady || loggingIn }] : []),
          { label: '账号设置…', run: () => openConfig(a.id) },
          { label: '重命名', run: () => setEditing(true) },
          { label: '删除账号…', run: () => void removeAccount(a.id), destructive: true }
        ]}
      />
    </div>
  )
}

function RowMenu({ items }: { items: { label: string; run: () => void; destructive?: boolean; disabled?: boolean }[] }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false)
    window.addEventListener('mousedown', close)
    return () => window.removeEventListener('mousedown', close)
  }, [open])
  return (
    <div ref={ref} className="relative flex justify-end">
      <button className={btnIcon + ` ${open ? 'bg-black/[0.05] text-ink' : ''}`} onClick={() => setOpen((o) => !o)} title="更多">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
          <circle cx="5.5" cy="12" r="1.6" />
          <circle cx="12" cy="12" r="1.6" />
          <circle cx="18.5" cy="12" r="1.6" />
        </svg>
      </button>
      {open && (
        <div className="absolute top-9 right-0 z-20 w-44 rounded-xl border border-black/[0.07] bg-white/95 p-1.5 shadow-[0_12px_32px_rgba(0,0,0,0.14)] backdrop-blur-xl">
          {items.map((it, i) => (
            <div key={it.label}>
              {it.destructive && i > 0 && <div className="mx-2 my-1 h-px bg-hairline" />}
              <button
                disabled={it.disabled}
                className={`flex h-8 w-full items-center rounded-md px-2.5 text-left text-[13px] disabled:opacity-40 ${it.destructive ? 'text-[#D70015] hover:bg-[#FDECEC]' : 'text-ink enabled:hover:bg-accent enabled:hover:text-white'}`}
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
