import { useSyncExternalStore } from 'react'
import type { ProfileId, ProfileState } from '@shared/types'
import { isReady, isSignedIn } from '../lib/ui'
import { getSettings } from './settings'
import type { Thread } from './chat'

/** Settings of a conversation that hasn't been created yet (no thread selected). */
export type DraftCtx = Pick<Thread, 'projectDir' | 'participants' | 'driver'>

const KEY = 'agentswitch.draft.v1'
const EMPTY: DraftCtx = { projectDir: null, participants: [], driver: { profileId: null, model: null } }

let draft: DraftCtx = (() => {
  try {
    return { ...EMPTY, ...JSON.parse(localStorage.getItem(KEY) ?? '') }
  } catch {
    return EMPTY
  }
})()
const listeners = new Set<() => void>()

export const getDraft = (): DraftCtx => draft
export function patchDraft(patch: Partial<DraftCtx>): void {
  draft = { ...draft, ...patch }
  localStorage.setItem(KEY, JSON.stringify(draft))
  listeners.forEach((l) => l())
}
export function useDraft(): DraftCtx {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    () => draft
  )
}

/**
 * Driver for a conversation: its own choice, else 设置 › 新对话默认账号, else the first ready
 * participant, else the first ready account. `sorted` is ready-first.
 */
export function pickDriver(ctx: DraftCtx, sorted: ProfileState[], participants: ProfileId[]): ProfileState | undefined {
  const byId = (id: ProfileId | null) => (id ? sorted.find((p) => p.id === id) : undefined)
  return (
    byId(ctx.driver.profileId) ??
    byId(getSettings().defaultDriver) ??
    sorted.find((p) => participants.includes(p.id) && isReady(p)) ??
    sorted.find(isReady) ??
    sorted.find((p) => participants.includes(p.id) && isSignedIn(p)) ??
    sorted.find(isSignedIn) ??
    sorted[0]
  )
}
