import { useEffect, useRef, useState } from 'react'
import type { ProfileId, PtyUrlEvent } from '@shared/types'
import { useApp } from '../state/AppContext'
import { useLayer } from '../lib/escStack'
import { dims } from '../lib/terminals'
import { btnPrimary, btnSecondary, inputCls } from '../lib/ui'
import { KindAvatar, Modal } from './common'
import { useDrawerLayout } from './DebugDrawer'
import { IconCheck, IconChevronDown, IconCopy, IconExternal, IconTerminal, IconX, Spinner } from './icons'
import { t, tNode } from '../state/i18n'

type Phase = 'starting' | 'waiting' | 'url' | 'exited' | 'success'

/** Seconds without a URL before we suggest the CLI may be waiting for input. */
const HINT_AFTER = 6

const KEYS: { label: string; seq: string }[] = [
  { label: '↑', seq: '\x1b[A' },
  { label: '↓', seq: '\x1b[B' },
  { label: 'enter', seq: '\r' },
  { label: 'Esc', seq: '\x1b' }
]

export function LoginModal({ profileId }: { profileId: ProfileId }) {
  const { byId, closeLogin, toast, drawer, openDrawer, refresh } = useApp()
  const { height: drawerHeight } = useDrawerLayout()
  const profile = byId(profileId)
  const [phase, setPhase] = useState<Phase>('starting')
  const [urls, setUrls] = useState<PtyUrlEvent[]>([])
  const [exitCode, setExitCode] = useState<number | null>(null)
  const [elapsed, setElapsed] = useState(0)
  const [copied, setCopied] = useState(false)
  const [code, setCode] = useState('')
  const [showInput, setShowInput] = useState(false)
  const phaseRef = useRef<Phase>(phase)
  phaseRef.current = phase
  const started = useRef(false)

  const start = async () => {
    setPhase('starting')
    setUrls([])
    setExitCode(null)
    setElapsed(0)
    try {
      await window.agentswitch.pty.start({ profileId, mode: 'login', ...dims(profileId) })
      setPhase((current) => (current === 'starting' ? 'waiting' : current))
    } catch (e) {
      toast({ kind: 'error', title: t('login.startFailed'), desc: String(e) })
      setPhase('exited')
    }
  }

  useEffect(() => {
    const offUrl = window.agentswitch.pty.onUrl((e) => {
      if (e.sessionId !== profileId) return
      setUrls((prev) => (prev.some((u) => u.url === e.url) ? prev : [...prev, e]))
      setPhase((p) => (p === 'waiting' || p === 'starting' ? 'url' : p))
    })
    const offOk = window.agentswitch.profiles.onLoginSuccess((e) => {
      if (e.profileId === profileId) setPhase('success')
    })
    const offExit = window.agentswitch.pty.onExit((e) => {
      if (e.sessionId !== profileId || e.mode !== 'login') return
      setExitCode(e.exitCode)
      // the success event may still be in flight (or the CLI exited right after writing creds)
      setTimeout(() => {
        if (phaseRef.current === 'success') return
        void refresh()
        setPhase('exited')
      }, 1800)
    })
    if (!started.current) {
      started.current = true
      void start()
    }
    return () => {
      offUrl()
      offOk()
      offExit()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profileId])

  useEffect(() => {
    if (phase !== 'waiting') return
    const t = setInterval(() => setElapsed((s) => s + 1), 1000)
    return () => clearInterval(t)
  }, [phase])

  useEffect(() => {
    if (phase === 'waiting' && elapsed >= HINT_AFTER) setShowInput(true)
  }, [phase, elapsed])

  useEffect(() => {
    if (phase !== 'success') return
    toast({ kind: 'success', title: t('login.success', { name: profile?.name ?? profileId }), desc: t('login.successDesc') })
    const timer = setTimeout(closeLogin, 1000)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase])

  const cancel = () => {
    if (phaseRef.current !== 'success' && (!profile?.sessionMode || profile.sessionMode === 'login')) void window.agentswitch.pty.kill(profileId)
    closeLogin()
  }
  // Esc is ignored (prevent accidental cancel during OAuth), while ⌘W closes this sheet instead of the app.
  useLayer({ onEsc: null, onClose: cancel, active: drawer.open })

  const primary = urls.find((u) => u.isAuth) ?? urls[urls.length - 1]
  const copy = async () => {
    if (!primary) return
    await window.agentswitch.sys.copy(primary.url)
    setCopied(true)
    setTimeout(() => setCopied(false), 1800)
  }
  const send = (seq: string) => window.agentswitch.pty.write(profileId, seq)
  const submitCode = () => {
    if (!code.trim()) return
    send(code.trim() + '\r')
    setCode('')
  }

  if (!profile) return null

  const stepIndex = phase === 'success' ? 3 : phase === 'url' ? 1 : 0
  const steps = [t('login.step1'), t('login.step2'), t('login.step3')]

  const body = (
    <div className="p-7">
      {/* header */}
      <div className="flex items-start gap-3.5">
        <KindAvatar kind={profile.kind} size={44} />
        <div className="min-w-0 flex-1 pt-0.5">
          <div className="text-[20px] leading-6 font-semibold tracking-tight text-ink">{t('login.title', { name: profile.name })}</div>
          <div className="mt-1 text-[14px] text-ink-2">{t('login.subtitle')}</div>
        </div>
        <button className="rounded-full p-1.5 text-ink-3 transition-colors hover:bg-fill hover:text-ink" onClick={cancel} title={t('common.cancel')}>
          <IconX size={16} />
        </button>
      </div>

      {/* step guide */}
      {phase !== 'exited' && (
        <div className="mt-6 flex items-center">
          {steps.map((s, i) => {
            const done = i < stepIndex || phase === 'success'
            const active = i === stepIndex && phase !== 'success'
            return (
              <div key={s} className="flex flex-1 items-center last:flex-none">
                <div className="flex items-center gap-2">
                  <span
                    className={`flex h-6 w-6 items-center justify-center rounded-full text-[12px] font-semibold transition-colors ${
                      done ? 'bg-green text-white' : active ? 'bg-accent text-white' : 'bg-fill text-ink-3'
                    }`}
                  >
                    {done ? <IconCheck size={13} strokeWidth={2.6} /> : i + 1}
                  </span>
                  <span className={`text-[13px] font-medium whitespace-nowrap ${done || active ? 'text-ink' : 'text-ink-3'}`}>{s}</span>
                </div>
                {i < steps.length - 1 && <div className={`mx-3 h-px flex-1 ${done ? 'bg-green/50' : 'bg-black/[0.08]'}`} />}
              </div>
            )
          })}
        </div>
      )}

      <div className="mt-6">
        {(phase === 'starting' || phase === 'waiting') && (
          <div className="flex flex-col items-center rounded-2xl bg-fill px-6 py-9 text-center">
            <Spinner size={26} className="text-accent" />
            <div className="mt-4 text-[15px] font-medium text-ink">{phase === 'starting' ? t('login.starting') : t('login.fetchingUrl')}</div>
            <div className="mt-1.5 text-[14px] leading-relaxed text-ink-2">
              {phase === 'waiting' && elapsed >= HINT_AFTER
                ? profile?.kind === 'gemini'
                  ? t('login.agyWaiting')
                  : t('login.cliWaiting')
                : t('login.fewSeconds')}
            </div>
          </div>
        )}

        {phase === 'url' && primary && (
          <div>
            <div className="rounded-2xl bg-fill px-5 py-4">
              <div className="text-[15px] font-medium text-ink">{t('login.urlReady')}</div>
              <div className="mt-1 text-[14px] leading-relaxed text-ink-2">
                {tNode('login.incognito', { w: <span className="font-medium text-ink">{t('login.incognitoWord')}</span> })}
              </div>
              <div className="mt-3 truncate rounded-lg bg-surface px-3 py-2 font-mono text-[12px] text-ink-2 shadow-[0_0_0_1px_var(--ring)] select-text" title={primary.url}>
                {primary.url}
              </div>
            </div>
            <div className="mt-5 flex flex-col gap-2.5">
              <button className={btnPrimary + ' h-11 text-[15px]'} onClick={() => void window.agentswitch.sys.openExternal(primary.url)}>
                <IconExternal size={16} /> {t('login.openBrowser')}
              </button>
              <button className={btnSecondary + ' h-11 text-[15px]'} onClick={() => void copy()}>
                {copied ? <IconCheck size={16} className="text-ok" /> : <IconCopy size={16} />}
                {copied ? t('login.copiedUrl') : t('login.copyUrl')}
              </button>
            </div>
            <div className="mt-4 flex items-center justify-center gap-2 text-[13px] text-ink-2">
              <Spinner size={13} /> {t('login.autoContinue')}
            </div>
          </div>
        )}

        {phase === 'success' && (
          <div className="flex flex-col items-center rounded-2xl bg-ok-soft px-6 py-9">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-green text-white shadow-[0_4px_12px_rgba(52,199,89,0.35)]">
              <IconCheck size={24} strokeWidth={2.6} />
            </div>
            <div className="mt-4 text-[16px] font-semibold text-ink">{t('login.done')}</div>
          </div>
        )}

        {phase === 'exited' && (
          <div className="flex flex-col items-center rounded-2xl bg-fill px-6 py-8 text-center">
            <div className="text-[15px] font-medium text-ink">
              {byId(profileId)?.loggedIn ? t('login.ended') : t('login.notDone')}
            </div>
            <div className="mt-1.5 text-[14px] leading-relaxed text-ink-2">
              {byId(profileId)?.loggedIn ? t('login.isLoggedIn') : t('login.noCreds')}
              {exitCode !== null && exitCode !== 0 && <span className="text-ink-3">{t('login.exitCode', { code: exitCode })}</span>}
            </div>
            <div className="mt-5 flex gap-2.5">
              <button className={btnSecondary} onClick={closeLogin}>
                {t('common.close')}
              </button>
              <button className={btnPrimary} onClick={() => void start()}>
                {t('login.retry')}
              </button>
            </div>
          </div>
        )}
      </div>

      {/* interaction helpers for CLIs that ask questions — tucked away by default */}
      {(phase === 'waiting' || phase === 'url') && (
        <div className="mt-5">
          <button className="flex items-center gap-1 text-[13px] font-medium text-ink-2 hover:text-ink" onClick={() => setShowInput((s) => !s)}>
            <IconChevronDown size={14} className={`transition-transform ${showInput ? '' : '-rotate-90'}`} />
            {t('login.needInput')}
          </button>
          {showInput && (
            <div className="mt-3 space-y-2.5">
              <div className="flex gap-2">
                <input
                  className={inputCls + ' min-w-0 flex-1'}
                  placeholder={t('login.pastePlaceholder')}
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && submitCode()}
                />
                <button className={btnSecondary + ' shrink-0 whitespace-nowrap'} onClick={submitCode} disabled={!code.trim()}>
                  {t('login.submit')}
                </button>
              </div>
              <div className="flex items-center gap-1.5">
                <span className="mr-1 text-[13px] text-ink-3">{t('login.sendKey')}</span>
                {KEYS.map((k) => (
                  <button key={k.label === 'enter' ? t('login.enter') : k.label} className="h-8 min-w-10 rounded-lg bg-fill px-2.5 text-[13px] font-medium text-ink hover:bg-fill-hover active:scale-95" onClick={() => send(k.seq)}>
                    {k.label === 'enter' ? t('login.enter') : k.label}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      <div className="mt-6 flex items-center justify-between border-t border-hairline pt-4">
        <button className="inline-flex items-center gap-1.5 text-[13px] text-ink-3 hover:text-ink-2" onClick={() => openDrawer(profileId)}>
          <IconTerminal size={14} /> {t('login.viewTerminal')}
        </button>
        {phase !== 'success' && phase !== 'exited' && (
          <button className="text-[13px] font-medium text-ink-2 hover:text-ink" onClick={cancel}>
            {t('common.cancel')}
          </button>
        )}
      </div>
    </div>
  )

  // With the debug drawer open, dock the sheet so the terminal stays usable.
  if (drawer.open) {
    return (
      <div
        className="fixed right-5 z-50 w-[440px] overflow-y-auto rounded-xl border border-editor-hairline bg-elevated shadow-[0_24px_64px_rgba(0,0,0,0.18)]"
        style={{ bottom: drawerHeight + 20, maxHeight: `calc(100vh - ${drawerHeight + 40}px)` }}
      >
        {body}
      </div>
    )
  }
  return (
    <Modal onClose={cancel} width={500} escClose={false} closeOnCmdW={true} backdropClose={false}>
      {body}
    </Modal>
  )
}
