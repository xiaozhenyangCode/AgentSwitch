import { lstatSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

export const attachmentStoragePath = (userData: string): string => join(userData, 'attachments')

export function ensureAttachmentStorage(userData: string): string {
  const dir = attachmentStoragePath(userData)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  if (!lstatSync(dir).isDirectory()) throw new Error('Invalid attachment directory')
  return dir
}
