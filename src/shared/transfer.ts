import type { BundleSkipReason, Thread } from './chat'
import { toPosixPath } from './fileResolve'
import { KINDS, type ProfileKind } from './types'

export const TRANSFER_SCHEMA_VERSION = 2
export const TRANSFER_ARCHIVE_FORMAT = 'agentswitch-threads-archive'
export const LEGACY_BUNDLE_FORMAT = 'agentswitch-threads'
export const EXPORT_MAX_FILE_BYTES = 20 * 1024 * 1024

export interface TransferProjectMeta {
  name: string | null
  sourceProjectDir: string | null
}

export interface TransferSkippedEntry {
  threadId: string
  messageId: string
  name: string
  path: string | null
  reason: BundleSkipReason
}

export interface TransferManifest {
  format: typeof TRANSFER_ARCHIVE_FORMAT
  schemaVersion: typeof TRANSFER_SCHEMA_VERSION
  exportedAt: number
  appVersion: string
  projects: TransferProjectMeta[]
  attachments: {
    packedCount: number
    skippedCount: number
    skipped: TransferSkippedEntry[]
  }
}

export interface ExportedThread {
  thread: Thread
  projectName: string | null
  sourceProjectDir: string | null
  sourceWorkdir?: string | null
  driverKind: ProfileKind | null
}

/** Payload shared by standalone JSON exports and the archive's data.json. */
export interface ThreadBundle {
  format: typeof LEGACY_BUNDLE_FORMAT
  version: 1 | typeof TRANSFER_SCHEMA_VERSION
  exportedAt: number
  threads: ExportedThread[]
}

export interface ImportPreviewResult {
  filePath: string
  kind: 'zip' | 'json'
  manifest: TransferManifest | null
  bundle: ThreadBundle
}

export interface CommitImportRequest {
  filePath: string
  selectedThreadIds: string[]
  projectMap: Record<string, string | null>
}

export interface CommitImportResult {
  threads: ExportedThread[]
}

export function parseThreadBundle(raw: string): ThreadBundle {
  const bundle = JSON.parse(raw) as Partial<ThreadBundle> | null
  if (bundle?.format !== LEGACY_BUNDLE_FORMAT || (bundle.version !== 1 && bundle.version !== TRANSFER_SCHEMA_VERSION) ||
      !Array.isArray(bundle.threads)) throw new Error('invalid bundle')

  const threads: ExportedThread[] = []
  for (const item of bundle.threads) {
    const thread = item?.thread
    if (!thread || typeof thread.id !== 'string' || !Array.isArray(thread.messages)) continue
    const projectDir = typeof thread.projectDir === 'string' ? thread.projectDir : null
    const sourceProjectDir = typeof item.sourceProjectDir === 'string' ||
      (bundle.version === TRANSFER_SCHEMA_VERSION && item.sourceProjectDir === null)
      ? item.sourceProjectDir : projectDir
    const projectName = typeof item.projectName === 'string' && item.projectName
      ? item.projectName : toPosixPath(sourceProjectDir ?? '').split('/').filter(Boolean).pop() ?? null
    threads.push({
      thread, projectName, sourceProjectDir,
      ...(typeof item.sourceWorkdir === 'string' || item.sourceWorkdir === null ? { sourceWorkdir: item.sourceWorkdir } : {}),
      driverKind: item.driverKind && KINDS.includes(item.driverKind) ? item.driverKind : null
    })
  }
  const exportedAt = typeof bundle.exportedAt === 'number' || typeof bundle.exportedAt === 'string' ? Number(bundle.exportedAt) : 0
  return {
    format: LEGACY_BUNDLE_FORMAT,
    version: bundle.version,
    exportedAt: Number.isFinite(exportedAt) && exportedAt !== 0 ? exportedAt : Date.now(),
    threads
  }
}
