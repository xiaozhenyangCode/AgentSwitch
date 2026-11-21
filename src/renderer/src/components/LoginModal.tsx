import { useEffect, useRef, useState } from 'react'
import type { ProfileId, PtyUrlEvent } from '@shared/types'
import { useApp } from '../state/AppContext'
import { dims } from '../lib/terminals'
import { btnPrimary, btnSecondary, inputCls } from '../lib/ui'
import { KindAvatar, Modal } from './common'
import { DRAWER_HEIGHT } from './DebugDrawer'
import { IconCheck, IconChevronDown, IconCopy, IconExternal, IconTerminal, IconX, Spinner } from './icons'

type Phase = 'starting' | 'waiting' | 'url' | 'exited' | 'success'

/** Seconds without a URL before we suggest the CLI may be waiting for input. */
const HINT_AFTER = 6

const KEYS: { label: string; seq: string }[] = [
  { label: '↑', seq: '\x1b[A' },
  { label: '↓', seq: '\x1b[B' },
  { label: '回车', seq: '\r' },
  { label: 'Esc', seq: '\x1b' }
]

export function LoginModal({ profileId }: { profileId: ProfileId }) {
  const { byId, closeLogin, toast, drawer, openDrawer, refresh } = useApp()
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
      await window.agentmux.pty.start({ profileId, mode: 'login', ...dims(profileId) })
      setPhase('waiting')
    } catch (e) {
      toast({ kind: 'error', title: '无法开始登录', desc: String(e) })
      setPhase('exited')
    }
  }

  useEffect(() => {
    const offUrl = window.agentmux.pty.onUrl((e) => {
      if (e.sessionId !== profileId) return
      setUrls((prev) => (prev.some((u) => u.url === e.url) ? prev : [...prev, e]))
      setPhase((p) => (p === 'waiting' || p === 'starting' ? 'url' : p))
    })
    const offOk = window.agentmux.profiles.onLoginSuccess((e) => {
      if (e.profileId === profileId) setPhase('success')
    })
    const offExit = window.agentmux.pty.onExit((e) => {
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
    toast({ kind: 'success', title: `${profile?.name ?? profileId} 已登录`, desc: '账号已就绪，可以在工作流中使用了。' })
    const t = setTimeout(closeLogin, 1000)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase])

  const cancel = () => {
    if (phaseRef.current !== 'success' && profile?.sessionMode === 'login') void window.agentmux.pty.kill(profileId)
    closeLogin()
  }

  const primary = urls.find((u) => u.isAuth) ?? urls[urls.length - 1]
  const copy = async () => {
    if (!primary) return
    await window.agentmux.sys.copy(primary.url)
    setCopied(true)
    setTimeout(() => setCopied(false), 1800)
  }
  const send = (seq: string) => window.agentmux.pty.write(profileId, seq)
  const submitCode = () => {
    if (!code.trim()) return
    send(code.trim() + '\r')
    setCode('')
  }

  if (!profile) return null

  const stepIndex = phase === 'success' ? 3 : phase === 'url' ? 1 : 0
  const steps = ['准备登录', '在浏览器中授权', '完成']

  const body = (
    <div className="p-7">
      {/* header */}
      <div className="flex items-start gap-3.5">
        <KindAvatar kind={profile.kind} size={44} />
        <div className="min-w-0 flex-1 pt-0.5">
          <div className="text-[20px] leading-6 font-semibold tracking-tight text-ink">登录 {profile.name}</div>
          <div className="mt-1 text-[14px] text-ink-2">授权后，此账号即可在工作流中使用</div>
        </div>
        <button className="rounded-full p-1.5 text-ink-3 transition-colors hover:bg-fill hover:text-ink" onClick={cancel} title="取消">
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
                      done ? 'bg-[#34C759] text-white' : active ? 'bg-accent text-white' : 'bg-fill text-ink-3'
                    }`}
                  >
                    {done ? <IconCheck size={13} strokeWidth={2.6} /> : i + 1}
                  </span>
                  <span className={`text-[13px] font-medium whitespace-nowrap ${done || active ? 'text-ink' : 'text-ink-3'}`}>{s}</span>
                </div>
                {i < steps.length - 1 && <div className={`mx-3 h-px flex-1 ${done ? 'bg-[#34C759]/50' : 'bg-black/[0.08]'}`} />}
              </div>
            )
          })}
        </div>
      )}

      <div className="mt-6">
        {(phase === 'starting' || phase === 'waiting') && (
          <div className="flex flex-col items-center rounded-2xl bg-fill px-6 py-9 text-center">
            <Spinner size={26} className="text-accent" />
            <div className="mt-4 text-[15px] font-medium text-ink">{phase === 'starting' ? '正在启动登录…' : '正在获取授权链接…'}</div>
            <div className="mt-1.5 text-[14px] leading-relaxed text-ink-2">
              {phase === 'waiting' && elapsed >= HINT_AFTER
                ? profile?.kind === 'gemini'
                  ? 'agy 可能在等你选择登录方式。用下方按键选择，或输入 /login 后回车。'
                  : '命令行可能在等你选择登录方式，可以用下方的按键操作。'
                : '通常只需要几秒钟'}
            </div>
          </div>
        )}

        {phase === 'url' && primary && (
          <div>
            <div className="rounded-2xl bg-fill px-5 py-4">
              <div className="text-[15px] font-medium text-ink">授权链接已准备好</div>
              <div className="mt-1 text-[14px] leading-relaxed text-ink-2">
                如果你有多个账号，建议复制链接到浏览器的<span className="font-medium text-ink">无痕窗口</span>
                中打开，避免用错账号授权。
              </div>
              <div className="mt-3 truncate rounded-lg bg-white px-3 py-2 font-mono text-[12px] text-ink-2 shadow-[0_0_0_1px_rgba(0,0,0,0.05)] select-text" title={primary.url}>
                {primary.url}
              </div>
            </div>
            <div className="mt-5 flex flex-col gap-2.5">
              <button className={btnPrimary + ' h-11 text-[15px]'} onClick={() => void window.agentmux.sys.openExternal(primary.url)}>
                <IconExternal size={16} /> 打开浏览器授权
              </button>
              <button className={btnSecondary + ' h-11 text-[15px]'} onClick={() => void copy()}>
                {copied ? <IconCheck size={16} className="text-[#1A7F45]" /> : <IconCopy size={16} />}
                {copied ? '已复制，粘贴到无痕窗口打开' : '复制链接（无痕窗口防串号）'}
              </button>
            </div>
            <div className="mt-4 flex items-center justify-center gap-2 text-[13px] text-ink-2">
              <Spinner size={13} /> 授权完成后会自动继续
            </div>
          </div>
        )}

        {phase === 'success' && (
          <div className="flex flex-col items-center rounded-2xl bg-[#F0FAF3] px-6 py-9">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-[#34C759] text-white shadow-[0_4px_12px_rgba(52,199,89,0.35)]">
              <IconCheck size={24} strokeWidth={2.6} />
            </div>
            <div className="mt-4 text-[16px] font-semibold text-ink">登录成功</div>
          </div>
        )}

        {phase === 'exited' && (
          <div className="flex flex-col items-center rounded-2xl bg-fill px-6 py-8 text-center">
            <div className="text-[15px] font-medium text-ink">
              {byId(profileId)?.loggedIn ? '登录流程已结束' : '登录没有完成'}
            </div>
            <div className="mt-1.5 text-[14px] leading-relaxed text-ink-2">
              {byId(profileId)?.loggedIn ? '账号目前处于已登录状态。' : '没有检测到登录信息，可以重试或查看日志了解原因。'}
              {exitCode !== null && exitCode !== 0 && <span className="text-ink-3">（退出码 {exitCode}）</span>}
            </div>
            <div className="mt-5 flex gap-2.5">
              <button className={btnSecondary} onClick={closeLogin}>
                关闭
              </button>
              <button className={btnPrimary} onClick={() => void start()}>
                重新登录
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
            命令行需要我输入？
          </button>
          {showInput && (
            <div className="mt-3 space-y-2.5">
              <div className="flex gap-2">
                <input
                  className={inputCls}
                  placeholder="粘贴授权码后按回车"
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && submitCode()}
                />
                <button className={btnSecondary} onClick={submitCode} disabled={!code.trim()}>
                  提交
                </button>
              </div>
              <div className="flex items-center gap-1.5">
                <span className="mr-1 text-[13px] text-ink-3">发送按键</span>
                {KEYS.map((k) => (
                  <button key={k.label} className="h-8 min-w-10 rounded-lg bg-fill px-2.5 text-[13px] font-medium text-ink hover:bg-fill-hover active:scale-95" onClick={() => send(k.seq)}>
                    {k.label}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      <div className="mt-6 flex items-center justify-between border-t border-hairline pt-4">
        <button className="inline-flex items-center gap-1.5 text-[13px] text-ink-3 hover:text-ink-2" onClick={() => openDrawer(profileId)}>
          <IconTerminal size={14} /> 查看终端日志
        </button>
        {phase !== 'success' && phase !== 'exited' && (
          <button className="text-[13px] font-medium text-ink-2 hover:text-ink" onClick={cancel}>
            取消
          </button>
        )}
      </div>
    </div>
  )

  // With the debug drawer open, dock the sheet so the terminal stays usable.
  if (drawer.open) {
    return (
      <div
        className="fixed right-5 z-50 max-h-[calc(100vh-380px)] w-[440px] overflow-y-auto rounded-2xl bg-white shadow-[0_0_0_1px_rgba(0,0,0,0.06),0_24px_64px_rgba(0,0,0,0.22)]"
        style={{ bottom: DRAWER_HEIGHT + 20 }}
      >
        {body}
      </div>
    )
  }
  return (
    <Modal onClose={() => undefined} width={500}>
      {body}
    </Modal>
  )
}
