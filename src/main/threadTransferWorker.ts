import { realpathSync } from 'node:fs'
import { isAbsolute, join, sep } from 'node:path'
import { parentPort, workerData } from 'node:worker_threads'
import type { CommitImportRequest, CommitImportResult, ImportPreviewResult, ThreadBundle, TransferManifest } from '@shared/transfer'
import { attachmentStoragePath } from './attachmentStorage'
import { ChatStore } from './chatStore'
import { commitThreadsImportAsync, exportThreadsArchiveAsync, inspectThreadsImportAsync, type TransferUpdate } from './threadTransferCore'

interface FileAccess {
  roots: string[]
  files: string[]
}

export interface TransferJobs {
  export: {
    input: { bundle: ThreadBundle; path: string; userData: string; stageDir: string; appVersion: string; access: FileAccess; tempSuffix: string }
    result: TransferManifest
  }
  preview: { input: { path: string }; result: ImportPreviewResult }
  import: { input: { request: CommitImportRequest; userData: string; access: FileAccess }; result: CommitImportResult & { roots: string[] } }
}

export type TransferJob = { [K in keyof TransferJobs]: TransferJobs[K]['input'] & { job: K } }[keyof TransferJobs]
export type TransferWorkerMessage =
  | { progress: TransferUpdate }
  | { result: TransferJobs[keyof TransferJobs]['result'] }
  | { error: string; code?: string }

function canonical(path: string | null): string | null {
  if (!path || !isAbsolute(path)) return null
  try { return realpathSync(path) } catch { return null }
}

function canRead({ roots, files }: FileAccess): (real: string) => boolean {
  const allowedFiles = new Set(files)
  const prefixes = roots.map((root) => root.endsWith(sep) ? root : root + sep)
  return (real) => allowedFiles.has(real) || roots.includes(real) || prefixes.some((prefix) => real.startsWith(prefix))
}

async function run(job: TransferJob, onProgress: (progress: TransferUpdate) => void) {
  if (job.job === 'preview') return inspectThreadsImportAsync(job.path, { onProgress })
  const threads = new ChatStore(job.userData)
  if (job.job === 'export') {
    onProgress({ phase: 'preparing', current: 0, total: job.bundle?.threads?.length ?? 0, percent: 0 })
    const candidates = new Set([
      attachmentStoragePath(job.userData), job.stageDir, join(job.userData, 'workspaces'),
      ...threads.load().threads.flatMap((thread) => [thread.projectDir, thread.workdir])
    ])
    const roots = [...job.access.roots]
    for (const path of candidates) {
      const real = canonical(path)
      if (real) roots.push(real)
    }
    return exportThreadsArchiveAsync(job.bundle, job.path, {
      userData: job.userData, appVersion: job.appVersion, tempSuffix: job.tempSuffix,
      canReadFile: canRead({ roots, files: job.access.files }), onProgress
    })
  }
  onProgress({ phase: 'validating', current: 0, total: 0, percent: 0 })
  const known = new Set(threads.load().threads.map((thread) => thread.projectDir))
  const canReadPath = canRead(job.access)
  const projectMap = Object.fromEntries(Object.entries(job.request.projectMap).filter(([, path]) => {
    if (typeof path !== 'string') return false
    if (known.has(path)) return true
    const real = canonical(path)
    return real !== null && canReadPath(real)
  }))
  const roots: string[] = []
  const result = await commitThreadsImportAsync({ ...job.request, projectMap }, {
    userData: job.userData, onProgress, allowRoot: (path) => roots.push(path)
  })
  return { ...result, roots }
}

if (parentPort) {
  const port = parentPort
  void run(workerData as TransferJob, (progress) => port.postMessage({ progress } satisfies TransferWorkerMessage)).then(
    (result) => port.postMessage({ result } satisfies TransferWorkerMessage),
    (error: unknown) => {
      port.postMessage({
        error: error instanceof Error ? error.message : String(error),
        code: error instanceof SyntaxError ? 'INVALID_JSON' : (error as NodeJS.ErrnoException | null)?.code
      } satisfies TransferWorkerMessage)
    }
  )
}
