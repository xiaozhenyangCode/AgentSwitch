import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import type { CommitImportRequest, TransferType } from '@shared/transfer'
import { allowRoot } from './fileProtocol'
import { t } from './i18n'
import {
  commitThreadsImport as commitImport, commitThreadsImportAsync as commitImportAsync, type BatchOptions, type TransferUpdate
} from './threadTransferCore'
import type { TransferJob, TransferJobs, TransferWorkerMessage } from './threadTransferWorker'

export { exportThreadsArchive, exportThreadsArchiveAsync, inspectThreadsImport, inspectThreadsImportAsync } from './threadTransferCore'

export function commitThreadsImport(request: CommitImportRequest, opts: { userData: string }) {
  return commitImport(request, { ...opts, allowRoot })
}

export function commitThreadsImportAsync(request: CommitImportRequest, opts: { userData: string } & BatchOptions) {
  return commitImportAsync(request, { ...opts, allowRoot })
}

let activeTransfer: TransferType | null = null

export const isThreadTransferring = (): boolean => activeTransfer !== null
export const getActiveTransferType = (): TransferType | null => activeTransfer

export async function runTransferExclusive<T>(type: TransferType, fn: () => Promise<T>): Promise<T> {
  if (isThreadTransferring()) throw new Error(t('xfer.alreadyRunning'))
  activeTransfer = type
  try {
    return await fn()
  } finally {
    activeTransfer = null
  }
}

export function describeTransferError(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | null)?.code
  if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') return t('xfer.permissionDenied')
  if (code === 'ENOSPC' || code === 'EDQUOT') return t('xfer.diskFull')
  if (code === 'ENOENT') return t('xfer.fileMissing')
  if (code === 'EISDIR' || code === 'ENOTDIR') return t('xfer.invalidLocation')
  if (code === 'INVALID_JSON') return t('xfer.invalidJson')
  const message = error instanceof Error ? error.message : String(error)
  if (/^(invalid bundle|invalid thread archive (manifest|data version))$/i.test(message)) return t('xfer.invalidFormat')
  return message
}

export function runTransferWorker<K extends keyof TransferJobs>(
  job: TransferJob & { job: K }, onProgress: (progress: TransferUpdate) => void
): Promise<TransferJobs[K]['result']> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(join(__dirname, 'threadTransferWorker.js'), { workerData: job })
    worker.on('message', (message: TransferWorkerMessage) => {
      if ('progress' in message) onProgress(message.progress)
      else if ('result' in message) resolve(message.result as TransferJobs[K]['result'])
      else reject(Object.assign(new Error(message.error), { code: message.code }))
    })
    worker.once('messageerror', reject)
    worker.once('error', reject)
    worker.once('exit', (code) => reject(new Error(t('xfer.workerStopped', { code }))))
  })
}
