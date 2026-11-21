import { useCallback, useEffect, useRef, useState } from 'react'
import type { ProfileId, SessionId, SessionInfo } from '@shared/types'
import { useApp } from '../state/AppContext'
import { dims, terminals } from '../lib/terminals'
import { XtermView } from './XtermView'
import { IconTerminal, IconX } from './icons'

const TEST_PRESETS: { label: string; cmd: string }[] = [
  {
    label: '查看隔离环境变量',
    cmd: `echo "HOME=$HOME"; echo "CLAUDE_CONFIG_DIR=$CLAUDE_CONFIG_DIR"; echo "CODEX_HOME=$CODEX_HOME"; echo "AGENTSWITCH_PROFILE=$AGENTSWITCH_PROFILE"; ls -la "$HOME" | head -20`
  },
  { label: 'PATH 检查 (which)', cmd: 'echo "$PATH" | tr ":" "\\n"; which node npm pnpm claude gemini codex' },
  {
    label: '模拟 OAuth URL 输出',
    cmd: `printf 'Open this URL to sign in:\\n\\nhttps://accounts.example.com/o/oauth2/auth?client_id=agentswitch-test&redirect_uri=http%%3A%%2F%%2Flocalhost%%3A8085&state=%s\\n\\nWaiting for authorization...\\n' "$RANDOM"; sleep 2`
  },
  { label: '交互输入测试 (read)', cmd: 'read "name?你的名字: "; echo "hello, $name"' },
  { label: '颜色 / 宽度测试', cmd: 'for i in {0..15}; do printf "\\e[48;5;${i}m  \\e[0m"; done; echo; tput cols; tput lines' }
]

export const DRAWER_HEIGHT = 340

/**
 * Bottom slide-out drawer with raw xterm sessions.
 * Tabs appear only for sessions that are running or have produced output.
 */
export function DebugDrawer() {
  const { drawer, closeDrawer, setDrawerSession, toast, profiles, byId } = useApp()
  const [sessions, setSessions] = useState<SessionInfo[]>([])
  const known = useRef(new Set<SessionId>())

  const load = useCallback(() => {
    void window.agentswitch.pty.sessions().then((list) => {
      known.current = new Set(list.map((s) => s.sessionId))
      setSessions(list)
    })
  }, [])

  useEffect(() => {
    load()
    const offExit = window.agentswitch.pty.onExit(load)
    const offState = window.agentswitch.state.onChanged(load)
    // first output of a brand-new session -> add its tab
    const offData = window.agentswitch.pty.onData((e) => {
      if (!known.current.has(e.sessionId)) {
        known.current.add(e.sessionId)
        load()
      }
    })
    return () => {
      offExit()
      offState()
      offData()
    }
  }, [load])

  const active: SessionId | null =
    drawer.session && sessions.some((s) => s.sessionId === drawer.session) ? drawer.session : (sessions[0]?.sessionId ?? null)
  const activeInfo = sessions.find((s) => s.sessionId === active)
  const activeProfile: ProfileId | null = active && byId(active) ? active : null

  useEffect(() => {
    if (drawer.open && active) requestAnimationFrame(() => terminals.get(active)?.focus())
  }, [drawer.open, active])

  const start = async (profileId: ProfileId, mode: 'shell' | 'test', command?: string) => {
    try {
      setDrawerSession(profileId)
      await window.agentswitch.pty.start({ profileId, mode, command, ...dims(profileId) })
      requestAnimationFrame(() => terminals.get(profileId)?.focus())
    } catch (e) {
      toast({ kind: 'error', title: '启动失败', desc: String(e) })
    }
  }

  const chip =
    'h-7 shrink-0 rounded-md px-2.5 text-[12px] font-medium text-white/70 hover:bg-white/10 hover:text-white disabled:opacity-30 disabled:pointer-events-none transition-colors'
  const darkSelect = 'h-7 max-w-[150px] shrink-0 rounded-md bg-white/[0.08] px-2 text-[12px] text-white/80 outline-none disabled:opacity-30'

  return (
    <div
      className="dark-scroll absolute inset-x-3 bottom-0 z-30 flex flex-col overflow-hidden rounded-t-[14px] bg-[#1C1C1E] shadow-[0_-1px_0_rgba(0,0,0,0.08),0_-16px_48px_rgba(0,0,0,0.18)] transition-transform duration-300 ease-[cubic-bezier(0.32,0.72,0,1)]"
      style={{
        height: DRAWER_HEIGHT,
        transform: drawer.open ? 'translateY(0)' : 'translateY(104%)',
        visibility: drawer.open ? 'visible' : 'hidden'
      }}
    >
      <div className="flex h-11 shrink-0 items-center gap-3 border-b border-white/[0.06] bg-[#2C2C2E] px-3">
        <span className="shrink-0 font-mono text-[12px] font-medium text-white/50">&gt;_ 调试日志</span>

        {/* tabs: scroll horizontally, never squeeze the toolbar */}
        <div className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto [&::-webkit-scrollbar]:hidden">
          {sessions.map((s) => (
            <button
              key={s.sessionId}
              onClick={() => setDrawerSession(s.sessionId)}
              className={`flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-[12px] whitespace-nowrap transition-colors ${
                s.sessionId === active ? 'bg-white/[0.12] text-white' : 'text-white/50 hover:text-white/85'
              }`}
              title={`${s.sessionId}${s.mode ? ` · ${s.mode}` : ''}${s.alive ? ' · 运行中' : ' · 已结束'}`}
            >
              <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${s.alive ? 'bg-green' : 'bg-white/25'}`} />
              {s.label}
            </button>
          ))}
        </div>

        {/* developer tools; fixed width, never truncated */}
        <div className="flex shrink-0 items-center gap-1">
          <select
            className={darkSelect}
            value=""
            disabled={profiles.length === 0}
            onChange={(e) => e.target.value && void start(e.target.value, 'shell')}
            title="在某个账号的隔离环境中打开 Shell"
          >
            <option value="">打开 Shell…</option>
            {profiles.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <select
            className={darkSelect}
            value=""
            disabled={!activeProfile}
            onChange={(e) => e.target.value && activeProfile && void start(activeProfile, 'test', e.target.value)}
            title={activeProfile ? '在当前账号的隔离环境中执行测试命令' : '先选择一个账号会话'}
          >
            <option value="">测试命令…</option>
            {TEST_PRESETS.map((t) => (
              <option key={t.label} value={t.cmd}>
                {t.label}
              </option>
            ))}
          </select>
          <button className={chip} disabled={!activeInfo?.alive} onClick={() => active && void window.agentswitch.pty.kill(active)}>
            结束
          </button>
          <button className={chip} disabled={!active} onClick={() => active && terminals.get(active)?.clear()}>
            清屏
          </button>
          <button className="ml-0.5 shrink-0 rounded-md p-1.5 text-white/50 hover:bg-white/10 hover:text-white" onClick={closeDrawer} title="收起">
            <IconX size={14} />
          </button>
        </div>
      </div>

      <div className="relative min-h-0 flex-1 bg-[#0B0D10]">
        {sessions.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-white/40">
            <IconTerminal size={22} />
            <div className="text-[13px]">暂无活动日志</div>
          </div>
        ) : (
          sessions.map((s) => <XtermView key={s.sessionId} sessionId={s.sessionId} visible={drawer.open && s.sessionId === active} />)
        )}
      </div>
    </div>
  )
}
