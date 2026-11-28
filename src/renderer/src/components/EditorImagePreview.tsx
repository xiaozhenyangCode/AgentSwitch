import { useState } from 'react'
import { fileUrl } from '../lib/fileUrl'
import { btnSecondary } from '../lib/ui'
import { t } from '../state/i18n'
import { IconExternal, IconFolder } from './icons'

export const fmtBytes = (n: number) =>
  n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(2)} MB`

interface EditorImagePreviewProps {
  path: string
  realPath: string | null
  name: string
  size: number
  syncVersion: number
  onReveal: () => void
  onOpenExternal: () => void
}

export function EditorImagePreview({ path, realPath, name, size, syncVersion, onReveal, onOpenExternal }: EditorImagePreviewProps) {
  const src = fileUrl(realPath ?? path) + '?v=' + syncVersion
  const [image, setImage] = useState<{ src: string; dimensions: string | null } | null>(null)
  const loaded = image?.src === src ? image : null

  return (
    <div className="flex h-full min-h-0 flex-col bg-editor-canvas">
      <div className="relative min-h-0 flex-1">
        {loaded && !loaded.dimensions ? (
          <div role="status" className="grid h-full place-items-center px-4 text-center text-[13px] text-ink-3">
            {t('editor.imageLoadFailed')}
          </div>
        ) : (
          <img
            key={src}
            src={src}
            alt={name}
            draggable={false}
            className="absolute inset-0 m-auto h-full w-full object-contain p-3"
            onLoad={({ currentTarget: { naturalWidth, naturalHeight } }) =>
              setImage({ src, dimensions: `${naturalWidth} × ${naturalHeight} px` })}
            onError={() => setImage({ src, dimensions: null })}
          />
        )}
      </div>
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-t border-editor-hairline bg-editor-chrome px-3 py-2">
        <span className="text-[11.5px] text-ink-3 tabular-nums">
          {[loaded?.dimensions, fmtBytes(size)].filter(Boolean).join(' · ')}
        </span>
        <div className="flex flex-wrap gap-1.5">
          <button type="button" className={btnSecondary + ' flex items-center gap-1.5'} onClick={onReveal}>
            <IconFolder size={13} />{t('common.showInFinder')}
          </button>
          <button type="button" className={btnSecondary + ' flex items-center gap-1.5'} onClick={onOpenExternal}>
            <IconExternal size={13} />{t('editor.openImageExternal')}
          </button>
        </div>
      </div>
    </div>
  )
}
