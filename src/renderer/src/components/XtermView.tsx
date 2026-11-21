import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import type { SessionId } from '@shared/types'
import { terminals } from '../lib/terminals'

interface Props {
  sessionId: SessionId
  visible: boolean
}

const THEME = {
  background: '#0b0d10',
  foreground: '#d6dae0',
  cursor: '#7dd3fc',
  selectionBackground: '#264f78',
  black: '#1b1f24',
  brightBlack: '#5c6370',
  red: '#f47067',
  green: '#8ddb8c',
  yellow: '#e0b45a',
  blue: '#6cb6ff',
  magenta: '#dcbdfb',
  cyan: '#76e3ea',
  white: '#c5cbd3',
  brightWhite: '#f0f3f6'
}

export function XtermView({ sessionId, visible }: Props) {
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)

  useEffect(() => {
    const host = hostRef.current!
    const term = new Terminal({
      fontFamily: "'SF Mono', 'JetBrains Mono', Menlo, monospace",
      fontSize: 12,
      lineHeight: 1.15,
      cursorBlink: true,
      scrollback: 10000,
      allowProposedApi: true,
      macOptionIsMeta: true,
      theme: THEME
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(host)
    termRef.current = term
    fitRef.current = fit

    const safeFit = () => {
      if (host.offsetWidth > 0 && host.offsetHeight > 0) {
        try {
          fit.fit()
        } catch {
          /* not attached yet */
        }
      }
    }
    safeFit()

    // Replay scrollback from main, then stream live. Event delivery and the buffer reply
    // are not ordered relative to each other, so chunks are deduped by sequence number.
    let replayedSeq: number | null = null
    const early: { data: string; seq: number }[] = []
    const offData = window.agentswitch.pty.onData((e) => {
      if (e.sessionId !== sessionId) return
      if (replayedSeq === null) early.push(e)
      else if (e.seq > replayedSeq) term.write(e.data)
    })
    void window.agentswitch.pty.buffer(sessionId).then((buf) => {
      if (buf.data) term.write(buf.data)
      replayedSeq = buf.seq
      for (const e of early) if (e.seq > buf.seq) term.write(e.data)
      early.length = 0
    })

    const inputSub = term.onData((d) => window.agentswitch.pty.write(sessionId, d))
    const resizeSub = term.onResize(({ cols, rows }) => window.agentswitch.pty.resize(sessionId, cols, rows))

    const ro = new ResizeObserver(() => safeFit())
    ro.observe(host)

    terminals.set(sessionId, {
      cols: () => term.cols,
      rows: () => term.rows,
      fit: safeFit,
      focus: () => term.focus(),
      clear: () => term.clear()
    })

    return () => {
      terminals.delete(sessionId)
      ro.disconnect()
      offData()
      inputSub.dispose()
      resizeSub.dispose()
      term.dispose()
    }
  }, [sessionId])

  useEffect(() => {
    if (!visible) return
    const id = requestAnimationFrame(() => {
      try {
        fitRef.current?.fit()
      } catch {
        /* ignore */
      }
      const t = termRef.current
      if (t) window.agentswitch.pty.resize(sessionId, t.cols, t.rows)
    })
    return () => cancelAnimationFrame(id)
  }, [visible, sessionId])

  return (
    <div
      ref={hostRef}
      className="xterm-host absolute inset-0"
      style={{ visibility: visible ? 'visible' : 'hidden', zIndex: visible ? 1 : 0 }}
    />
  )
}
