import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import type { AttachmentText } from '@shared/types'
import type { Attachment } from '../state/chat'
import { useEscape } from '../lib/escStack'
import { fileUrl } from '../lib/fileUrl'
import { t } from '../state/i18n'
import { IconExternal, IconFile, IconFolder, IconX } from './icons'

const fmtBytes = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`)

const darkBtn = 'flex items-center gap-1.5 rounded-full bg-white/15 px-3 py-1 text-[13px] text-white/90 hover:bg-white/25'
const lightBtn = 'flex h-7 items-center gap-1.5 rounded-lg px-2.5 text-[12.5px] text-ink-2 hover:bg-black/[0.06] hover:text-ink'

/**
 * A user attachment opened from its bubble: images as a lightbox (the original file, or the
 * stored thumbnail when it was moved or cleaned up), other files as a read-only text preview
 * (64 KB) or, for binaries, open-with-app / show-in-Finder. Esc or a click on the scrim closes.
 */
export function AttachmentViewer({ a, onClose }: { a: Attachment; onClose: () => void }) {
  useEscape(onClose)
  const open = () => a.path && void window.agentswitch.sys.openPath(a.path).catch(() => {})
  const reveal = () => a.path && void window.agentswitch.sys.showInFolder(a.path)
  return createPortal(a.isImage ? <ImageView a={a} onClose={onClose} open={open} reveal={reveal} /> : <TextView a={a} onClose={onClose} open={open} reveal={reveal} />, document.body)
}

type ViewProps = { a: Attachment; onClose: () => void; open: () => void; reveal: () => void }

function ImageView({ a, onClose, open, reveal }: ViewProps) {
  const [missing, setMissing] = useState(!a.path)
  const src = !missing && a.path ? fileUrl(a.path) : a.thumb
  return (
    <div className="fixed inset-0 z-[80] flex cursor-zoom-out flex-col items-center justify-center gap-3 bg-[rgba(0,0,0,0.55)] backdrop-blur-md" onClick={onClose}>
      {src ? (
        <img src={src} alt={a.name} onError={() => setMissing(true)} className={`max-h-[78vh] max-w-[78vw] rounded-2xl shadow-[0_24px_80px_rgba(0,0,0,0.45)] ${missing ? 'min-w-[240px] blur-[0.3px]' : ''}`} />
      ) : (
        <div className="rounded-2xl bg-white/10 px-6 py-10 text-[14px] text-white/80">{t('att.missing')}</div>
      )}
      <div className="flex items-center gap-3 text-[14px] font-medium text-white/90" onClick={(e) => e.stopPropagation()}>
        <span className="max-w-[40vw] truncate">{a.name}</span>
        {missing ? (
          <span className="text-[12.5px] font-normal text-white/70">{t('att.missingThumb')}</span>
        ) : (
          <>
            <button className={darkBtn} onClick={reveal}>
              <IconFolder size={14} /> {t('common.showInFinder')}
            </button>
            <button className={darkBtn} onClick={open}>
              <IconExternal size={14} /> {t('att.open')}
            </button>
          </>
        )}
      </div>
    </div>
  )
}

function TextView({ a, onClose, open, reveal }: ViewProps) {
  const [state, setState] = useState<{ data: AttachmentText | null; failed: boolean }>({ data: null, failed: !a.path })
  useEffect(() => {
    if (!a.path) return
    let live = true
    window.agentswitch.attach.read(a.path).then(
      (data) => live && setState({ data, failed: false }),
      () => live && setState({ data: null, failed: true })
    )
    return () => {
      live = false
    }
  }, [a.path])
  const { data, failed } = state
  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-(--scrim-soft) backdrop-blur-[3px]" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="flex max-h-[80vh] w-[760px] max-w-[88vw] flex-col overflow-hidden rounded-2xl bg-surface shadow-[0_0_0_1px_var(--ring),0_24px_64px_rgba(0,0,0,0.22)]">
        <div className="flex items-center gap-2.5 border-b border-hairline px-4 py-3">
          <IconFile size={16} className="shrink-0 text-ink-2" />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[14px] font-medium text-ink">{a.name}</span>
            <span className="block truncate font-mono text-[11px] text-ink-3" title={a.path ?? ''}>
              {a.path ?? ''}
              {data ? ` · ${fmtBytes(data.bytes)}` : ''}
            </span>
          </span>
          {!failed && (
            <>
              <button className={lightBtn} onClick={reveal}>
                <IconFolder size={13} /> {t('common.showInFinder')}
              </button>
              <button className={lightBtn} onClick={open}>
                <IconExternal size={13} /> {t('att.open')}
              </button>
            </>
          )}
          <button onClick={onClose} className="flex h-7 w-7 items-center justify-center rounded-full text-ink-3 hover:bg-black/[0.06] hover:text-ink" title={t('common.close')}>
            <IconX size={14} />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-auto">
          {failed ? (
            <div className="px-5 py-10 text-center text-[13px] text-ink-3">{t('att.missing')}</div>
          ) : !data ? (
            <div className="px-5 py-10 text-center text-[13px] text-ink-3">{t('ext.loading')}</div>
          ) : data.binary ? (
            <div className="px-5 py-10 text-center text-[13px] text-ink-3">{t('att.binary')}</div>
          ) : (
            <>
              <pre className="px-4 py-3 font-mono text-[12px] leading-[18px] whitespace-pre-wrap text-ink-2 select-text">{data.text || t('ext.previewEmpty')}</pre>
              {data.truncated && <div className="px-4 pb-3 text-[11.5px] text-ink-3">{t('ext.previewTruncated', { size: fmtBytes(data.bytes) })}</div>}
            </>
          )}
        </div>
      </div>
    </div>
  )
}
