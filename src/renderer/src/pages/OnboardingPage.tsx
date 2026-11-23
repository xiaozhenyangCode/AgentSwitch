import { useEffect, useState } from 'react'
import { KINDS, type ProfileKind, type ProfileState } from '@shared/types'
import { useApp } from '../state/AppContext'
import { KIND_META, isReady } from '../lib/ui'
import { BrandMark, KindAvatar, ProfileAvatar } from '../components/common'
import { IconCheck, IconCopy, IconDownload, Spinner } from '../components/icons'
import { finishOnboarding } from '../state/onboarding'
import { t } from '../state/i18n'

/**
 * First-run guide (also re-opened from Settings → General).
 * Step 1 detects installed CLIs and imported accounts; with a ready account the user can start
 * right away. Step 2 installs and signs in, one card per engine.
 */

const CARD = 'rounded-2xl bg-surface shadow-[0_0_0_1px_var(--ring),0_1px_2px_rgba(0,0,0,0.04)]'
const btnPrimary =
  'inline-flex h-9 items-center justify-center gap-1.5 rounded-[10px] bg-accent px-5 text-[13.5px] font-medium text-white shadow-[0_1px_2px_rgba(0,122,255,0.3)] transition-all hover:bg-accent-hover active:scale-[0.98] disabled:pointer-events-none disabled:bg-black/[0.08] disabled:text-ink-3 disabled:shadow-none'
const btnQuiet = 'inline-flex h-9 items-center rounded-[10px] px-3 text-[13px] font-medium text-ink-2 transition-colors hover:bg-black/[0.05] hover:text-ink'
const btnSmall = 'inline-flex h-7 shrink-0 items-center justify-center gap-1.5 rounded-lg px-3 text-[12.5px] font-medium transition-colors disabled:pointer-events-none disabled:opacity-50'

/** Folder each CLI uses by default: the first account created here shares it with the terminal. */
const DEFAULT_DIR: Record<ProfileKind, string> = { claude: '~/.claude', codex: '~/.codex', gemini: '~' }

type Stage = 'uninstalled' | 'installed' | 'ready'

