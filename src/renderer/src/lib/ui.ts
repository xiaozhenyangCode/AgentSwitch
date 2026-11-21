import type { ProfileKind, ProfileState } from '@shared/types'

export interface BadgeMeta {
  label: string
  /** pill background + text */
  cls: string
  /** small status dot */
  dot: string
}

/** Soft "macaron" status palette. */
export const TONE = {
  green: { cls: 'bg-[#E6F6EC] text-[#1A7F45]', dot: 'bg-[#34C759]' },
  amber: { cls: 'bg-[#FFF4E0] text-[#9A5B13]', dot: 'bg-[#FF9F0A]' },
  gray: { cls: 'bg-[#F0F0F2] text-[#6E6E73]', dot: 'bg-[#AEAEB2]' },
  blue: { cls: 'bg-[#E8F1FF] text-[#0A5FCC]', dot: 'bg-[#007AFF]' },
  red: { cls: 'bg-[#FDECEC] text-[#C2352B]', dot: 'bg-[#FF3B30]' }
} as const

/** User-facing status of an account (profile). */
export function accountBadge(p: ProfileState): BadgeMeta {
  if (p.sessionMode === 'login') return { label: '登录中', ...TONE.blue }
  switch (p.status) {
    case 'uninstalled':
      return { label: '未安装', ...TONE.gray }
    case 'not_logged_in':
      return { label: '未登录', ...TONE.amber }
    case 'idle':
      return { label: '已就绪', ...TONE.green }
    case 'running':
      return { label: '运行中', ...TONE.blue }
    case 'rate_limited':
      return { label: '限流', ...TONE.red }
  }
}

export const KIND_META: Record<ProfileKind, { name: string; cli: string; vendor: string; letter: string; color: string }> = {
  claude: { name: 'Claude', cli: 'Claude Code', vendor: 'Anthropic', letter: 'C', color: '#D97757' },
  gemini: { name: 'Gemini', cli: 'Gemini (agy)', vendor: 'Google', letter: 'G', color: '#4285F4' },
  codex: { name: 'Codex', cli: 'Codex CLI', vendor: 'OpenAI', letter: 'X', color: '#10A37F' }
}

/** Ready to be used by a workflow node. */
export const isReady = (p: ProfileState | undefined): boolean => !!p && (p.status === 'idle' || p.status === 'running')

/* ---- buttons ---------------------------------------------------------------- */

const base =
  'inline-flex items-center justify-center gap-1.5 font-medium select-none transition-all duration-150 active:scale-[0.98] disabled:opacity-40 disabled:pointer-events-none'

/** Apple system-blue primary, subtle inner highlight. */
export const btnPrimary = `${base} h-9 rounded-[10px] bg-accent px-4 text-[14px] text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.25),0_1px_2px_rgba(0,122,255,0.3)] hover:bg-accent-hover`

/** Neutral filled button (secondary). */
export const btnSecondary = `${base} h-9 rounded-[10px] bg-fill px-4 text-[14px] text-ink hover:bg-fill-hover`

/** Compact neutral button for list rows. */
export const btnRow = `${base} h-8 rounded-lg bg-fill px-3.5 text-[13px] text-ink hover:bg-fill-hover`

/** Compact primary for list rows. */
export const btnRowPrimary = `${base} h-8 rounded-lg bg-accent px-3.5 text-[13px] text-white hover:bg-accent-hover`

/** Text-only link-style button. */
export const btnLink = `${base} text-[13px] text-accent hover:text-accent-hover active:scale-100`

/** Quiet icon/ghost button. */
export const btnGhost = `${base} h-8 rounded-lg px-2.5 text-[13px] text-ink-2 hover:bg-black/[0.05] hover:text-ink`

export const inputCls =
  'h-9 w-full rounded-[10px] bg-fill px-3 text-[14px] text-ink placeholder:text-ink-3 outline-none ring-1 ring-transparent transition-shadow select-text focus:bg-white focus:ring-2 focus:ring-accent/40'
