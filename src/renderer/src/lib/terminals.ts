import type { SessionId } from '@shared/types'

/** Live xterm handles (debug drawer), so actions can read the right cols/rows. */
export interface TerminalHandle {
  cols: () => number
  rows: () => number
  fit: () => void
  focus: () => void
  clear: () => void
}

export const terminals = new Map<SessionId, TerminalHandle>()

export function dims(id: SessionId): { cols: number; rows: number } {
  const t = terminals.get(id)
  return { cols: t?.cols() ?? 120, rows: t?.rows() ?? 32 }
}