function useVersions(): Partial<Record<ProfileKind, string | null>> {
  const { kinds } = useApp()
  const [v, setV] = useState<Partial<Record<ProfileKind, string | null>>>({})
  const key = kinds.map((k) => `${k.kind}:${k.binaryPath ?? ''}`).join('|')
  useEffect(() => {
    let live = true
    for (const k of kinds) if (k.binaryPath) void window.agentswitch.cli.version(k.kind).then((ver) => live && setV((x) => ({ ...x, [k.kind]: ver })))
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
  return v
}

export function OnboardingPage() {
  const { profiles, loaded } = useApp()
  const ready = profiles.filter(isReady)
  const [step, setStep] = useState<1 | 2>(1)

  return (
    <div className="flex h-full w-full flex-col bg-canvas">
      <div className="drag h-12 shrink-0" />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-[620px] flex-col items-center px-8 pt-6 pb-10">
          <BrandMark size={56} />
          <h1 className="mt-5 text-[26px] leading-tight font-semibold tracking-tight text-ink">{t('ob.title')}</h1>
          <p className="mt-2 text-center text-[13.5px] leading-relaxed text-ink-3">{step === 1 ? t('ob.subtitle') : t('ob.step2Desc')}</p>
          <div className="mt-5 flex items-center gap-2 text-[12px] text-ink-3">
            <span className={step === 1 ? 'font-medium text-ink' : ''}>1 · {t('ob.step1')}</span>
            <span className="h-px w-6 bg-hairline" />
            <span className={step === 2 ? 'font-medium text-ink' : ''}>2 · {t('ob.step2')}</span>
          </div>
          <div className="mt-7 w-full">{!loaded ? <Detecting /> : step === 1 ? <Detect ready={ready} onNext={() => setStep(2)} /> : <Engines />}</div>
        </div>
      </div>
      {loaded && step === 2 && (
        <div className="shrink-0 border-t border-hairline px-8 py-4">
          <div className="mx-auto flex max-w-[620px] items-center gap-3">
            <button className={btnQuiet} onClick={() => setStep(1)}>
              {t('ob.back')}
            </button>
            <div className="flex-1" />
            <button className={btnQuiet} onClick={() => void finishOnboarding()}>
              {t('ob.later')}
            </button>
            <button className={btnPrimary} disabled={!ready.length} onClick={() => void finishOnboarding()} title={ready.length ? '' : t('ob.needOne')}>
              {t('ob.finish')}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

function Detecting() {
  return (
    <div className={CARD + ' flex items-center justify-center gap-2 py-10 text-[13px] text-ink-3'}>
      <Spinner size={14} /> {t('ob.detecting')}
    </div>
  )
}

function stageOf(kind: ProfileKind, installed: boolean, accounts: ProfileState[]): Stage {
  if (accounts.some((p) => p.kind === kind && isReady(p))) return 'ready'
  return installed ? 'installed' : 'uninstalled'
}

function StageTag({ stage }: { stage: Stage }) {
  const cls = stage === 'ready' ? 'bg-ok-soft text-ok' : stage === 'installed' ? 'bg-warn-soft text-warn' : 'bg-black/[0.05] text-ink-3'
  return <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11.5px] font-medium ${cls}`}>{t(`ob.stage.${stage}`)}</span>
}

/** Step 1: what is on this Mac. Existing users get a summary and a one-click start. */
function Detect({ ready, onNext }: { ready: ProfileState[]; onNext: () => void }) {
  const { kinds, profiles } = useApp()
  const versions = useVersions()
  return (
    <div className="space-y-4">
      <div className={CARD + ' divide-y divide-hairline'}>
        {KINDS.map((k) => {
          const ks = kinds.find((x) => x.kind === k)
          const stage = stageOf(k, !!ks?.binaryPath, profiles)
          return (
            <div key={k} className="flex items-center gap-3 px-4 py-3">
              <KindAvatar kind={k} size={28} />
              <div className="min-w-0 flex-1">
                <div className="text-[14px] font-medium text-ink">{KIND_META[k].cli}</div>
                <div className="truncate text-[12px] text-ink-3">
                  {ks?.binaryPath ? t('ob.foundAt', { v: versions[k] ? `v${String(versions[k]).replace(/^v/, '')}` : '' }) : t('ob.notFound', { bin: ks?.binary ?? k })}
                </div>
              </div>
              <StageTag stage={stage} />
            </div>
          )
        })}
      </div>

      {ready.length > 0 ? (
        <>
          <div className={CARD + ' px-4 py-3.5'}>
            <div className="text-[13px] font-medium text-ink">{t('ob.imported', { n: ready.length })}</div>
            <div className="mt-2 space-y-1.5">
              {ready.map((p) => (
                <div key={p.id} className="flex items-center gap-2.5 text-[13px]">
                  <ProfileAvatar profile={p} size={20} />
                  <span className="min-w-0 truncate text-ink">{p.name}</span>
                  <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-ink-3">{p.configDir}</span>
                  <IconCheck size={14} className="shrink-0 text-ok" />
                </div>
              ))}
            </div>
          </div>
          <div className="flex items-center justify-center gap-2 pt-2">
            <button className={btnQuiet} onClick={onNext}>
              {t('ob.manage')}
            </button>
            <button className={btnPrimary} onClick={() => void finishOnboarding()}>
              {t('ob.start')}
            </button>
          </div>
        </>
      ) : (
        <div className="flex items-center justify-center gap-2 pt-2">
          <button className={btnQuiet} onClick={() => void finishOnboarding()}>
            {t('ob.later')}
          </button>
          <button className={btnPrimary} onClick={onNext}>
            {t('ob.next')}
          </button>
        </div>
      )}
    </div>
  )
}

/** Step 2: one card per engine with install / sign-in. */
function Engines() {
  return (
    <div className="space-y-3">
      {KINDS.map((k) => (
        <EngineCard key={k} kind={k} />
      ))}
      <p className="pt-1 text-center text-[12px] leading-relaxed text-ink-3">{t('ob.oneIsEnough')}</p>
    </div>
  )
}

function EngineCard({ kind }: { kind: ProfileKind }) {
  const { kinds, profiles, install, openLogin, loginId, refresh, info, toast } = useApp()
  const ks = kinds.find((x) => x.kind === kind)
  const accounts = profiles.filter((p) => p.kind === kind)
  const stage = stageOf(kind, !!ks?.binaryPath, profiles)
  const installing = !!ks?.installing
  const [failed, setFailed] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [busy, setBusy] = useState(false)
  const loggingIn = accounts.some((p) => p.id === loginId)
  const cmd = ks?.installCommand ?? ''

  const doInstall = async () => {
    setFailed(null)
    const r = await install(kind)
    if (!r.ok && !r.cancelled) setFailed(r.error ?? t('ob.installFailed'))
  }

  /** Signs in the first account of this kind that is not ready, creating one if needed. */
  const doLogin = async () => {
    setBusy(true)
    try {
      let target = accounts.find((p) => !isReady(p) && !p.apiKey) // API-key accounts never use the OAuth sheet
      if (!target) {
        const id = await window.agentswitch.profiles.add(kind)
        const home = info?.realHome ?? ''
        const def = DEFAULT_DIR[kind]
        const defAbs = def === '~' ? home : `${home}/${def.slice(2)}`
        const taken = profiles.some((p) => p.kind === kind && (p.configDir === def || p.resolvedConfigDir === defAbs))
        if (!taken) await window.agentswitch.profiles.update(id, { configDir: def })
        const s = await refresh()
        target = s.profiles.find((p) => p.id === id)
      }
      if (target) openLogin(target.id)
    } catch (e) {
      toast({ kind: 'error', title: t('add.failed'), desc: String(e) })
    } finally {
      setBusy(false)
    }
  }

  const copy = async () => {
    await window.agentswitch.sys.copy(cmd)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <div className={CARD + ' px-4 py-3.5'}>
      <div className="flex items-center gap-3">
        <KindAvatar kind={kind} size={32} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-[14.5px] font-medium text-ink">{KIND_META[kind].cli}</span>
            <StageTag stage={stage} />
          </div>
          <div className="mt-0.5 truncate text-[12px] text-ink-3">
            {stage === 'ready'
              ? accounts
                  .filter(isReady)
                  .map((p) => p.name)
                  .join(t('common.listSep'))
              : t(`ob.desc.${kind}`)}
          </div>
        </div>
        {stage === 'uninstalled' &&
          (installing ? (
            <span className="flex shrink-0 items-center gap-1.5 text-[12.5px] text-ink-3">
              <Spinner size={12} /> {t('ob.installing')}
            </span>
          ) : (
            <button className={btnSmall + ' bg-accent text-white hover:bg-accent-hover'} onClick={() => void doInstall()}>
              <IconDownload size={13} /> {t('eng.install')}
            </button>
          ))}
        {stage === 'installed' && (
          <button className={btnSmall + ' bg-accent text-white hover:bg-accent-hover'} disabled={busy || loggingIn} onClick={() => void doLogin()}>
            {busy || loggingIn ? <Spinner size={12} /> : null} {t('eng.login')}
          </button>
        )}
        {stage === 'ready' && <IconCheck size={18} className="shrink-0 text-ok" />}
      </div>
      {failed && stage === 'uninstalled' && !installing && (
        <div className="mt-3 rounded-xl bg-danger-soft/60 px-3 py-2.5">
          <div className="text-[12.5px] leading-relaxed text-danger">{failed}</div>
          <div className="mt-1.5 text-[12px] text-ink-3">{t('ob.manualHint')}</div>
          <div className="mt-1.5 flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded-md bg-fill px-2 py-1 font-mono text-[11.5px] text-ink" title={cmd}>
              {cmd}
            </code>
            <button className={btnSmall + ' text-ink-2 hover:bg-black/[0.05]'} onClick={() => void copy()}>
              {copied ? <IconCheck size={12} className="text-ok" /> : <IconCopy size={12} />} {copied ? t('common.copied') : t('common.copy')}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
