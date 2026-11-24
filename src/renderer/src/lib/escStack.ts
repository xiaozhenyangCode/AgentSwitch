import { useEffect, useRef } from 'react'

/**
 * Esc and ⌘W go to the topmost open layer only (dialog over dialog over panel).
 * Each open layer registers handlers:
 * - Esc invokes the topmost layer's `onEsc` (if null, Esc is blocked so it does not leak to a lower layer).
 * - ⌘W invokes the topmost layer's `onClose` (closing the dialog directly even if Esc would first clear a search box).
 */
interface Layer {
  id: number
  onEsc: (() => void) | null
  onClose: (() => void) | null
}

const stack: Layer[] = []
let seq = 0

declare global {
  interface Window {
    __agentswitchCloseTop?: () => boolean
  }
}

/**
 * Called by the main process menu (`File → Close Window`, ⌘W).
 * Consumes ⌘W on the topmost open dialog/overlay and returns true so the window stays open;
 * returns false when no layer is open so the window closes normally.
 */
export function closeTopLayer(): boolean {
  if (!stack.length) return false
  const top = stack[stack.length - 1]
  if (top.onClose) top.onClose()
  return true
}

if (typeof window !== 'undefined') {
  window.__agentswitchCloseTop = closeTopLayer
  window.addEventListener(
    'keydown',
    (e) => {
      if (e.key !== 'Escape' || e.isComposing || !stack.length) return
      // a terminal (login / debug drawer) needs Esc for the CLI running in it
      if (typeof Element !== 'undefined' && e.target instanceof Element && e.target.closest('.xterm')) return
      const top = stack[stack.length - 1]
      e.preventDefault()
      e.stopImmediatePropagation()
      top.onEsc?.()
    },
    true
  )
}

/** Internal registration helper (exported for unit tests). */
export function pushLayer(handlers: { onEsc: () => void; onClose: () => void }): () => void {
  const id = ++seq
  stack.push({ id, ...handlers })
  return () => {
    const i = stack.findIndex((x) => x.id === id)
    if (i >= 0) stack.splice(i, 1)
  }
}

/** Registers a topmost layer with independent Esc and ⌘W handlers. */
export function useLayer({
  onEsc,
  onClose,
  active = true
}: {
  onEsc?: (() => void) | null
  onClose?: (() => void) | null
  active?: boolean
}): void {
  const escRef = useRef(onEsc ?? null)
  const closeRef = useRef(onClose ?? null)
  escRef.current = onEsc ?? null
  closeRef.current = onClose ?? null
  useEffect(() => {
    if (!active) return
    return pushLayer({
      onEsc: () => escRef.current?.(),
      onClose: () => closeRef.current?.()
    })
  }, [active])
}

/** While `active`, Esc calls `onEsc` and ⌘W calls `onClose` (defaults to `onEsc`). */
export function useEscape(onEsc: () => void, active = true, onClose: () => void = onEsc): void {
  useLayer({ onEsc, onClose, active })
}

/** True while any layer is open (e.g. the composer should not treat Esc as its own). */
export const escLayers = (): number => stack.length
