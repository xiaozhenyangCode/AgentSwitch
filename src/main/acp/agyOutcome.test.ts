import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProfileConfig } from '@shared/types'
import { agyOutcomeReader } from './agyOutcome'

vi.mock('electron', () => ({ app: { getPreferredSystemLanguages: () => ['en'] } }))
vi.mock('../legacy', () => ({ LEGACY_USER_DATA: '/unused' }))

describe('agy turn outcome', () => {
  let home: string
  let path: string
  let cfg: ProfileConfig
  const id = 'test-session'
  const log = vi.fn()
  const reader = () => agyOutcomeReader(cfg, id, log)

  function createDb(): DatabaseSync {
    const db = new DatabaseSync(path)
    db.exec('create table steps(idx integer primary key, step_type integer, step_payload blob)')
    return db
  }

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'agentswitch-acp-outcome-'))
    const conversations = join(home, '.gemini/antigravity-cli/conversations')
    mkdirSync(conversations, { recursive: true })
    path = join(conversations, id + '.db')
    cfg = { id: 'gemini-outcome-test', kind: 'gemini', name: 'Test', configDir: home, imported: false,
      loginCommand: 'agy', runCommand: 'agy', extraEnv: {}, defaultModel: '', autoApprove: 'cli', createdAt: 0 }
    log.mockClear()
  })

  afterEach(() => rmSync(home, { recursive: true, force: true }))

  it('ignores absent databases and invalid session IDs', () => {
    expect(reader().checkpoint()).toBe(-1)
    expect(reader().after(-1)).toBeNull()
    expect(agyOutcomeReader(cfg, '../bad', log).checkpoint()).toBeNull()
    expect(log).not.toHaveBeenCalled()
  })

  it('only considers the last step added after the checkpoint', () => {
    const db = createDb()
    try {
      const add = db.prepare('insert into steps values (?, ?, ?)')
      add.run(5, 17, Buffer.from('RESOURCE_EXHAUSTED'))
      const baseline = reader().checkpoint()
      expect(baseline).toBe(5)
      expect(reader().after(baseline)).toBeNull()
      add.run(6, 17, Buffer.from('RESOURCE_EXHAUSTED'))
      add.run(7, 15, Buffer.from('normal response'))
      expect(reader().after(baseline)).toBeNull()
    } finally {
      db.close()
    }
  })

  it.each([
    ['\0Error 429, Message: Too many requests, Status: RESOURCE_EXHAUSTED\x03 reason:QUOTA_EXHAUSTED quotaResetDelay:2m3.5s', 'Quota resets in about 124 seconds.'],
    ['RESOURCE_EXHAUSTED (code 403): capacity exceeded\nretryDelay:2500ms', 'Retry in about 3 seconds.'],
    ['HTTP 429 reason:QUOTA_EXHAUSTED quotaResetTimeStamp:2026-11-23T17:00:00Z', 'Quota resets at 2026-11-23T17:00:00.000Z.']
  ])('classifies quota failures and includes timing data', (payload, hint) => {
    const db = createDb()
    try {
      db.prepare('insert into steps values (?, ?, ?)').run(0, 17, Buffer.from(payload))
      expect(reader().after(-1)).toEqual({ error: expect.stringContaining(hint), rateLimited: true })
    } finally {
      db.close()
    }
  })

  it.each(['thinking.signature: Field required', 'Invalid `signature` in `thinking` block'])('reports unrecoverable thinking history', (payload) => {
    const db = createDb()
    try {
      db.prepare('insert into steps values (?, ?, ?)').run(0, 17, Buffer.from(payload))
      expect(reader().after(-1)).toEqual({ error: expect.stringContaining('Start a new conversation'), rateLimited: false })
    } finally {
      db.close()
    }
  })
})
