import type { Attachment } from '@shared/chat'
import { t } from '../state/i18n'
import { attachmentImages, attachmentPaths, MissingFile, useImageCandidate, type PathExistence } from './FilePreview'
import { IconFile, IconX } from './icons'

export function attachmentTitle(a: Attachment): string {
  return (a.source === 'workspace-file' ? a.relativePath : a.path) || a.fallbackPath || a.path || a.name
}

export function AttachmentIcon({
  a,
  projectDir,
  revision,
  compact = false
}: {
  a: Attachment
  projectDir?: string | null
  revision?: number
  compact?: boolean
}) {
  const { candidate, imageKey, fail } = useImageCandidate(a.isImage ? attachmentImages(a, projectDir) : [], revision)
  if (candidate) {
    return (
      <img
        key={imageKey}
        src={candidate.src}
        alt=""
        decoding="async"
        onError={fail}
        className={compact ? 'size-[18px] shrink-0 rounded-[4px] object-cover' : 'size-7 shrink-0 rounded-md object-cover'}
      />
    )
  }
  return <IconFile size={compact ? 14 : 16} className="shrink-0 text-ink-2" aria-hidden="true" />
}

export function AttachmentBar({
  items,
  projectDir,
  revision,
  fileExists,
  alignEnd,
  onOpen,
  onRemove,
  onRebindProject
}: {
  items: readonly Attachment[]
  projectDir?: string | null
  revision?: number
  fileExists?: PathExistence
  alignEnd?: boolean
  onOpen: (a: Attachment) => void
  onRemove?: (a: Attachment) => void
  onRebindProject?: () => void
}) {
  if (!items.length) return null
  return (
    <div className={`flex flex-wrap gap-1.5 ${alignEnd ? 'justify-end' : ''}`}>
      {items.map((a) => {
        const title = attachmentTitle(a)
        const paths = attachmentPaths(a, projectDir)
        const missing = (!paths.length || (fileExists && paths.every((path) => fileExists[path] === false))) && !a.thumb
        if (missing && !onRemove) {
          return (
            <MissingFile
              key={a.id}
              name={a.name}
              relativePath={a.relativePath}
              path={a.path ?? a.fallbackPath}
              skippedReason={a.skippedReason}
              onRebindProject={a.source === 'workspace-file' || a.relativePath ? onRebindProject : undefined}
            />
          )
        }
        return (
          <div
            key={a.id}
            title={title}
            className={`group inline-flex h-[26px] min-w-0 items-center gap-1 rounded-md border border-black/[0.08] bg-black/[0.04] pl-1.5 text-xs text-ink transition-colors hover:border-black/[0.14] dark:border-white/[0.09] dark:bg-white/[0.06] dark:hover:border-white/[0.16] ${
              onRemove ? 'pr-1' : 'pr-2'
            }`}
          >
            <button
              type="button"
              title={title + '\n' + t('att.clickPreview')}
              onClick={() => onOpen(a)}
              className="flex h-full min-w-0 items-center gap-1.5 text-left"
            >
              <AttachmentIcon a={a} projectDir={projectDir} revision={revision} compact />
              <span className="max-w-[180px] truncate leading-none">{a.name}</span>
            </button>
            {onRemove && (
              <button
                type="button"
                title={t('common.remove')}
                aria-label={t('common.remove')}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => onRemove(a)}
                className="grid size-[18px] shrink-0 place-items-center rounded text-ink-2 opacity-45 transition-all group-hover:opacity-75 hover:!opacity-100 hover:bg-black/[0.07] hover:text-ink dark:hover:bg-white/[0.1]"
              >
                <IconX size={11} />
              </button>
            )}
          </div>
        )
      })}
    </div>
  )
}
