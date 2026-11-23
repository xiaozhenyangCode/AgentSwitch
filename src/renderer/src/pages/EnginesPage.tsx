import { useEffect, useRef, useState } from 'react'
import { KINDS, installSessionId, type ProfileKind, type ProfileState } from '@shared/types'
import { useApp } from '../state/AppContext'
import { KIND_META } from '../lib/ui'
import { KindAvatar } from '../components/common'
import { ChangeKeyModal } from '../components/dialogs'
import { IconDownload, IconGear, IconSliders, Spinner } from '../components/icons'
import { tildePath } from '../components/ProjectBar'
import { modelLabel } from '../lib/models'
import { useModelsVersion } from '../state/models'
import { dims, terminals } from '../lib/terminals'
import { t } from '../state/i18n'
import { DialogHeader } from '../components/PageDialog'

/** macOS card material: white, hairline border, barely-there shadow. */
const CARD = 'rounded-xl border border-black/[0.07] bg-surface shadow-[0_1px_2px_rgba(0,0,0,0.03)]'
const btnSolid =
  'inline-flex h-7 items-center justify-center gap-1.5 rounded-lg bg-accent px-3 text-[12.5px] font-medium text-white transition-colors hover:bg-accent-hover disabled:pointer-events-none disabled:opacity-40'
const btnText =
  'inline-flex h-7 items-center rounded-lg px-2.5 text-[12.5px] font-medium text-ink-2 transition-colors hover:bg-black/[0.05] hover:text-ink disabled:pointer-events-none disabled:opacity-40'
const btnIcon =
  'inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-ink-3 transition-colors hover:bg-black/[0.05] hover:text-ink active:bg-black/[0.08] disabled:pointer-events-none disabled:opacity-40'

/** One grid for every account row on the page: identity | model | permissions | actions — columns line up across cards. */
const ROW_GRID = 'grid grid-cols-[minmax(0,1fr)_10rem_7.5rem_5.5rem] items-center gap-x-3'

/** Small read-only meta pill (click opens the account settings). */
const CHIP =
  'inline-flex h-6 max-w-full min-w-0 items-center gap-1 justify-self-start rounded-md bg-black/[0.045] px-2 text-[11.5px] font-medium text-ink-2 transition-colors hover:bg-black/[0.08] hover:text-ink dark:bg-white/[0.07] dark:hover:bg-white/[0.12]'

const PERM: Record<'cli' | 'edits' | 'full', { key: 'eng.permCli' | 'eng.permEdits' | 'eng.permFull'; cls: string }> = {
  cli: { key: 'eng.permCli', cls: '' },
  edits: { key: 'eng.permEdits', cls: '' },
  full: { key: 'eng.permFull', cls: '!bg-orange/12 !text-warn' }
}

const DOT_COLOR: Record<ProfileState['status'], string> = {
  idle: 'var(--green)',
  running: 'var(--accent)',
  not_logged_in: 'var(--orange)',
  rate_limited: 'var(--red)',
  uninstalled: 'var(--muted-dot)'
}
/** Tag shown only when something needs attention (healthy rows just get the dot). */
const alertOf = (s: ProfileState['status'] | 'login'): { label: string; cls: string } | undefined =>
  ({
    login: { label: t('status.loggingIn'), cls: 'bg-accent/10 text-info' },
    not_logged_in: { label: t('status.notLoggedIn'), cls: 'bg-orange/12 text-warn' },
    rate_limited: { label: t('status.rateLimited'), cls: 'bg-red/10 text-danger' },
    uninstalled: { label: t('status.uninstalled'), cls: 'bg-black/[0.05] text-ink-3' },
    running: { label: t('status.running'), cls: 'bg-accent/10 text-info' }
  })[s as 'login']

