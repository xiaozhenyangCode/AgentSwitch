import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import type { TransferProgressEvent } from '@shared/transfer'
import { useLayer } from '../lib/escStack'
import { t } from '../state/i18n'
import { IconFolder, IconX } from './icons'

export function TransferProgressModal({ progress, onClose }: { progress: TransferProgressEvent; onClose: () => void }) {
  const { phase, type, current, total, percent, result, error } = progress
  const success = phase === 'success'
  const failed = phase === 'error'
  const running = !success && !failed
  const determinate = success || phase === 'processing' || phase === 'importing'
  const isExport = type === 'export'
  const exported = result && 'path' in result ? result : null
  const imported = result && 'filePath' in result ? result : null
  const dialog = useRef<HTMLDialogElement>(null)
  const doneButton = useRef<HTMLButtonElement>(null)
  useLayer({ onEsc: running ? null : onClose, onClose: running ? null : onClose })

  useEffect(() => {
    const node = dialog.current
    if (!node) return
    node.showModal()
    return () => node.close()
  }, [])

  useEffect(() => {
    if (!running) doneButton.current?.focus()
  }, [running])

  const title = failed ? t(isExport ? 'xfer.exportFailed' : 'xfer.importFailed')
    : exported ? t('xfer.exportDone', { n: exported.exportedCount })
    : imported ? t('xfer.importDone', { added: imported.addedCount ?? 0, replaced: imported.replacedCount ?? 0 })
    : t(isExport ? 'xfer.exportRunning' : 'xfer.importRunning')
  const stage = phase !== 'success' && phase !== 'error' ? t(`xfer.${phase}`) : undefined

  return createPortal(
    <dialog
      ref={dialog}
      aria-labelledby="transfer-progress-title"
      aria-describedby={failed ? 'transfer-error' : undefined}
      onCancel={(event) => {
        event.preventDefault()
        if (!running) onClose()
      }}
      onClick={(event) => {
        if (!running && event.target === event.currentTarget) {
          const rect = event.currentTarget.getBoundingClientRect()
          if (event.clientX < rect.left || event.clientX > rect.right ||
              event.clientY < rect.top || event.clientY > rect.bottom) onClose()
        }
      }}
      className="no-drag sheet-in fixed inset-0 z-[70] m-auto w-[440px] max-w-[92vw] rounded-xl border border-editor-hairline bg-elevated p-0 text-ink shadow-[0_24px_64px_rgba(0,0,0,0.18)] backdrop:bg-(--scrim-soft)"
    >
      <div className="space-y-4 p-5">
        <div className="flex items-start justify-between gap-3">
          <h2 id="transfer-progress-title" autoFocus={running} tabIndex={-1} className="text-[15px] font-semibold outline-none">{title}</h2>
          {!running && (
            <button type="button" onClick={onClose} aria-label={t('common.close')} className="-mt-1 grid size-7 shrink-0 place-items-center rounded-lg text-ink-3 hover:bg-fill hover:text-ink">
              <IconX size={14} />
            </button>
          )}
        </div>
        {!failed && (
          <>
            {stage && <div role="status" className="text-[13px] text-ink-2">{stage}</div>}
            <div
              role="progressbar"
              aria-label={stage ?? title}
              aria-valuenow={determinate ? percent : undefined}
              className="h-2 overflow-hidden rounded-full bg-fill"
            >
              <div
                className={determinate ? 'h-full rounded-full bg-accent transition-[width] duration-300 motion-reduce:transition-none' : 'xfer-indeterminate h-full w-1/3 rounded-full bg-accent'}
                style={determinate ? { width: `${percent}%` } : undefined}
              />
            </div>
          </>
        )}
        {running && (
          <>
            {total > 0 && <p className="text-[13px] tabular-nums text-ink-2">{t('xfer.progressCount', { current, total, percent })}</p>}
            <p className="text-[12px] text-ink-3">{t('xfer.keepOpen')}</p>
          </>
        )}
        {exported && exported.manifest.attachments.skippedCount > 0 && (
          <p className="text-[13px] text-ink-2">{t('xfer.exportSkipped', { n: exported.manifest.attachments.skippedCount })}</p>
        )}
        {imported && <p className="text-[13px] text-ink-2">{t('xfer.importSkipped', { n: imported.skippedCount ?? 0 })}</p>}
        {failed && <p id="transfer-error" role="alert" className="max-h-[35vh] overflow-auto text-[13px] break-words text-ink-2 select-text">{error}</p>}
        {!running && (
          <div className="flex flex-wrap justify-end gap-2">
            {exported && (
              <button type="button" onClick={() => void window.agentswitch.sys.showInFolder(exported.path).catch(console.error)} className="inline-flex h-8 items-center gap-1.5 rounded-lg px-3 text-[13px] text-ink-2 hover:bg-fill">
                <IconFolder size={14} /> {t('common.showInFinder')}
              </button>
            )}
            <button ref={doneButton} type="button" onClick={onClose} className="h-8 rounded-lg bg-accent px-4 text-[13px] font-semibold text-white hover:brightness-110">
              {success ? t('xfer.done') : t('common.close')}
            </button>
          </div>
        )}
      </div>
    </dialog>,
    document.body
  )
}
