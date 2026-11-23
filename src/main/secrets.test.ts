import { mkdtempSync, readFileSync, rmSync, statSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createSecretStore, type Cipher } from './secrets'

/** Reversible stand-in for safeStorage: reverses the bytes so plaintext never appears verbatim. */
const fakeCipher = (available = true): Cipher => ({
  available: () => available,
  encrypt: (s) => Buffer.from('ENC:' + [...s].reverse().join('')),
  decrypt: (b) => {
    const t = b.toString()
    if (!t.startsWith('ENC:')) throw new Error('bad ciphertext')
    return [...t.slice(4)].reverse().join('')
  }
})

let dir: string
let file: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'asw-secrets-'))
  file = join(dir, 'secrets.json')
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('createSecretStore', () => {
  it('round-trips a key and trims it (Review Focus 1)', () => {
    const s = createSecretStore(file, fakeCipher())
    s.set('a', '  sk-123  \n')
    expect(s.get('a')).toBe('sk-123')
    expect(s.has('a')).toBe(true)
    // a fresh store reads what the first one wrote
    expect(createSecretStore(file, fakeCipher()).get('a')).toBe('sk-123')
  })

  it('rejects a whitespace-only key', () => {
    const s = createSecretStore(file, fakeCipher())
    expect(() => s.set('a', ' \n\t')).toThrow('apikey.empty')
    expect(existsSync(file)).toBe(false)
  })

  it('never writes plaintext and keeps the file private', () => {
    const s = createSecretStore(file, fakeCipher())
    s.set('a', 'sk-plain-marker')
    expect(readFileSync(file, 'utf8')).not.toContain('sk-plain-marker')
    expect(statSync(file).mode & 0o777).toBe(0o600)
  })

  it('remove deletes the entry and keeps others', () => {
    const s = createSecretStore(file, fakeCipher())
    s.set('a', 'k1')
    s.set('b', 'k2')
    s.remove('a')
    expect(s.has('a')).toBe(false)
    expect(s.get('b')).toBe('k2')
  })

  it('refuses to save without a keychain (Review Focus 4)', () => {
    const s = createSecretStore(file, fakeCipher(false))
    expect(() => s.set('a', 'sk-x')).toThrow('apikey.noKeychain')
    expect(existsSync(file)).toBe(false)
  })

  it('reads a corrupt file as empty (Review Focus 4)', () => {
    writeFileSync(file, '{not json')
    const s = createSecretStore(file, fakeCipher())
    expect(s.get('a')).toBeNull()
    expect(s.has('a')).toBe(false)
  })

  it('reads an undecryptable entry as null', () => {
    writeFileSync(file, JSON.stringify({ a: Buffer.from('garbage').toString('base64') }))
    expect(createSecretStore(file, fakeCipher()).get('a')).toBeNull()
  })
})
