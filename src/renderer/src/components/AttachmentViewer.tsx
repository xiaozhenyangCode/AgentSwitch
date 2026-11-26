import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import type { AttachmentText } from '@shared/types'
import type { Attachment } from '../state/chat'
import { useEscape } from '../lib/escStack'
import { attachmentImages, attachmentPaths, MissingFile, useImageCandidate } from './FilePreview'
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
type ViewProps = {
  a: Attachment
  onClose: () => void
  projectDir?: string | null
  onRebindProject?: () => void
  revision?: number
}

export function AttachmentViewer(props: ViewProps) {
  useEscape(props.onClose)
  return createPortal(props.a.isImage ? <ImageView {...props} /> : <TextView {...props} />, document.body)
}

const open = (path: string) => void window.agentswitch.sys.openPath(path).catch(() => {})
const reveal = (path: string) => void window.agentswitch.sys.showInFolder(path)

function ImageView({ a, projectDir, onClose, onRebindProject, revision }: ViewProps) {
  const { candidate, imageKey, fail } = useImageCandidate(attachmentImages(a, projectDir), revision)
  const path = candidate?.path
  return (
    <div className="fixed inset-0 z-[80] flex cursor-zoom-out flex-col items-center justify-center gap-3 bg-(--scrim)" onClick={onClose}>
      {candidate ? (
        <img key={imageKey} src={candidate.src} alt={a.name} onError={fail}
          className={`max-h-[78vh] max-w-[78vw] rounded-2xl shadow-[0_24px_80px_rgba(0,0,0,0.45)] ${path ? '' : 'min-w-[240px] blur-[0.3px]'}`} />
      ) : (
        <MissingFile name={a.name} relativePath={a.relativePath} path={a.path ?? a.fallbackPath}
          skippedReason={a.skippedReason} onRebindProject={onRebindProject} />
      )}
      {candidate && (
        <div className="flex items-center gap-3 rounded-full bg-[#000]/65 px-3 py-1 text-[14px] font-medium text-white/90" onClick={(e) => e.stopPropagation()}>
          <span className="max-w-[40vw] truncate" title={path ?? a.path ?? a.name}>{a.name}</span>
          {path ? (
            <>
              <button className={darkBtn} onClick={() => reveal(path)}>
                <IconFolder size={14} /> {t('common.showInFinder')}
              </button>
              <button className={darkBtn} onClick={() => open(path)}>
                <IconExternal size={14} /> {t('att.open')}
              </button>
            </>
          ) : (
            <span className="text-[12.5px] font-normal text-white/70">{t('att.missingThumb')}</span>
          )}
        </div>
      )}
    </div>
  )
}

function TextView({ a, projectDir, onClose, onRebindProject, revision = 0 }: ViewProps) {
  const paths = attachmentPaths(a, projectDir)
  const key = JSON.stringify(paths)
  const [result, setResult] = useState<{ key: string; revision: number; file: { data: AttachmentText; path: string } | null }>()
  useEffect(() => {
    let live = true
    const read = async () => {
      for (const path of JSON.parse(key) as string[]) {
        if (!live) return
        try {
          const data = await window.agentswitch.attach.read(path)
          if (live) setResult({ key, revision, file: { data, path } })
          return
        } catch { /* Try the next candidate if the primary file cannot be read. */ }
      }
      if (live) setResult({ key, revision, file: null })
    }
    void read()
    return () => { live = false }
  }, [key, revision])
  const settled = result?.key === key && result.revision === revision ? result.file : undefined
  const failed = !paths.length || settled === null
  const data = settled?.data
  const path = settled?.path
  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-(--scrim-soft)" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="flex max-h-[80vh] w-[760px] max-w-[88vw] flex-col overflow-hidden rounded-2xl bg-surface shadow-[0_0_0_1px_var(--ring),0_24px_64px_rgba(0,0,0,0.22)]">
        <div className="flex items-center gap-2.5 border-b border-hairline px-4 py-3">
          <IconFile size={16} className="shrink-0 text-ink-2" />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[14px] font-medium text-ink">{a.name}</span>
            <span className="block truncate font-mono text-[11px] text-ink-3" title={path ?? a.path ?? a.fallbackPath ?? a.name}>
              {a.relativePath ?? path ?? a.path ?? a.fallbackPath ?? ''}
              {data ? ` · ${fmtBytes(data.bytes)}` : ''}
            </span>
          </span>
          {path && (
            <>
              <button className={lightBtn} onClick={() => reveal(path)}>
                <IconFolder size={13} /> {t('common.showInFinder')}
              </button>
              <button className={lightBtn} onClick={() => open(path)}>
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
            <div className="px-5 py-5">
              <MissingFile name={a.name} relativePath={a.relativePath} path={a.path ?? a.fallbackPath}
                skippedReason={a.skippedReason} onRebindProject={onRebindProject} />
            </div>
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
