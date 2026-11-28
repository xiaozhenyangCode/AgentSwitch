import { useLayoutEffect, useRef, type ReactNode } from 'react'
import { useLayer } from '../lib/escStack'
import type { ProfileConfig, ProfileKind, ProfileState } from '@shared/types'
import { KIND_META, accountBadge, type BadgeMeta } from '../lib/ui'
import { BrandIcon, DeepSeekIcon } from './brandIcons'

export function Pill({ meta, size = 'md' }: { meta: Pick<BadgeMeta, 'label' | 'cls' | 'dot'>; size?: 'sm' | 'md' }) {
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1.5 rounded-full font-medium ${meta.cls} ${
        size === 'md' ? 'h-6 px-2.5 text-[12px]' : 'h-5 px-2 text-[12px]'
      }`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${meta.dot}`} />
      {meta.label}
    </span>
  )
}

export function StatusBadge({ profile }: { profile: ProfileState }) {
  return <Pill meta={accountBadge(profile)} />
}

/** Official brand mark on a white app-icon tile (hairline edge). Same everywhere. */
export function KindAvatar({ kind, size = 32 }: { kind: ProfileKind; size?: number }) {
  return (
    <div
      className="flex shrink-0 items-center justify-center bg-tile shadow-[inset_0_0_0_0.5px_var(--ring),0_0.5px_1px_rgba(0,0,0,0.06)]"
      style={{ width: size, height: size, borderRadius: size * 0.28 }}
      aria-label={KIND_META[kind].name}
    >
      <BrandIcon kind={kind} size={Math.round(size * (kind === 'codex' ? 0.78 : 0.66))} />
    </div>
  )
}

const TILE = 'flex shrink-0 items-center justify-center bg-tile shadow-[inset_0_0_0_0.5px_var(--ring),0_0.5px_1px_rgba(0,0,0,0.06)]'

/** A concrete account's avatar: DeepSeek logo, or the CLI's mark (+ "API" badge for a custom endpoint). */
export function ProfileAvatar({ profile, size = 32 }: { profile: Pick<ProfileConfig, 'kind' | 'apiKey'>; size?: number }) {
  const provider = profile.apiKey?.provider
  if (provider === 'deepseek')
    return (
      <div className={TILE} style={{ width: size, height: size, borderRadius: size * 0.28 }} aria-label="DeepSeek">
        <DeepSeekIcon size={Math.round(size * 0.7)} />
      </div>
    )
  if (provider !== 'custom') return <KindAvatar kind={profile.kind} size={size} />
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <KindAvatar kind={profile.kind} size={size} />
      {size >= 18 && (
        <span
          className="absolute -right-1 -bottom-1 rounded-[4px] bg-ink px-[3px] font-semibold leading-none text-surface"
          style={{ fontSize: Math.max(7, Math.round(size * 0.26)), paddingTop: 2, paddingBottom: 2 }}
        >
          API
        </span>
      )}
    </div>
  )
}

