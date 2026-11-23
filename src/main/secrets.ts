/**
 * API keys for API-key accounts. Encrypted with Electron safeStorage (macOS: a Keychain-held key),
 * stored as `{ [profileId]: base64 }` in userData/secrets.json (mode 0600). Plaintext never touches disk;
 * keys never leave the main process.
 */
import { app, safeStorage } from 'electron'
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export interface Cipher {
  available(): boolean
  encrypt(plain: string): Buffer
  decrypt(data: Buffer): string
}

export interface SecretStore {
  set(id: string, key: string): void
  get(id: string): string | null
  has(id: string): boolean
  remove(id: string): void
}

export function createSecretStore(file: string, cipher: Cipher): SecretStore {
  const read = (): Record<string, string> => {
    try {
      const j: unknown = JSON.parse(readFileSync(file, 'utf8'))
      return j && typeof j === 'object' && !Array.isArray(j) ? (j as Record<string, string>) : {}
    } catch {
      return {} // missing or corrupt: no keys
    }
  }
  const write = (data: Record<string, string>): void => {
    const tmp = `${file}.tmp`
    writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 })
    renameSync(tmp, file)
  }
  const get = (id: string): string | null => {
    const enc = read()[id]
    if (typeof enc !== 'string') return null
    try {
      return cipher.decrypt(Buffer.from(enc, 'base64')) || null
    } catch {
      return null // e.g. encrypted by another build / keychain item reset
    }
  }
  return {
    set(id, key) {
      const k = key.trim()
      if (!k) throw new Error('apikey.empty')
      if (!cipher.available()) throw new Error('apikey.noKeychain')
      write({ ...read(), [id]: cipher.encrypt(k).toString('base64') })
    },
    get,
    has: (id) => get(id) !== null,
    remove(id) {
      const data = read()
      if (!(id in data)) return
      delete data[id]
      write(data)
    }
  }
}

let store: SecretStore | null = null
/** The app's secret store (userData/secrets.json + safeStorage). */
export function secrets(): SecretStore {
  store ??= createSecretStore(join(app.getPath('userData'), 'secrets.json'), {
    available: () => safeStorage.isEncryptionAvailable(),
    encrypt: (s) => safeStorage.encryptString(s),
    decrypt: (b) => safeStorage.decryptString(b)
  })
  return store
}
