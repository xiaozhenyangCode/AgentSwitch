import { describe, expect, it, vi } from 'vitest'
import type { ModelList, ProfileKind } from '@shared/types'
import { createCliUpdateHandler, type CliUpdateDeps } from './cliUpdate'

function setup() {
  const deps = {
    invalidateCliPathCache: vi.fn<CliUpdateDeps['invalidateCliPathCache']>(),
    invalidateCliVersionCache: vi.fn<CliUpdateDeps['invalidateCliVersionCache']>(),
    kindBinaryPath: vi.fn((kind: ProfileKind) => `/bin/${kind}`),
    probeCliVersion: vi.fn<CliUpdateDeps['probeCliVersion']>().mockResolvedValue('1.2.3'),
    retireAgyAcpOnCliUpdate: vi.fn(() => ({ retired: 1, deferred: 0 })),
    listProfiles: vi.fn<CliUpdateDeps['listProfiles']>().mockReturnValue([
      { kind: 'claude', id: 'claude-1' },
      { kind: 'codex', id: 'codex-1' },
      { kind: 'gemini', id: 'gemini-1' }
    ]),
    isProfileRunning: vi.fn((id: string) => id === 'codex-1'),
    forgetModelsByKind: vi.fn((kind: ProfileKind) => [`${kind}-1`]),
    refreshModelsByKind: vi.fn<CliUpdateDeps['refreshModelsByKind']>().mockResolvedValue([]),
    broadcastState: vi.fn<CliUpdateDeps['broadcastState']>(),
    broadcastCliUpdated: vi.fn<CliUpdateDeps['broadcastCliUpdated']>()
  }
  return { deps, onCliUpdated: createCliUpdateHandler(deps) }
}

describe('CLI update completion', () => {
  it.each([
    { kind: 'claude', hasRunningTasks: false },
    { kind: 'codex', hasRunningTasks: true },
    { kind: 'gemini', hasRunningTasks: false }
  ] as const)('invalidates and refreshes $kind, then broadcasts the new state', async ({ kind, hasRunningTasks }) => {
    const { deps, onCliUpdated } = setup()
    // Catalog refresh stays in flight when the event is published.
    deps.refreshModelsByKind.mockReturnValue(new Promise<ModelList[]>((resolve) => {
      deps.broadcastCliUpdated.mockImplementationOnce(() => resolve([]))
    }))
    const event = await onCliUpdated(kind)
    expect(event).toEqual({
      kind, version: '1.2.3', binaryPath: `/bin/${kind}`, hasRunningTasks,
      source: 'update', updatedAt: expect.any(Number), affectedProfileIds: [`${kind}-1`]
    })
    expect(deps.invalidateCliPathCache).toHaveBeenCalledTimes(1)
    expect(deps.invalidateCliVersionCache).toHaveBeenCalledExactlyOnceWith(kind)
    expect(deps.probeCliVersion).toHaveBeenCalledExactlyOnceWith(kind)
    expect(deps.retireAgyAcpOnCliUpdate).toHaveBeenCalledTimes(kind === 'gemini' ? 1 : 0)
    expect(deps.isProfileRunning).toHaveBeenCalledExactlyOnceWith(`${kind}-1`)
    expect(deps.forgetModelsByKind).toHaveBeenCalledExactlyOnceWith(kind)
    expect(deps.refreshModelsByKind).toHaveBeenCalledExactlyOnceWith(kind)
    expect(deps.broadcastState).toHaveBeenCalledTimes(1)
    expect(deps.broadcastState).toHaveBeenCalledBefore(deps.broadcastCliUpdated)
    expect(deps.refreshModelsByKind).toHaveBeenCalledBefore(deps.broadcastCliUpdated)
    expect(deps.broadcastCliUpdated).toHaveBeenCalledExactlyOnceWith(event)
  })

  it('reports deferred ACP turns even when no account is currently marked running', async () => {
    const { deps, onCliUpdated } = setup()
    deps.listProfiles.mockReturnValue([])
    deps.retireAgyAcpOnCliUpdate.mockReturnValue({ retired: 0, deferred: 1 })
    await expect(onCliUpdated('gemini', { source: 'install' })).resolves.toMatchObject({
      hasRunningTasks: true, source: 'install'
    })
  })

  it('continues cleanup and reports the event after individual steps fail', async () => {
    const { deps, onCliUpdated } = setup()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const fail = () => { throw new Error('failed') }
    deps.invalidateCliPathCache.mockImplementation(fail)
    deps.probeCliVersion.mockRejectedValue(new Error('version unavailable'))
    deps.retireAgyAcpOnCliUpdate.mockImplementation(fail)
    deps.forgetModelsByKind.mockImplementation(fail)
    deps.refreshModelsByKind.mockRejectedValue(new Error('catalog unavailable'))
    deps.broadcastState.mockImplementation(fail)
    try {
      const event = await onCliUpdated('gemini', { source: 'config' })
      expect(event).toMatchObject({ version: null, source: 'config', affectedProfileIds: [] })
      expect(deps.invalidateCliVersionCache).toHaveBeenCalledWith('gemini')
      expect(deps.refreshModelsByKind).toHaveBeenCalledWith('gemini')
      expect(deps.broadcastCliUpdated).toHaveBeenCalledWith(event)
      expect(warn).toHaveBeenCalledTimes(6)
    } finally {
      warn.mockRestore()
    }
  })

  it('coalesces one follow-up per engine and lets other engines continue', async () => {
    const { deps, onCliUpdated } = setup()
    let completeProbe!: (version: string) => void
    deps.probeCliVersion.mockImplementationOnce(() => new Promise((resolve) => { completeProbe = resolve }))
    const first = onCliUpdated('gemini', { source: 'install' })
    const followUp = onCliUpdated('gemini', { source: 'config' })
    expect(onCliUpdated('gemini', { source: 'update' })).toBe(followUp)
    expect(onCliUpdated('gemini', { source: 'install' })).toBe(followUp)
    await expect(onCliUpdated('claude')).resolves.toMatchObject({ kind: 'claude' })
    expect(deps.probeCliVersion.mock.calls).toEqual([['gemini'], ['claude']])
    expect(deps.retireAgyAcpOnCliUpdate).toHaveBeenCalledTimes(1)
    completeProbe('1.2.2')
    await expect(first).resolves.toMatchObject({ kind: 'gemini', source: 'install', version: '1.2.2' })
    await expect(followUp).resolves.toMatchObject({ kind: 'gemini', source: 'update', version: '1.2.3' })
    expect(deps.probeCliVersion.mock.calls).toEqual([['gemini'], ['claude'], ['gemini']])
  })
})