/** macOS segmented control. */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  size = 'md'
}: {
  value: T
  options: { value: T; label: string; title?: string }[]
  onChange: (v: T) => void
  /** sm: compact, stretches to the container width (for popovers). */
  size?: 'sm' | 'md'
}) {
  const sm = size === 'sm'
  return (
    <div className={`${sm ? 'flex w-full' : 'inline-flex'} rounded-[9px] bg-black/[0.05] p-[2px]`}>
      {options.map((o) => (
        <button
          key={o.value}
          aria-pressed={value === o.value}
          title={o.title}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => onChange(o.value)}
          className={`${sm ? 'h-6 flex-auto px-1.5 text-[12px]' : 'h-7 px-3.5 text-[13px]'} rounded-[7px] font-medium whitespace-nowrap transition-all duration-150 ${
            value === o.value ? 'bg-surface text-ink shadow-[0_1px_3px_rgba(0,0,0,0.12),0_0_0_0.5px_var(--ring)]' : 'text-ink-2 hover:text-ink'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

/** Centered sheet over a translucent scrim. */
export function Modal({
  children,
  onClose,
  width = 500,
  escClose = true,
  closeOnCmdW = true,
  backdropClose = true,
  native = false,
  surfaceClassName,
  label
}: {
  children: ReactNode
  onClose: () => void
  width?: number
  escClose?: boolean
  closeOnCmdW?: boolean
  backdropClose?: boolean
  native?: boolean
  surfaceClassName?: string
  label?: string
}) {
  // Always occupy the topmost layer so Esc / ⌘W never leak to dialogs or the window underneath.
  useLayer({ onEsc: escClose ? onClose : null, onClose: closeOnCmdW ? onClose : null })
  const dialog = useRef<HTMLDialogElement>(null)
  useLayoutEffect(() => {
    const modal = dialog.current
    if (!modal) return
    modal.showModal()
    return () => modal.close()
  }, [native])
  const surface = 'max-h-[88vh] overflow-y-auto ' + (surfaceClassName ?? 'rounded-2xl bg-surface shadow-[0_0_0_1px_var(--ring),0_24px_64px_rgba(0,0,0,0.18),0_8px_24px_rgba(0,0,0,0.08)]')
  if (native) {
    return (
      <dialog ref={dialog} aria-label={label} className="no-drag fixed inset-0 m-auto max-w-[calc(100vw-32px)] overflow-visible rounded-2xl bg-transparent text-ink backdrop:bg-(--scrim)"
        style={{ width }}
        onCancel={(event) => { event.preventDefault(); if (escClose) onClose() }}
        onMouseDown={(event) => { if (backdropClose && event.target === dialog.current) onClose() }}>
        <div className={surface}>{children}</div>
      </dialog>
    )
  }
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-(--scrim)"
      onMouseDown={() => backdropClose && onClose()}
    >
      <div
        className={surface}
        style={{ width }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  )
}

/** AgentSwitch app mark: silver macOS squircle with dark medallion and 3-orbit ice-cyan atom. */
export function BrandMark({ size = 32 }: { size?: number }) {
  const angles = [-12, 108, 228]
  return (
    <div
      className="flex shrink-0 items-center justify-center bg-gradient-to-b from-[#F5F6F8] via-[#E5E7EB] to-[#C2C4C9] shadow-[inset_0_1px_0.5px_rgba(255,255,255,0.9),inset_0_-1px_1px_rgba(0,0,0,0.08),0_1px_3px_rgba(0,0,0,0.22)]"
      style={{ width: size, height: size, borderRadius: size * 0.24 }}
      aria-label="AgentSwitch"
    >
      <svg width={size} height={size} viewBox="0 0 100 100" fill="none" aria-hidden>
        <circle cx="50" cy="50" r="36.5" fill="#272A36" />
        {/* Under-pass: outer petal loops */}
        {angles.map((a) => (
          <path
            key={`u${a}`}
            d="M 55.2 72.4 A 13 25 0 0 1 38.6 39.2"
            transform={`rotate(${a} 50 50)`}
            stroke="#D4F6FF"
            strokeWidth="3.5"
            strokeLinecap="round"
          />
        ))}
        {/* Over-pass: main orbital arms with dark halo for crisp weave */}
        {angles.map((a) => (
          <g key={`o${a}`} transform={`rotate(${a} 50 50)`}>
            <path d="M 50 25 A 13 25 0 0 1 58.6 68.5" stroke="#272A36" strokeWidth="7.4" strokeLinecap="round" />
            <path d="M 50 25 A 13 25 0 0 1 58.6 68.5" stroke="#D4F6FF" strokeWidth="3.5" strokeLinecap="round" />
          </g>
        ))}
        {/* Three orbital nodes */}
        {angles.map((a) => (
          <circle
            key={`n${a}`}
            cx="50"
            cy="25"
            r="4.1"
            transform={`rotate(${a} 50 50)`}
            fill="#272A36"
            stroke="#D4F6FF"
            strokeWidth="3.3"
          />
        ))}
        {/* Center core */}
        <circle cx="50" cy="50" r="3.6" fill="#D4F6FF" />
      </svg>
    </div>
  )
}
