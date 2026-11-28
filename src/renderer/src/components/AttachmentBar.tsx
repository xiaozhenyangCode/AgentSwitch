import type { Attachment } from '@shared/chat'
import { resolveFileTypeMeta, type FileTypeIconKind } from '../lib/fileTypeMeta'
import { t } from '../state/i18n'
import { attachmentImages, attachmentPaths, MissingFile, useImageCandidate, type PathExistence } from './FilePreview'
import { IconFile, IconTerminal, IconX } from './icons'

export function attachmentTitle(a: Attachment): string {
  return (a.source === 'workspace-file' ? a.relativePath : a.path) || a.fallbackPath || a.path || a.name
}

export function FileTypeIcon({ kind, size = 14, className = '' }: { kind: FileTypeIconKind; size?: number; className?: string }) {
  const svgProps = {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.8,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    className,
    'aria-hidden': true as const
  }
  switch (kind) {
    case 'image':
      return (
        <svg {...svgProps}>
          <rect x="3" y="4" width="18" height="16" rx="2.5" />
          <circle cx="9" cy="9.5" r="1.5" />
          <path d="m21 15.5-5-5L6 20" />
        </svg>
      )
    case 'document':
      return (
        <svg {...svgProps}>
          <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5Z" />
          <path d="M14 3v5h5M9 13h6M9 17h4" />
        </svg>
      )
    case 'pdf':
      return (
        <svg {...svgProps}>
          <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5Z" />
          <path d="M14 3v5h5M8.5 16v-4h1.8a1.3 1.3 0 0 1 0 2.6H8.5" />
        </svg>
      )
    case 'code':
      return (
        <svg {...svgProps}>
          <path d="m8 9-4 3 4 3M16 9l4 3-4 3M13.5 6l-3 12" />
        </svg>
      )
    case 'terminal':
      return <IconTerminal size={size} className={className} aria-hidden="true" />
    case 'config':
      return (
        <svg {...svgProps}>
          <path d="M8 4H7a2 2 0 0 0-2 2v3.5a2 2 0 0 1-1.5 2 2 2 0 0 1 1.5 2V17a2 2 0 0 0 2 2h1" />
          <path d="M16 4h1a2 2 0 0 1 2 2v3.5a2 2 0 0 0 1.5 2 2 2 0 0 0-1.5 2V17a2 2 0 0 1-2 2h-1" />
        </svg>
      )
    case 'table':
      return (
        <svg {...svgProps}>
          <rect x="3" y="4" width="18" height="16" rx="2" />
          <path d="M3 10h18M9 4v16" />
        </svg>
      )
    case 'archive':
      return (
        <svg {...svgProps}>
          <rect x="4" y="4" width="16" height="16" rx="2.5" />
          <path d="M12 4v10M10 8h2M12 11h2M10 14h4" />
        </svg>
      )
    default:
      return <IconFile size={size} className={className} aria-hidden="true" />
  }
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
  const meta = resolveFileTypeMeta(a.name, a.mimeType)
  return <FileTypeIcon kind={meta.icon} size={compact ? 14 : 16} className={`shrink-0 ${meta.color}`} />
}

function AttachmentPreviewCard({
  a,
  projectDir,
  revision,
  onOpen,
  onRemove
}: {
  a: Attachment
  projectDir?: string | null
  revision?: number
  onOpen: (a: Attachment) => void
  onRemove?: (a: Attachment) => void
}) {
  const title = attachmentTitle(a)
  const meta = resolveFileTypeMeta(a.name, a.mimeType)
  const { candidate, imageKey, fail } = useImageCandidate(a.isImage ? attachmentImages(a, projectDir) : [], revision)
  const tooltip = [title, meta.label ? `${meta.label} · ${t('att.clickPreview')}` : t('att.clickPreview')].filter(Boolean).join('\n')

  return (
    <div
      title={tooltip}
      className="group relative flex h-[90px] w-[118px] shrink-0 flex-col overflow-hidden rounded-xl border border-black/[0.08] bg-surface shadow-[0_1px_2px_rgba(0,0,0,0.04)] transition-colors hover:border-black/[0.16] dark:border-white/[0.1] dark:bg-surface-2 dark:shadow-[0_1px_2px_rgba(0,0,0,0.22)] dark:hover:border-white/[0.2]"
    >
      <button type="button" onClick={() => onOpen(a)} className="flex h-full w-full flex-col text-left">
        <div
          className={`relative flex min-h-0 flex-1 w-full items-center justify-center overflow-hidden ${
            candidate ? 'bg-black/[0.03] dark:bg-white/[0.04]' : 'bg-gradient-to-b from-black/[0.025] to-black/[0.06] dark:from-white/[0.03] dark:to-white/[0.07]'
          }`}
        >
          {candidate ? (
            <img key={imageKey} src={candidate.src} alt="" decoding="async" onError={fail} className="h-full w-full object-cover" />
          ) : (
            <div className="flex flex-col items-center justify-center gap-1 select-none">
              <FileTypeIcon kind={meta.icon} size={20} className={`${meta.color} opacity-85`} />
              {meta.label && <span className="font-mono text-[10px] leading-none font-semibold tracking-wider text-ink-3 uppercase">{meta.label}</span>}
            </div>
          )}
        </div>
        <div className="flex h-[26px] w-full shrink-0 items-center gap-1.5 border-t border-black/[0.06] bg-surface px-2 dark:border-white/[0.08] dark:bg-surface">
          <FileTypeIcon kind={meta.icon} size={13} className={`shrink-0 ${meta.color}`} />
          <span className="min-w-0 flex-1 truncate text-[11.5px] leading-none font-medium text-ink">{a.name}</span>
        </div>
      </button>
      {onRemove && (
        <button
          type="button"
          title={t('common.remove')}
          aria-label={t('common.remove')}
          onMouseDown={(e) => e.preventDefault()}
          onClick={(e) => {
            e.stopPropagation()
            onRemove(a)
          }}
          className="absolute top-1.5 right-1.5 z-10 grid size-[18px] place-items-center rounded-full bg-[rgba(15,15,18,0.62)] text-white opacity-75 ring-1 ring-white/20 transition-all group-hover:opacity-100 hover:bg-[rgba(15,15,18,0.85)]"
        >
          <IconX size={10} strokeWidth={2.4} />
        </button>
      )}
    </div>
  )
}

export function AttachmentBar({
  items,
  projectDir,
  revision,
  fileExists,
  alignEnd,
  variant = 'chips',
  onOpen,
  onRemove,
  onRebindProject
}: {
  items: readonly Attachment[]
  projectDir?: string | null
  revision?: number
  fileExists?: PathExistence
  alignEnd?: boolean
  variant?: 'cards' | 'chips'
  onOpen: (a: Attachment) => void
  onRemove?: (a: Attachment) => void
  onRebindProject?: () => void
}) {
  if (!items.length) return null

  if (variant === 'cards') {
    return (
      <div className="flex flex-nowrap gap-2 overflow-x-auto overflow-y-hidden pb-0.5">
        {items.map((a) => (
          <AttachmentPreviewCard key={a.id} a={a} projectDir={projectDir} revision={revision} onOpen={onOpen} onRemove={onRemove} />
        ))}
      </div>
    )
  }

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
