import { afterEach, expect, it, vi } from 'vitest'

afterEach(() => vi.unstubAllGlobals())

it.each([
  [{}, false],
  [{ showGitTools: 'true' }, false],
  [{ showGitTools: true }, true]
])('loads Git management from %j as %s', async (stored, expected) => {
  vi.resetModules()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => key === 'agentswitch.settings.v1' ? JSON.stringify(stored) : null
  })

  const { getSettings } = await import('./settings')
  expect(getSettings().showGitTools).toBe(expected)
})
