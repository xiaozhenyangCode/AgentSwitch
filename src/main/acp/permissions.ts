import type { AgentEvent, PendingPermissionEntry, PermissionEvent, PermissionOption, PermissionResolution, StepRef } from '@shared/types'

export const PERMISSION_TIMEOUT = 5 * 60_000

export type PermissionReply = { outcome: { outcome: 'cancelled' } | { outcome: 'selected'; optionId: string } }
export const cancelledPermission = (): PermissionReply => ({ outcome: { outcome: 'cancelled' } })

interface Registration {
  ref?: StepRef
  connection: object
  turn: symbol
  event: PermissionEvent
  resolve: (reply: PermissionReply) => void
  emit: (event: Extract<AgentEvent, { t: 'permission_resolved' }>) => void
}

export class PermissionRegistry {
  private readonly entries = new Map<string, Registration & { timer: NodeJS.Timeout }>()

  register(entry: Registration): void {
    const { requestId, expiresAt } = entry.event
    if (this.entries.has(requestId)) throw new Error('Duplicate ACP permission request')
    const timer = setTimeout(() => this.expire(entry.event), Math.max(0, expiresAt - Date.now())).unref()
    this.entries.set(requestId, { ...entry, timer })
  }

  reply(requestId: string, optionId: string | null, by: PermissionResolution['by']): boolean {
    const entry = this.entries.get(requestId)
    if (!entry) return false
    if (Date.now() >= entry.event.expiresAt) {
      this.expire(entry.event)
      return false
    }
    if (optionId === null) return this.finish(requestId, 'cancelled', by)
    const option = entry.event.options.find((o) => o.id === optionId)
    return option ? this.finish(requestId, 'selected', by, option) : false
  }

  cancelAll(predicate: (entry: Registration) => boolean, outcome: 'cancelled' | 'timeout' = 'cancelled'): void {
    for (const [id, entry] of this.entries) {
      if (!predicate(entry)) continue
      if (outcome === 'timeout') this.expire(entry.event)
      else this.finish(id, outcome, 'auto')
    }
  }

  pending(): PendingPermissionEntry[] {
    return [...this.entries.values()].flatMap(({ ref, event }) => ref ? [{ ...ref, event }] : [])
  }

  private expire(event: PermissionEvent): void {
    const reject = event.kind === 'approval' ? event.options.find((o) => o.role === 'reject_once') : undefined
    this.finish(event.requestId, 'timeout', 'auto', reject)
  }

  private finish(id: string, outcome: PermissionResolution['outcome'], by: PermissionResolution['by'], option?: PermissionOption): boolean {
    const entry = this.entries.get(id)
    if (!entry) return false
    this.entries.delete(id)
    clearTimeout(entry.timer)
    entry.resolve(option ? { outcome: { outcome: 'selected', optionId: option.id } } : cancelledPermission())
    entry.emit({ t: 'permission_resolved', requestId: id, outcome, by, ...(option && { optionId: option.id, label: option.label }) })
    return true
  }
}

export const permissions = new PermissionRegistry()
