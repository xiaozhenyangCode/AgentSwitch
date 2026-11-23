import type { PermissionEvent, PermissionResolution } from '@shared/types'

export type PendingPermission = PermissionEvent & { resolved?: PermissionResolution; expired?: true }
export const isPendingPermission = (item: PendingPermission): boolean => !item.resolved && !item.expired

export function addPermission(list: PendingPermission[] | undefined, event: PermissionEvent): PendingPermission[] {
  return list?.some((item) => item.requestId === event.requestId) ? list : [...(list ?? []), event]
}

export function resolvePermission(list: PendingPermission[] | undefined, id: string, resolution: PermissionResolution): PendingPermission[] | undefined {
  if (!list?.some((item) => item.requestId === id)) return list
  return list.map((item) => item.requestId === id ? { ...item, resolved: resolution, expired: undefined } : item)
}

export function reconcilePermissions(
  saved: PendingPermission[] | undefined,
  pending: PermissionEvent[],
  running: boolean,
  received?: ReadonlyMap<string, PermissionResolution | null>
): PendingPermission[] | undefined {
  if (!saved?.length && (!running || !pending.length)) return saved
  const list = new Map(saved?.map((item) => [item.requestId, item]))
  const pendingIds = new Set<string>()
  if (running) {
    for (const event of pending) {
      pendingIds.add(event.requestId)
      if (!list.has(event.requestId)) list.set(event.requestId, event)
    }
  }
  return [...list.values()].map((item) => {
    const observed = received?.get(item.requestId)
    if (observed) return { ...item, resolved: observed, expired: undefined }
    if (!isPendingPermission(item) || (running && (pendingIds.has(item.requestId) || observed === null))) return item
    return { ...item, resolved: { outcome: 'cancelled', by: 'auto' } }
  })
}
