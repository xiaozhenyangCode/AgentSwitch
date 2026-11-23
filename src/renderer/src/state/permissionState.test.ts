import { describe, expect, it } from 'vitest'
import type { PermissionEvent, PermissionResolution } from '@shared/types'
import { addPermission, reconcilePermissions, resolvePermission } from './permissionState'

const event = (requestId: string): PermissionEvent => ({
  t: 'permission', requestId, kind: 'question', title: 'Pick a label', options: [], expiresAt: 1234
})
const answered: PermissionResolution = { outcome: 'selected', by: 'user', optionId: 'yes', label: 'Yes' }

describe('permission card state', () => {
  it('deduplicates events and merges a resolution into its own card', () => {
    const first = event('a')
    const second = event('b')
    const list = [first, second]
    expect(addPermission(list, first)).toBe(list)
    expect(resolvePermission(list, 'b', answered)).toEqual([first, { ...second, resolved: answered }])
    expect(resolvePermission(list, 'unknown', answered)).toBe(list)
  })

  it('restores pending cards for running steps and makes orphaned history read-only', () => {
    const active = event('active')
    const stale = event('stale')
    const missed = event('missed')
    const cancelled = { outcome: 'cancelled', by: 'auto' }
    expect(reconcilePermissions([active, stale], [active, missed], true, new Map())).toEqual([active, { ...stale, resolved: cancelled }, missed])
    expect(reconcilePermissions([active], [active], false, new Map())).toEqual([{ ...active, resolved: cancelled }])
  })

  it('keeps incoming events and resolutions newer than a reload snapshot', () => {
    const resolved = event('resolved-during-load')
    const fresh = event('arrived-during-load')
    const observed = new Map([[fresh.requestId, null], [resolved.requestId, answered]])
    expect(reconcilePermissions([fresh], [resolved], true, observed)).toEqual([fresh, { ...resolved, resolved: answered }])
  })
})