export function EnginesPage({ onClose }: { onClose: () => void }) {
  const { profiles, loaded } = useApp()
  return (
    <>
      <DialogHeader title={t('eng.title')} desc={t('eng.desc')} onClose={onClose} />
      <div className="min-h-0 flex-1 overflow-y-auto px-8 pt-6 pb-10">
        {loaded && (
          <div className="space-y-5">
            {KINDS.map((k) => (
              <EngineGroup key={k} kind={k} accounts={profiles.filter((p) => p.kind === k)} />
            ))}
          </div>
        )}
      </div>
    </>
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
      title: found ? t('eng.found', { cli: meta.cli }) : t('eng.notFound', { cli: meta.cli })
    })
  }

  return (
    <section ref={ref} className={`${CARD} transition-shadow duration-300 ${flash ? 'ring-4 ring-orange/25' : ''}`}>
      {/* CLI title bar */}
      <div className="flex h-[52px] items-center gap-3 rounded-t-xl border-b border-black/[0.06] bg-surface-2/80 pr-3 pl-4">
        <KindAvatar kind={kind} size={26} />
        <div className="flex min-w-0 flex-1 items-baseline gap-2">
          <span className="shrink-0 text-[14px] font-semibold text-ink">{meta.cli}</span>
          {installing ? (
            <span className="truncate text-[12px] text-ink-3">{installed ? t('eng.updating') : t('eng.installing')}</span>
          ) : installed ? (
            version && (
              <span className="text-[12px] text-ink-3 tabular-nums" title={ks?.binaryPath ?? undefined}>
                v{version.replace(/^v/, '')}
              </span>
            )
          ) : (
            <span className="text-[12px] text-ink-3">{t('eng.notInstalled')}</span>
          )}
        </div>
        {installing ? (
          <>
            <button className={btnText} onClick={() => openDrawer(installSessionId(kind))}>
              {t('eng.viewProgress')}
            </button>
            <span className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-lg bg-accent/10 px-2.5 text-[12.5px] font-medium text-accent">
              <Spinner size={12} /> {t('eng.installingBadge')}
            </span>
          </>
        ) : installed ? (
          <button className={btnText} onClick={() => void install(kind, true)} title={ks?.updateCommand || ks?.installCommand}>
            {t('eng.checkUpdate')}
          </button>
        ) : (
          <>
            <button className={btnText} onClick={() => void recheck()} disabled={checking} title={t('eng.recheckHint')}>
              {checking ? <Spinner size={12} /> : t('eng.recheck')}
            </button>
            <button className={btnSolid} onClick={() => void install(kind)} title={ks?.installCommand}>
              <IconDownload size={13} /> {t('eng.install')}
            </button>
          </>
        )}
        <button className={btnIcon} onClick={() => openCliConfig(kind)} title={t('eng.cliSettings')}>
          <IconGear size={16} strokeWidth={1.6} />
        </button>
      </div>

      {accounts.length === 0 ? (
        <div className="px-4 py-5 text-[13px] text-ink-3">{t('eng.noAccounts', { name: meta.name })}</div>
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
        {t('eng.addAccount', { name: meta.name })}
      </button>
    </section>
  )
}

function AccountRow({ account: a, cliReady }: { account: ProfileState; cliReady: boolean }) {
  const { openLogin, openConfig, openDrawer, removeAccount, toast } = useApp()
  useModelsVersion() // model labels resolve once the list is cached
  const flash = useFlash((t) => t === a.id)
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState(a.name)
  useEffect(() => setName(a.name), [a.name])
  const loggingIn = a.sessionMode === 'login'
  const alert = alertOf(loggingIn ? 'login' : a.status)
  const [changingKey, setChangingKey] = useState(false)
  const keyAcct = !!a.apiKey
  const host = (u?: string) => {
    try {
      return u ? new URL(u).host : ''
    } catch {
      return u ?? ''
    }
  }
  const where = keyAcct
    ? a.apiKey!.provider === 'deepseek'
      ? `DeepSeek · ${t('apikey.badge')}`
      : a.apiKey!.provider === 'custom'
        ? `${t('acct.customName', { n: '' }).trim()} · ${host(a.apiKey!.baseUrl)}`
        : t('apikey.badge')
    : (a.imported ? t('eng.whereImported', { dir: tildePath(a.resolvedConfigDir) }) : t('eng.whereOwn', { dir: tildePath(a.resolvedConfigDir) }))
  const perm = PERM[a.autoApprove === 'full' || a.autoApprove === 'edits' ? a.autoApprove : 'cli']

  const commitRename = async () => {
    setEditing(false)
    const n = name.trim()
    if (!n || n === a.name) return setName(a.name)
    await window.agentswitch.profiles.update(a.id, { name: n })
    toast({ kind: 'success', title: t('eng.renamed', { name: n }) })
  }

  /** The account's isolated shell in the debug drawer (reuses a live one). */
  const openTerminal = async () => {
    try {
      if (a.sessionMode !== 'shell') await window.agentswitch.pty.start({ profileId: a.id, mode: 'shell', ...dims(a.id) })
      openDrawer(a.id)
      requestAnimationFrame(() => terminals.get(a.id)?.focus())
    } catch (e) {
      toast({ kind: 'error', title: t('dbg.startFailed'), desc: String(e) })
    }
  }

  return (
    <div className={`${ROW_GRID} min-h-[60px] px-4 py-2.5 transition-colors duration-300 ${flash ? 'bg-warn-soft' : ''}`}>
      {/* identity: dot · name · status, then where its config lives */}
      <div className="min-w-0">
        <div className="flex min-w-0 items-center gap-2">
          <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: loggingIn ? DOT_COLOR.running : DOT_COLOR[a.status] }} />
          {editing ? (
            <input
              autoFocus
              className="h-7 w-full max-w-[240px] rounded-md bg-surface px-2 text-[14px] font-semibold text-ink ring-2 ring-accent/40 outline-none select-text"
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
            <span className="truncate text-[14px] font-semibold text-ink" onDoubleClick={() => setEditing(true)} title={t('eng.dblRename')}>
              {a.name}
            </span>
          )}
          {alert && <span className={`shrink-0 rounded-md px-1.5 py-px text-[11px] font-medium ${alert.cls}`}>{alert.label}</span>}
        </div>
        <div className="mt-0.5 truncate pl-3.5 text-[12px] text-ink-3" title={a.resolvedConfigDir}>
          {where}
        </div>
      </div>

      {/* core config: default model · permissions */}
      <button className={CHIP} onClick={() => openConfig(a.id)} title={t('eng.defaultModelHint')}>
        <span className="truncate">{modelLabel(a.defaultModel, a.id)}</span>
      </button>
      <button className={`${CHIP} ${perm.cls}`} onClick={() => openConfig(a.id)} title={t('eng.permHint')}>
        <span className="truncate">{t(perm.key)}</span>
      </button>

      {/* actions */}
      <div className="flex items-center justify-end gap-0.5">
        {keyAcct && !a.loggedIn ? (
          <button className={btnSolid} onClick={() => setChangingKey(true)}>
            {t('apikey.change')}
          </button>
        ) : a.loggedIn ? (
          <button className={btnIcon} onClick={() => openConfig(a.id)} title={t('eng.accountSettings')}>
            <IconSliders size={15} />
          </button>
        ) : (
          <button className={btnSolid} disabled={!cliReady || loggingIn} onClick={() => openLogin(a.id)} title={cliReady ? undefined : t('eng.installFirst')}>
            {loggingIn ? t('eng.loggingIn') : t('eng.login')}
          </button>
        )}
        <RowMenu
          items={[
            ...(keyAcct
              ? [{ label: t('apikey.change'), run: () => setChangingKey(true) }]
              : a.loggedIn
                ? [{ label: t('eng.relogin'), run: () => openLogin(a.id), disabled: !cliReady || loggingIn }]
                : []),
            ...(a.loggedIn ? [] : [{ label: t('eng.accountSettings'), run: () => openConfig(a.id) }]),
            { label: t('eng.openTerminal'), run: () => void openTerminal() },
            { label: t('common.rename'), run: () => setEditing(true) },
            { label: t('eng.deleteAccount'), run: () => void removeAccount(a.id), destructive: true }
          ]}
        />
      </div>
      {changingKey && <ChangeKeyModal profile={a} onClose={() => setChangingKey(false)} />}
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
      <button className={btnIcon + ` ${open ? 'bg-black/[0.05] text-ink' : ''}`} onClick={() => setOpen((o) => !o)} title={t('common.more')}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
          <circle cx="5.5" cy="12" r="1.6" />
          <circle cx="12" cy="12" r="1.6" />
          <circle cx="18.5" cy="12" r="1.6" />
        </svg>
      </button>
      {open && (
        <div className="absolute top-9 right-0 z-20 w-44 rounded-xl border border-black/[0.07] bg-surface/95 p-1.5 shadow-[0_12px_32px_rgba(0,0,0,0.14)] backdrop-blur-xl">
          {items.map((it, i) => (
            <div key={it.label}>
              {it.destructive && i > 0 && <div className="mx-2 my-1 h-px bg-hairline" />}
              <button
                disabled={it.disabled}
                className={`flex h-8 w-full items-center rounded-md px-2.5 text-left text-[13px] disabled:opacity-40 ${it.destructive ? 'text-danger hover:bg-danger-soft' : 'text-ink enabled:hover:bg-accent enabled:hover:text-white'}`}
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
