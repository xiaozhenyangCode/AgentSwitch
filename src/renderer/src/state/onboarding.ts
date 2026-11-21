import { useEffect, useState } from 'react'
import type { OnboardingState } from '@shared/types'
import { useApp } from './AppContext'
import { isReady } from '../lib/ui'

/**
 * First-run guide. Shown when userData has no `onboardingCompleted` flag and either this is a
 * brand-new install or no account is ready yet; re-openable from Settings → General.
 * People upgrading with a working setup never see it (the flag is set silently).
 */

let state: OnboardingState | null = null
let manual = false
const subs = new Set<() => void>()
const emit = () => subs.forEach((f) => f())

let loading: Promise<void> | null = null
const load = () =>
  (loading ??= window.agentswitch.onboarding.get().then((s) => {
    state = s
    emit()
  }))

export function openOnboarding(): void {
  manual = true
  emit()
}

export async function finishOnboarding(): Promise<void> {
  manual = false
  state = { completed: true, firstRun: state?.firstRun ?? false }
  emit()
  await window.agentswitch.onboarding.set(true)
}

export function useOnboarding(): boolean {
  const { loaded, profiles } = useApp()
  const [, force] = useState(0)
  useEffect(() => {
    const f = () => force((n) => n + 1)
    subs.add(f)
    void load()
    return () => void subs.delete(f)
  }, [])
  const anyReady = profiles.some(isReady)
  const upgradeSkip = !!state && !state.completed && !state.firstRun && loaded && anyReady
  useEffect(() => {
    if (upgradeSkip) void finishOnboarding()
  }, [upgradeSkip])
  if (manual) return true
  if (!state || !loaded || state.completed || upgradeSkip) return false
  return state.firstRun || !anyReady
}
