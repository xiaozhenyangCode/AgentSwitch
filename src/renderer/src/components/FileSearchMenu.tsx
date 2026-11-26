import { Fragment, useEffect, useRef, type ReactNode } from 'react'
import type { ComposerFileCandidate } from '../state/useFileSearch'
import { popover } from '../lib/ui'
import { t } from '../state/i18n'
import { AttachmentIcon, attachmentTitle } from './AttachmentBar'
import { IconFile, IconRefresh, Spinner } from './icons'

function highlightedName(name: string, indexes: number[]): ReactNode {
  if (!indexes.length) return name
  const parts: ReactNode[] = []
  let offset = 0
  for (let i = 0; i < indexes.length;) {
    const start = indexes[i++]
    let end = start + 1
    while (indexes[i] === end) {
      i++
      end++
    }
    if (start > offset) parts.push(name.slice(offset, start))
    parts.push(<span key={start} className="font-semibold text-accent">{name.slice(start, end)}</span>)
    offset = end
  }
  parts.push(name.slice(offset))
  return parts
}

export function FileSearchMenu({
  id, items, active, projectDir, hasAttachments, loading, failed, truncated, onPick, onHover, onRefresh
}: {
  id: string
  items: ComposerFileCandidate[]
  active: number
  projectDir: string | null
  hasAttachments: boolean
  loading: boolean
  failed: boolean
  truncated: boolean
  onPick: (item: ComposerFileCandidate) => void
  onHover: (index: number) => void
  onRefresh: () => void
}) {
  const activeRow = useRef<HTMLDivElement>(null)
  useEffect(() => {
    activeRow.current?.scrollIntoView({ block: 'nearest' })
  }, [active, items])
  const label = t('wb.fileSearch')
  return (
    <div className={popover + ' flex max-h-[380px] w-[460px] max-w-full flex-col'} onMouseDown={(event) => event.preventDefault()}>
      <div className="flex items-center gap-1.5 px-2.5 pt-1 pb-1.5 text-[12px] text-ink-3">
        <IconFile size={13} aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate">{label}</span>
        {truncated && <span>{t('wb.fileSearchTruncated')}</span>}
        {loading && <Spinner size={11} />}
        {projectDir && (
          <button
            type="button"
            tabIndex={-1}
            disabled={loading}
            title={t('wb.fileSearchRefresh')}
            aria-label={t('wb.fileSearchRefresh')}
            onClick={onRefresh}
            className="rounded-md p-1 hover:bg-fill hover:text-ink disabled:opacity-50"
          >
            <IconRefresh size={13} />
          </button>
        )}
      </div>
      <div id={id} role="listbox" aria-label={label} aria-busy={loading && !items.length} className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        {items.map((item, i) => (
          <Fragment key={item.kind === 'added' ? 'added:' + item.attachment.id : 'workspace:' + item.relPath}>
            {items[i - 1]?.kind !== item.kind && (
              <div role="presentation" className="px-2.5 pt-1 pb-0.5 text-[11px] text-ink-3">
                {t(item.kind === 'added' ? 'wb.fileSearchAttached' : 'wb.fileSearchWorkspace')}
              </div>
            )}
            <div
              ref={i === active ? activeRow : undefined}
              id={`${id}-${i}`}
              role="option"
              aria-selected={i === active}
              title={item.kind === 'added' ? attachmentTitle(item.attachment) : item.relPath}
              onMouseMove={() => i !== active && onHover(i)}
              onClick={() => onPick(item)}
              className={`flex cursor-default items-center gap-2.5 rounded-[10px] px-2.5 py-1.5 ${i === active ? 'bg-accent/10' : ''}`}
            >
              {item.kind === 'added' ? <AttachmentIcon a={item.attachment} projectDir={projectDir} /> : <IconFile size={15} className="shrink-0 text-ink-3" aria-hidden="true" />}
              <span className="min-w-0 flex-1">
                <span className="block truncate font-mono text-[13px] leading-5 text-ink">{highlightedName(item.name, item.indexes)}</span>
                {item.dir && <span className="block truncate text-[11.5px] leading-4 text-ink-3">{highlightedName(item.dir, item.kind === 'added' ? item.aliasIndexes : [])}</span>}
              </span>
              {item.kind === 'added' && <span className="shrink-0 text-[11px] text-ink-3">{t('wb.fileSearchAdded')}</span>}
            </div>
          </Fragment>
        ))}
      </div>
      {!items.length && (
        <div role="status" className="px-2.5 py-2.5 text-[13px] text-ink-3">
          {t(!projectDir && !hasAttachments ? 'wb.fileSearchNoProject' : loading ? 'wb.fileSearchLoading' : failed ? 'wb.fileSearchError' : 'wb.fileSearchEmpty')}
        </div>
      )}
    </div>
  )
}
