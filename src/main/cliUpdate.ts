import type { CliUpdatedEvent, CliUpdateSource, ModelList, ProfileId, ProfileKind } from '@shared/types'
import type { AcpRetireSummary } from './acp/pool'

export interface CliUpdateMeta {
  source?: CliUpdateSource
}

export interface CliUpdateDeps {
  invalidateCliPathCache: () => void
  invalidateCliVersionCache: (kind: ProfileKind) => void
  kindBinaryPath: (kind: ProfileKind) => string | null
  probeCliVersion: (kind: ProfileKind) => Promise<string | null>
  retireAgyAcpOnCliUpdate: () => AcpRetireSummary
  listProfiles: () => readonly { kind: ProfileKind; id: ProfileId }[]
  isProfileRunning: (id: ProfileId) => boolean
  forgetModelsByKind: (kind: ProfileKind) => ProfileId[]
  refreshModelsByKind: (kind: ProfileKind) => Promise<ModelList[]>
  broadcastState: () => void
  broadcastCliUpdated: (event: CliUpdatedEvent) => void
}

interface PendingUpdate {
  source: CliUpdateSource
  request: Promise<CliUpdatedEvent>
}

export function createCliUpdateHandler(deps: CliUpdateDeps): (engineKind: ProfileKind, meta?: CliUpdateMeta) => Promise<CliUpdatedEvent> {
  const running = new Map<ProfileKind, Promise<CliUpdatedEvent>>()
  const queued = new Map<ProfileKind, PendingUpdate>()

  async function finish(kind: ProfileKind, source: CliUpdateSource): Promise<CliUpdatedEvent> {
    const warn = (step: string, error: unknown) => console.warn(`[${kind}] CLI update: ${step}`, error)
    const attempt = <T>(step: string, run: () => T): T | undefined => {
      try {
        return run()
      } catch (error) {
        warn(step, error)
      }
    }

    attempt('refresh paths', deps.invalidateCliPathCache)
    attempt('invalidate version', () => deps.invalidateCliVersionCache(kind))
    const binaryPath = attempt('resolve binary', () => deps.kindBinaryPath(kind)) ?? null
    const versionRequest = attempt('probe version', () => deps.probeCliVersion(kind).catch((error) => {
      warn('probe version', error)
      return null
    }))

    // Fence off old connections and caches while the version probe is still running.
    const retirement = kind === 'gemini' ? attempt('retire ACP pool', deps.retireAgyAcpOnCliUpdate) : undefined
    const hasRunningTasks = (retirement?.deferred ?? 0) > 0 || (attempt('check running tasks', () =>
      deps.listProfiles().some((p) => p.kind === kind &&
        attempt('check account activity', () => deps.isProfileRunning(p.id))
      )
    ) ?? false)
    const affectedProfileIds = attempt('invalidate models', () => deps.forgetModelsByKind(kind)) ?? []
    attempt('refresh models', () => {
      void deps.refreshModelsByKind(kind).catch((error) => warn('refresh models', error))
    })

    const version = (await versionRequest) ?? null
    const event: CliUpdatedEvent = { kind, version, binaryPath, hasRunningTasks, source, updatedAt: Date.now(), affectedProfileIds }
    attempt('broadcast state', deps.broadcastState)
    attempt('broadcast update', () => deps.broadcastCliUpdated(event))
    return event
  }

  return (kind, { source = 'update' } = {}) => {
    const previous = running.get(kind)
    if (!previous) {
      const request = Promise.resolve().then(() => finish(kind, source)).finally(() => {
        if (running.get(kind) === request) running.delete(kind)
      })
      running.set(kind, request)
      return request
    }

    const pending = queued.get(kind)
    if (pending) {
      if (source === 'update' || (source === 'install' && pending.source === 'config')) pending.source = source
      return pending.request
    }

    const next: PendingUpdate = {
      source,
      request: previous.then(() => {
        queued.delete(kind)
        return finish(kind, next.source)
      }).finally(() => {
        if (running.get(kind) === next.request) running.delete(kind)
      })
    }
    queued.set(kind, next)
    running.set(kind, next.request)
    return next.request
  }
}
