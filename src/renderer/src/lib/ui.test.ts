import { describe, expect, it, vi } from 'vitest'
import type { ProfileState, ProfileStatus } from '@shared/types'

vi.mock('../state/i18n', () => ({ t: (key: string) => key }))

import { accountBadge, isReady, isSignedIn } from './ui'

function makeProfile(status: ProfileStatus): ProfileState {
  return {
    id: `p-${status}`,
    kind: 'claude',
    name: `Account (${status})`,
    configDir: '~/.claude',
    imported: false,
    loginCommand: '',
    runCommand: '',
    extraEnv: {},
    defaultModel: '',
    autoApprove: 'cli',
    createdAt: 1,
    status,
    binaryPath: status === 'uninstalled' ? null : '/usr/local/bin/claude',
    loggedIn: status !== 'uninstalled' && status !== 'not_logged_in',
    resolvedConfigDir: '/tmp/.claude',
    sessionStoreKey: '/tmp/.claude',
    sessionMode: status === 'running' ? 'run' : null,
    installing: false
  }
}

describe('profile status helpers', () => {
  it('treats idle and running as ready, and includes rate_limited in signed-in accounts', () => {
    expect(isReady(undefined)).toBe(false)
    expect(isSignedIn(undefined)).toBe(false)

    const cases: [ProfileStatus, boolean, boolean][] = [
      ['idle', true, true],
      ['running', true, true],
      ['rate_limited', false, true],
      ['not_logged_in', false, false],
      ['uninstalled', false, false]
    ]

    for (const [status, ready, signedIn] of cases) {
      const p = makeProfile(status)
      expect(isReady(p)).toBe(ready)
      expect(isSignedIn(p)).toBe(signedIn)
    }
  })

  it('maps rate_limited and uninstalled to distinct status badge labels', () => {
    expect(accountBadge(makeProfile('rate_limited')).label).toBe('status.rateLimited')
    expect(accountBadge(makeProfile('not_logged_in')).label).toBe('status.notLoggedIn')
    expect(accountBadge(makeProfile('uninstalled')).label).toBe('status.uninstalled')
  })
})
