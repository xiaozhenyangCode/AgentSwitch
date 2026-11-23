import type { ProfileKind, ProfileState } from '@shared/types'
import { t } from '../state/i18n'

export interface BadgeMeta {
  label: string
  /** pill background + text */
  cls: string
  /** small status dot */
  dot: string
}

/** Soft "macaron" status palette. */
export const TONE = {
  green: { cls: 'bg-ok-soft text-ok', dot: 'bg-green' },
  amber: { cls: 'bg-warn-soft text-warn', dot: 'bg-orange' },
  gray: { cls: 'bg-fill text-ink-2', dot: 'bg-muted-dot' },
  blue: { cls: 'bg-info-soft text-info', dot: 'bg-accent' },
  red: { cls: 'bg-danger-soft text-danger', dot: 'bg-red' }
} as const

/** User-facing status of an account (profile). */
export function accountBadge(p: ProfileState): BadgeMeta {
  if (p.sessionMode === 'login') return { label: t('status.loggingIn'), ...TONE.blue }
  switch (p.status) {
    case 'uninstalled':
      return { label: t('status.uninstalled'), ...TONE.gray }
    case 'not_logged_in':
      return { label: t('status.notLoggedIn'), ...TONE.amber }
    case 'idle':
      return { label: t('status.ready'), ...TONE.green }
    case 'running':
      return { label: t('status.running'), ...TONE.blue }
    case 'rate_limited':
      return { label: t('status.rateLimited'), ...TONE.red }
  }
}

/**
 * color: the official mark's main color. bar: quota-bar fill taken from the official mark
 * (Gemini: its yellow/red/green accents into the dominant blue; Codex: its violet-to-blue gradient).
 */
export const KIND_META: Record<ProfileKind, { name: string; cli: string; vendor: string; letter: string; color: string; bar: string }> = {
  claude: { name: 'Claude', cli: 'Claude Code', vendor: 'Anthropic', letter: 'C', color: '#D97757', bar: 'linear-gradient(90deg, #E08A6D, #D97757)' },
  gemini: { name: 'Gemini', cli: 'Gemini (agy)', vendor: 'Google', letter: 'G', color: '#3186FF', bar: 'linear-gradient(90deg, #FABC12 0%, #F94543 14%, #08B962 28%, #3186FF 46%, #3186FF 100%)' },
  codex: { name: 'Codex', cli: 'Codex CLI', vendor: 'OpenAI', letter: 'X', color: '#7A9DFF', bar: 'linear-gradient(90deg, #B1A7FF 0%, #7A9DFF 50%, #3941FF 100%)' },
  reasonix: { name: 'Reasonix', cli: 'reasonix', vendor: 'DeepSeek', letter: 'R', color: '#4257D9', bar: 'linear-gradient(90deg, #6B8CFF, #4257D9)' }
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
  'h-9 w-full rounded-[10px] bg-fill px-3 text-[14px] text-ink placeholder:text-ink-3 outline-none ring-1 ring-transparent transition-shadow select-text focus:bg-surface focus:ring-2 focus:ring-accent/40'
