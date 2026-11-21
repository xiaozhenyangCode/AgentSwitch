import type { ReactNode } from 'react'
import type { ProfileKind, ProfileState } from '@shared/types'
import { KIND_META, accountBadge, type BadgeMeta } from '../lib/ui'

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

/** Minimal white glyph per CLI family, drawn on a 24×24 grid. */
function KindGlyph({ kind }: { kind: ProfileKind }) {
  if (kind === 'claude')
    return (
      <g stroke="currentColor" strokeWidth="2.3" strokeLinecap="round">
        {[0, 45, 90, 135, 180, 225, 270, 315].map((a, i) => (
          <line key={a} x1="12" y1="12" x2="12" y2={i % 2 ? 5.2 : 3.6} transform={`rotate(${a + 22.5} 12 12)`} />
        ))}
        <circle cx="12" cy="12" r="2.1" fill="currentColor" stroke="none" />
      </g>
    )
  if (kind === 'gemini') return <path fill="currentColor" d="M12 3c.5 4.6 3.9 8 8.5 8.6v.8C15.9 13 12.5 16.4 12 21h-.1c-.5-4.6-3.9-8-8.5-8.6v-.8C8 11 11.4 7.6 11.9 3H12Z" />
  return (
    <g fill="none" stroke="currentColor" strokeWidth="2.3" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 7.5 10.5 12 6 16.5" />
      <path d="M12.5 17h6" />
    </g>
  )
}

/** Brand icon: restrained brand-tinted rounded square + white glyph. Same everywhere. */
export function KindAvatar({ kind, size = 32 }: { kind: ProfileKind; size?: number }) {
  const k = KIND_META[kind]
  return (
    <div
      className="flex shrink-0 items-center justify-center text-white shadow-[inset_0_0_0_0.5px_rgba(0,0,0,0.08),inset_0_1px_0_rgba(255,255,255,0.22)]"
      style={{ width: size, height: size, borderRadius: size * 0.28, background: `linear-gradient(180deg, ${k.color}E6, ${k.color})` }}
      aria-label={k.name}
    >
      <svg width={size * 0.66} height={size * 0.66} viewBox="0 0 24 24" aria-hidden>
        <KindGlyph kind={kind} />
      </svg>
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
            value === o.value ? 'bg-white text-ink shadow-[0_1px_3px_rgba(0,0,0,0.12),0_0_0_0.5px_rgba(0,0,0,0.06)]' : 'text-ink-2 hover:text-ink'
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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/20 backdrop-blur-md" onMouseDown={onClose}>
      <div
        className="max-h-[88vh] overflow-y-auto rounded-2xl bg-white shadow-[0_0_0_1px_rgba(0,0,0,0.06),0_24px_64px_rgba(0,0,0,0.18),0_8px_24px_rgba(0,0,0,0.08)]"
        style={{ width }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  )
}
