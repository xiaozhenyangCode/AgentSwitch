import { useEffect, useState } from 'react'
import type { Attachment, BundleSkipReason } from '@shared/chat'
import { joinPosixRelative } from '@shared/fileResolve'
import { fileUrl } from '../lib/fileUrl'
import { t } from '../state/i18n'
import { IconFile } from './icons'

export function attachmentPaths(a: Attachment, projectDir?: string | null): string[] {
  const mapped = projectDir && a.relativePath ? joinPosixRelative(projectDir, a.relativePath, { literalPosix: true }) : null
  const ordered = a.source === 'workspace-file'
    ? [mapped, a.fallbackPath, a.path]
    : [a.path, a.fallbackPath, mapped]
  return [...new Set(ordered.filter((path): path is string => !!path))]
}

export type ImageCandidate = { src: string; path?: string | null }

export function attachmentImages(a: Attachment, projectDir?: string | null): ImageCandidate[] {
  const images: ImageCandidate[] = attachmentPaths(a, projectDir).map((path) => ({ path, src: fileUrl(path) }))
  if (a.thumb) images.push({ src: a.thumb })
  return images
}

export function useImageCandidate(candidates: ImageCandidate[], revision = 0) {
  const key = JSON.stringify([revision, ...candidates.map(({ src }) => src)])
  const [failed, setFailed] = useState<{ key: string; index: number }>()
  const index = failed?.key === key ? failed.index : 0
  return {
    candidate: candidates[index],
    imageKey: key + ':' + index,
    fail: () => setFailed((current) => {
      const currentIndex = current?.key === key ? current.index : 0
      return currentIndex === index ? { key, index: index + 1 } : current
    })
  }
}

export type PathExistence = Readonly<Partial<Record<string, boolean>>>
const unknownPaths: PathExistence = Object.freeze({})

export function usePathsExist(paths: string[], revision = 0): PathExistence {
  const key = JSON.stringify([...new Set(paths)].sort())
  const [checked, setChecked] = useState<{ key: string; revision: number; exists: PathExistence }>()
  useEffect(() => {
    const pending: string[] = JSON.parse(key)
    if (!pending.length) return
    let active = true
    const check = async () => {
      const exists: Record<string, boolean> = {}
      for (let offset = 0; active && offset < pending.length; offset += 200) {
        Object.assign(exists, await window.agentswitch.sys.pathsExist(pending.slice(offset, offset + 200)))
      }
      if (active) setChecked({ key, revision, exists })
    }
    void check().catch(() => {})
    return () => { active = false }
  }, [key, revision])
  return checked?.key === key && checked.revision === revision ? checked.exists : unknownPaths
}

const reasonKeys = {
  'too-large': 'filePreview.tooLarge',
  missing: 'filePreview.missing',
  unreadable: 'filePreview.unreadable',
  filtered: 'filePreview.filtered'
} as const satisfies Record<BundleSkipReason, Parameters<typeof t>[0]>

export function MissingFile({ name, relativePath, path, skippedReason, reason, onRebindProject }: {
  name: string
  relativePath?: string
  path?: string | null
  skippedReason?: BundleSkipReason
  reason?: string
  onRebindProject?: () => void
}) {
  return (
    <span className="file-preview-missing" title={path ?? relativePath ?? name}>
      <span className="file-preview-missing-name"><IconFile size={14} /> <span>{name}</span></span>
      {relativePath && relativePath !== name && <span className="file-preview-missing-path">{relativePath}</span>}
      <span className="file-preview-missing-reason">{skippedReason ? t(reasonKeys[skippedReason]) : reason ?? t('filePreview.missing')}</span>
      {onRebindProject && (
        <button type="button" className="file-preview-rebind" onClick={(event) => { event.stopPropagation(); onRebindProject() }}>
          {t('proj.rebind')}
        </button>
      )}
    </span>
  )
}
