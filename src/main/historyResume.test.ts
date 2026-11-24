import { describe, expect, it } from 'vitest'
import type { TranscriptEntry } from '@shared/transcript'
import { KINDS } from '@shared/types'
import { getProviderCapabilities, shouldUnbindSessionsOnRewind } from '@shared/providerCapabilities'
import { bindNativeSession, canResume, clearActiveSessions, nativeSessionEntries, recordUnconfirmedSession, type NativeSessions } from './historyResume'
import { supportsThreadHistory } from './threadHistoryConfig'

const state: NativeSessions = { sessions: { a: 'session-a', b: 'session-b' }, models: { a: 'small' } }
const reply: TranscriptEntry = {
  id: 'reply', turnId: 'turn', profileId: 'b', speaker: 'B', time: null, text: 'reply', replied: true, model: 'large'
}

describe('history resume', () => {
  it('resumes the same base model, including a different reasoning level', () => {
    expect(canResume(state, 'a', 'codex', 'small:high', [], false)).toBe('session-a')
  })

  it('starts fresh when the model changes or the driver takes over from another account', () => {
    expect(canResume(state, 'a', 'codex', 'large', [], false)).toBeNull()
    expect(canResume(state, 'a', 'codex', 'small', [], true)).toBeNull()
    expect(canResume(state, 'unseen', 'codex', 'small', [], false)).toBeNull()
  })

  it('checks historical replies for legacy sessions and keeps intentionally imported CLI sessions', () => {
    expect(canResume(state, 'b', 'codex', 'large', [reply], false)).toBe('session-b')
    expect(canResume(state, 'b', 'codex', 'small', [reply], false)).toBeNull()
    expect(canResume({ ...state, imported: ['session-b'] }, 'b', 'codex', null, [reply], false)).toBe('session-b')
    expect(canResume({ sessions: { a: 'shared', b: 'shared' } }, 'a', 'codex', 'large', [reply], false)).toBeNull()
  })
})

it('keeps replaced native sessions associated with the thread without offering them for resume', () => {
  const switched = bindNativeSession(state, 'a', 'session-c', { model: 'large' })
  expect(nativeSessionEntries(switched)).toEqual([['a', 'session-c'], ['b', 'session-b'], ['a', 'session-a']])
  const imported = bindNativeSession(switched, 'b', 'session-d', { scope: 'portable-copy', model: 'large' })
  expect(imported.sessions).toEqual({ b: 'session-d' })
  expect(imported.scope).toBe('portable-copy')
  expect(nativeSessionEntries(imported)).toEqual([['b', 'session-d'], ['a', 'session-c'], ['b', 'session-b'], ['a', 'session-a']])
})


it('records an unconfirmed session only for bookkeeping and invalidates existing aliases for that ID', () => {
  const shared: NativeSessions = { ...state, sessions: { ...state.sessions, peer: 'session-a' } }
  const firstFailure = recordUnconfirmedSession(shared, 'a', 'new-failed-session')
  expect(canResume(firstFailure, 'a', 'codex', 'small', [], false)).toBe('session-a')
  expect(nativeSessionEntries(firstFailure)).toContainEqual(['a', 'new-failed-session'])
  expect(recordUnconfirmedSession(firstFailure, 'a', 'new-failed-session')).toEqual(firstFailure)

  const resumeFailure = recordUnconfirmedSession(firstFailure, 'a', 'session-a')
  expect(canResume(resumeFailure, 'a', 'codex', 'small', [], false)).toBeNull()
  expect(canResume(resumeFailure, 'peer', 'codex', 'small', [], false)).toBeNull()
  expect(nativeSessionEntries(resumeFailure)).toEqual([
    ['b', 'session-b'], ['a', 'session-a'], ['peer', 'session-a'], ['a', 'new-failed-session']
  ])
})

it('unbinds all active sessions on rewind while retaining them in priorSessions for bookkeeping', () => {
  const cleared = clearActiveSessions(state)
  expect(cleared.sessions).toEqual({})
  expect(cleared.models).toEqual({})
  expect(canResume(cleared, 'a', 'codex', 'small', [], false)).toBeNull()
  expect(canResume(cleared, 'b', 'codex', 'large', [reply], false)).toBeNull()
  expect(nativeSessionEntries(cleared)).toEqual([
    ['a', 'session-a'],
    ['b', 'session-b']
  ])

  // Capability-driven selective unbinding: preserves accounts whose predicate returns false
  const partial = clearActiveSessions(state, (id) => id !== 'b')
  expect(partial.sessions).toEqual({ b: 'session-b' })
  expect(partial.priorSessions).toEqual([['a', 'session-a']])

  // Main-process thread history MCP injection & rewind unbind stay strictly aligned with capability table
  for (const kind of KINDS) {
    expect(supportsThreadHistory(kind)).toBe(getProviderCapabilities(kind).supportsMcpTempInjection)
    expect(shouldUnbindSessionsOnRewind(kind)).toBe(!getProviderCapabilities(kind).supportsNativeRewind)
  }
})
