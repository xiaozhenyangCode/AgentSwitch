import type { ReactNode } from 'react'
import type { ProfileKind, ProfileState } from '@shared/types'
import { KIND_META, accountBadge, type BadgeMeta } from '../lib/ui'
import { BrandIcon } from './brandIcons'

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

/** Centered sheet over a frosted backdrop. */
export function Modal({ children, onClose, width = 500 }: { children: ReactNode; onClose: () => void; width?: number }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-(--scrim) backdrop-blur-md" onMouseDown={onClose}>
      <div
        className="max-h-[88vh] overflow-y-auto rounded-2xl bg-surface shadow-[0_0_0_1px_var(--ring),0_24px_64px_rgba(0,0,0,0.18),0_8px_24px_rgba(0,0,0,0.08)]"
        style={{ width }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  )
}
