import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from 'react'
import { useLayer } from '../lib/escStack'
import { t } from '../state/i18n'
import { IconX } from './icons'

const EXIT_MS = 150
const FOCUSABLE = 'a[href], button, input, select, textarea, [contenteditable="true"], [tabindex]'
let scrollLocks = 0
let previousOverflow = ''

function lockScroll() {
  if (scrollLocks++ === 0) {
    previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
  }
  return () => {
    if (--scrollLocks === 0) document.body.style.overflow = previousOverflow
  }
}

function cycleFocus(event: KeyboardEvent<HTMLDivElement>) {
  if (event.key !== 'Tab' || event.defaultPrevented) return
  const panel = event.currentTarget
  if (!panel.contains(event.target as Node)) return
  const scope = (event.target as HTMLElement).closest<HTMLElement>('[role="dialog"], dialog') ?? panel
  const stops = Array.from(scope.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((element) =>
    element.tabIndex >= 0 && !element.matches(':disabled') && !element.closest('[inert]') &&
    element.getClientRects().length > 0 && getComputedStyle(element).visibility === 'visible' &&
    element.closest('[role="dialog"], dialog') === scope
  )
  const current = document.activeElement
  const next = event.shiftKey ? stops.at(-1) : stops[0]
  const edge = event.shiftKey ? stops[0] : stops.at(-1)
  if (current === edge || !stops.includes(current as HTMLElement)) {
    event.preventDefault()
    ;(next ?? scope).focus()
  }
}

interface WorkspaceSheetModalProps {
  open?: boolean
  onClose: () => void
  onEsc?: () => void
  onExited?: () => void
  backdropClose?: boolean
  disableLayer?: boolean
  bottomOffset?: number
  inert?: boolean
  ariaLabel?: string
  ariaLabelledBy?: string
  panelClassName?: string
  bodyClassName?: string
  header?: ReactNode
  footer?: ReactNode
  children: ReactNode
  overlayRef?: RefObject<HTMLDivElement | null>
  overlayChildren?: ReactNode
}

export function WorkspaceSheetModal({
  open = true, onClose, onEsc, onExited, backdropClose = true, disableLayer = false, bottomOffset = 0,
  inert, ariaLabel, ariaLabelledBy, panelClassName = '', bodyClassName = 'flex-col', header, footer,
  children, overlayRef, overlayChildren
}: WorkspaceSheetModalProps) {
  const [present, setPresent] = useState(open)
  const panel = useRef<HTMLDivElement>(null)
  const afterExit = useRef(onExited)
  afterExit.current = onExited
  const mounted = open || present

  useLayer({ onEsc: onEsc ?? onClose, onClose, active: open && !disableLayer })

  useEffect(() => {
    if (open) {
      setPresent(true)
    } else if (present) {
      const duration = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 1 : EXIT_MS
      const timer = window.setTimeout(() => {
        setPresent(false)
        afterExit.current?.()
      }, duration)
      return () => window.clearTimeout(timer)
    }
  }, [open, present])

  useLayoutEffect(() => {
    if (mounted) return lockScroll()
  }, [mounted])

  useLayoutEffect(() => {
    if (!open) return
    const focused = document.activeElement
    const target = panel.current?.querySelector<HTMLElement>('[data-sheet-autofocus]') ?? panel.current
    target?.focus({ preventScroll: true })
    return () => {
      if (focused instanceof HTMLElement && focused.isConnected) focused.focus({ preventScroll: true })
    }
  }, [open])

  if (!mounted) return null
  return (
    <div
      ref={overlayRef}
      className={`no-drag fixed inset-0 z-40 bg-(--scrim) ${open ? 'scrim-in' : 'scrim-out'}`}
      inert={!open}
      onMouseDown={(event) => {
        if (open && !inert && backdropClose && event.button === 0 && event.target === event.currentTarget) onClose()
      }}
    >
      <div className="pointer-events-none absolute inset-x-0 top-0 flex items-center justify-center" style={{ bottom: bottomOffset }}>
        <div
          ref={panel}
          role="dialog"
          aria-modal="true"
          aria-label={ariaLabel}
          aria-labelledby={ariaLabelledBy}
          inert={inert}
          tabIndex={-1}
          onKeyDown={cycleFocus}
          className={`workspace-sheet-panel pointer-events-auto flex h-[calc(100vh*2/3)] min-h-[min(460px,calc(100%-32px))] max-h-[min(1040px,calc(100%-32px))] w-[calc(100vw*2/3)] min-w-[min(720px,calc(100vw-32px))] max-w-[min(1600px,calc(100vw-32px))] flex-col overflow-hidden rounded-2xl text-ink shadow-[0_0_0_1px_var(--ring),0_24px_64px_rgba(0,0,0,0.18),0_8px_24px_rgba(0,0,0,0.08)] outline-none ${open ? 'sheet-in' : 'sheet-out'} ${panelClassName}`}
        >
          {header && <div className="shrink-0">{header}</div>}
          <div className={`flex min-h-0 flex-1 ${bodyClassName}`}>{children}</div>
          {footer && <div className="shrink-0">{footer}</div>}
        </div>
      </div>
      {overlayChildren}
    </div>
  )
}

export function SheetCloseButton({ onClick, label = t('common.close') }: { onClick: () => void; label?: string }) {
  return (
    <button type="button" onClick={onClick} title={label} aria-label={label}
      className="grid size-8 shrink-0 place-items-center rounded-lg text-ink-2 hover:bg-black/[0.06] hover:text-ink">
      <IconX size={16} aria-hidden="true" />
    </button>
  )
}
