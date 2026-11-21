import { useEffect, useRef } from 'react'

/**
 * Esc goes to the topmost open layer only (dialog over dialog over panel). Each open layer
 * registers a handler; one capture-phase listener calls the newest and stops the key there.
 */
const stack: { id: number; fn: () => void }[] = []
let seq = 0

window.addEventListener(
  'keydown',
  (e) => {
    if (e.key !== 'Escape' || e.isComposing || !stack.length) return
    // a terminal (login / debug drawer) needs Esc for the CLI running in it
    if (e.target instanceof Element && e.target.closest('.xterm')) return
    e.preventDefault()
    e.stopImmediatePropagation()
    stack[stack.length - 1].fn()
  },
  true
)

/** While `active`, Esc calls `onEsc` (unless a layer opened later is on top). */
export function useEscape(onEsc: () => void, active = true): void {
  const fn = useRef(onEsc)
  fn.current = onEsc
  useEffect(() => {
    if (!active) return
    const id = ++seq
    stack.push({ id, fn: () => fn.current() })
    return () => {
      const i = stack.findIndex((x) => x.id === id)
      if (i >= 0) stack.splice(i, 1)
    }
  }, [active])
}

/** True while any layer is open (e.g. the composer should not treat Esc as its own). */
export const escLayers = (): number => stack.length
