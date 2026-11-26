import type { Attachment } from '@shared/chat'
import { t } from '../state/i18n'
import { attachmentImages, attachmentPaths, MissingFile, useImageCandidate, type PathExistence } from './FilePreview'
import { IconFile, IconPlus, IconX } from './icons'

export function attachmentTitle(a: Attachment): string {
  return (a.source === 'workspace-file' ? a.relativePath : a.path) || a.fallbackPath || a.path || a.name
}

export function AttachmentIcon({ a, projectDir, revision }: { a: Attachment; projectDir?: string | null; revision?: number }) {
  const { candidate, imageKey, fail } = useImageCandidate(a.isImage ? attachmentImages(a, projectDir) : [], revision)
  return candidate
    ? <img key={imageKey} src={candidate.src} alt="" decoding="async" onError={fail} className="size-7 shrink-0 rounded-md object-cover" />
    : <IconFile size={16} className="shrink-0 text-ink-2" aria-hidden="true" />
}

export function AttachmentBar({
  items, projectDir, revision, fileExists, alignEnd, onOpen, onInsert, onRemove, onRebindProject
}: {
  items: readonly Attachment[]
  projectDir?: string | null
  revision?: number
  fileExists?: PathExistence
  alignEnd?: boolean
  onOpen: (a: Attachment) => void
  onInsert?: (a: Attachment) => void
  onRemove?: (a: Attachment) => void
  onRebindProject?: () => void
}) {
  if (!items.length) return null
  return (
    <div className={`flex flex-wrap gap-2 ${alignEnd ? 'justify-end' : ''}`}>
      {items.map((a) => {
        const title = attachmentTitle(a)
        const paths = attachmentPaths(a, projectDir)
        const missing = (!paths.length || (fileExists && paths.every((path) => fileExists[path] === false))) && !a.thumb
        if (missing && !onRemove) {
          return <MissingFile key={a.id} name={a.name} relativePath={a.relativePath} path={a.path ?? a.fallbackPath}
            skippedReason={a.skippedReason} onRebindProject={a.source === 'workspace-file' || a.relativePath ? onRebindProject : undefined} />
        }
        return (
          <div key={a.id} title={title} className="flex h-10 min-w-0 max-w-[260px] items-center gap-0.5 rounded-xl bg-surface px-1 text-[12px] text-ink shadow-[0_0_0_1px_var(--ring)]">
            <button type="button" title={title + '\n' + t('att.clickPreview')} onClick={() => onOpen(a)}
              className="flex h-8 min-w-0 items-center gap-2 rounded-lg px-1.5 hover:bg-fill">
              <AttachmentIcon a={a} projectDir={projectDir} revision={revision} />
              <span className="truncate">{a.name}</span>
            </button>
            {onInsert && paths.length > 0 && (
              <button type="button" title={t('att.insertReference')} aria-label={t('att.insertReference')}
                onMouseDown={(e) => e.preventDefault()} onClick={() => onInsert(a)}
                className="grid size-6 shrink-0 place-items-center rounded-md text-ink-3 hover:bg-fill hover:text-ink">
                <IconPlus size={14} />
              </button>
            )}
            {onRemove && (
              <button type="button" title={t('common.remove')} aria-label={t('common.remove')}
                onMouseDown={(e) => e.preventDefault()} onClick={() => onRemove(a)}
                className="grid size-6 shrink-0 place-items-center rounded-md text-ink-3 hover:bg-fill hover:text-ink">
                <IconX size={13} />
              </button>
            )}
          </div>
        )
      })}
    </div>
  )
}
