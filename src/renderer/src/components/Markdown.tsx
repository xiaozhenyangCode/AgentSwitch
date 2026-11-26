import { Children, createContext, isValidElement, memo, useContext, useEffect, useState, type ReactElement, type ReactNode } from 'react'
import { useEscape } from '../lib/escStack'
import { stripMarks } from '@shared/markers'
import type { BundleSkipReason, OutputFileRef } from '@shared/chat'
import { deriveRelativePath, findMatchingOutputFile, joinPosixRelative, resolveMarkdownImagePath, resolveOutputFileCandidates } from '@shared/fileResolve'
import { createPortal } from 'react-dom'
import ReactMarkdown, { defaultUrlTransform, type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import rehypeHighlight from 'rehype-highlight'
import 'katex/dist/katex.min.css'
import { baseName, fileUrl, localPath, upgradeFileUrl } from '../lib/fileUrl'
import { MissingFile, useImageCandidate, type ImageCandidate } from './FilePreview'
import { IconCheck, IconCopy, IconFolder } from './icons'
import { useTheme } from '../state/theme'
import { t } from '../state/i18n'

let mermaidSeq = 0
let mermaidLib: Promise<typeof import('mermaid')['default']> | null = null
/** Loaded on first use (large); strict mode sanitises labels and disables click handlers. */
const loadMermaid = async (dark: boolean) => {
  const m = await (mermaidLib ??= import('mermaid').then((x) => x.default))
  // re-initialised per render: the theme follows the app's light / dark appearance
  m.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    theme: dark ? 'dark' : 'neutral',
    fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", sans-serif'
  })
  return m
}

/** Folder relative image paths resolve against (the thread's working dir) + real HOME for `~/`. */
export const MarkdownBase = createContext<{
  baseDir: string | null
  home: string | null
  projectDir?: string | null
  sourceProjectDir?: string | null
  outputFiles?: OutputFileRef[]
  onRebindProject?: () => void
  revision?: number
}>({ baseDir: null, home: null })

/** Plain text of a rendered (highlighted) React subtree. */
function textOf(node: ReactNode): string {
  if (node == null || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (isValidElement(node)) return textOf((node as ReactElement<{ children?: ReactNode }>).props.children)
  return ''
}

/** ```mermaid block rendered as SVG; falls back to the source while incomplete/invalid. */
function MermaidBlock({ source }: { source: string }) {
  const [svg, setSvg] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [showSrc, setShowSrc] = useState(false)
  const [copied, setCopied] = useState(false)
  const { dark } = useTheme()
  useEffect(() => {
    let dead = false
    // debounce: while a reply streams the block is re-rendered on every token
    const t = setTimeout(async () => {
      try {
        const m = await loadMermaid(dark)
        await m.parse(source)
        const { svg } = await m.render(`mmd-${++mermaidSeq}`, source)
        if (!dead) {
          setSvg(svg)
          setErr(null)
        }
      } catch (e) {
        if (!dead) setErr(e instanceof Error ? e.message.split('\n')[0] : String(e))
      }
    }, 350)
    return () => {
      dead = true
      clearTimeout(t)
    }
  }, [source, dark])
  const copy = async () => {
    await window.agentswitch.sys.copy(source)
    setCopied(true)
    setTimeout(() => setCopied(false), 1400)
  }
  const raw = showSrc || !svg
  return (
    <div className="md-code group">
      <div className="flex h-8 items-center gap-1 px-3.5 text-[12px] text-ink-3">
        <span className="flex-1 font-mono">mermaid{err && !svg ? t('md.renderFailed') : ''}</span>
        {svg && (
          <button onClick={() => setShowSrc((x) => !x)} className="rounded-md px-1.5 py-0.5 hover:bg-black/[0.05] hover:text-ink">
            {showSrc ? t('md.viewChart') : t('md.viewSource')}
          </button>
        )}
        <button onClick={() => void copy()} className="flex items-center gap-1 rounded-md px-1.5 py-0.5 hover:bg-black/[0.05] hover:text-ink">
          {copied ? <IconCheck size={13} className="text-ok" /> : <IconCopy size={13} />}
          {copied ? t('common.copied') : t('common.copy')}
        </button>
      </div>
      {raw ? (
        <pre>
          <code>{source}</code>
          {err && !svg && <span className="mt-2 block font-sans text-[12px] text-warn">{err}</span>}
        </pre>
      ) : (
        <div className="md-mermaid" dangerouslySetInnerHTML={{ __html: svg! }} />
      )}
    </div>
  )
}

function CodeBlock({ children }: { children?: ReactNode }) {
  const [copied, setCopied] = useState(false)
  const code = Children.toArray(children)[0] as ReactElement<{ className?: string; children?: ReactNode }> | undefined
  const lang = /language-([\w+-]+)/.exec(code?.props.className ?? '')?.[1] ?? ''
  if (lang === 'mermaid') return <MermaidBlock source={textOf(code?.props.children).replace(/\n$/, '')} />
  const copy = async () => {
    await window.agentswitch.sys.copy(textOf(code?.props.children).replace(/\n$/, ''))
    setCopied(true)
    setTimeout(() => setCopied(false), 1400)
  }
  return (
    <div className="md-code group">
      <div className="flex h-8 items-center justify-between px-3.5 text-[12px] text-ink-3">
        <span className="font-mono">{lang || 'text'}</span>
        <button onClick={() => void copy()} className="flex items-center gap-1 rounded-md px-1.5 py-0.5 opacity-0 transition-opacity group-hover:opacity-100 hover:bg-black/[0.05] hover:text-ink">
          {copied ? <IconCheck size={13} className="text-ok" /> : <IconCopy size={13} />}
          {copied ? t('common.copied') : t('common.copy')}
        </button>
      </div>
      <pre>{children}</pre>
    </div>
  )
}

/** Inline preview with a large lightbox using the same candidate order. */
export function ZoomImage({
  src, fallbackSrc, alt, name, path, fallbackPath, fullPath, relativePath, skippedReason, onRebindProject, revision
}: {
  src?: string | null
  fallbackSrc?: string | null
  alt: string
  name?: string
  path?: string | null
  fallbackPath?: string | null
  fullPath?: string | null
  relativePath?: string
  skippedReason?: BundleSkipReason
  onRebindProject?: () => void
  revision?: number
}) {
  const candidates: ImageCandidate[] = []
  if (src) candidates.push({ src, path })
  if (fallbackSrc && fallbackSrc !== src) candidates.push({ src: fallbackSrc, path: fallbackPath })
  const { candidate, imageKey, fail } = useImageCandidate(candidates, revision)
  const [open, setOpen] = useState(false)
  useEscape(() => setOpen(false), open && !!candidate)
  const label = name || (path ? baseName(path) : alt) || t('md.imageBroken')
  if (!candidate) {
    return (
      <span className="md-figure md-figure-broken">
        <MissingFile name={label} relativePath={relativePath} path={fullPath ?? path ?? src} skippedReason={skippedReason}
          reason={!fullPath && !path && !relativePath ? t('md.imageBroken') : undefined} onRebindProject={onRebindProject} />
      </span>
    )
  }
  const reveal = () => { if (candidate.path) void window.agentswitch.sys.showInFolder(candidate.path) }
  const caption = alt || name || (path ? baseName(path) : '')
  const onError = () => {
    if (candidate === candidates.at(-1)) setOpen(false)
    fail()
  }
  return (
    <>
      <button type="button" className="md-figure text-left"
        onClick={(e) => {
          if ((e.metaKey || e.ctrlKey) && candidate.path) reveal()
          else setOpen(true)
        }}
        title={t('md.clickZoom')} aria-label={caption || t('md.clickZoom')}
      >
        <img key={imageKey} src={candidate.src} alt={caption} loading="lazy" onError={onError} />
        {caption && <span className="md-caption">{caption}</span>}
      </button>
      {open && createPortal(
        <div className="fixed inset-0 z-[80] flex cursor-zoom-out flex-col items-center justify-center gap-3 bg-(--scrim)" onClick={() => setOpen(false)}>
          <img key={imageKey} src={candidate.src} alt={caption} onError={onError} className="max-h-[78vh] max-w-[78vw] rounded-2xl shadow-[0_24px_80px_rgba(0,0,0,0.45)]" />
          {(caption || candidate.path) && (
            <div className="flex items-center gap-3 rounded-full bg-[#000]/65 px-3 py-1 text-[14px] font-medium text-white/90">
              {caption && <span>{caption}</span>}
              {candidate.path && (
                <button className="flex items-center gap-1.5 rounded-full bg-white/15 px-3 py-1 text-[13px] hover:bg-white/25"
                  onClick={(e) => { e.stopPropagation(); reveal() }}>
                  <IconFolder size={14} /> {t('common.showInFinder')}
                </button>
              )}
            </div>
          )}
        </div>,
        document.body
      )}
    </>
  )
}

export function OutputImage({ file, projectDir, alt, onRebindProject, revision }: {
  file: OutputFileRef
  projectDir: string | null
  alt?: string
  onRebindProject?: () => void
  revision?: number
}) {
  const [path, fallbackPath] = resolveOutputFileCandidates(file, projectDir)
  return <ZoomImage src={path && fileUrl(path)} fallbackSrc={fallbackPath && fileUrl(fallbackPath)}
    path={path} fallbackPath={fallbackPath} fullPath={file.path || file.sourcePath}
    name={file.name} alt={alt ?? file.name} relativePath={file.relativePath} skippedReason={file.skippedReason}
    onRebindProject={file.source === 'workspace-file' ? onRebindProject : undefined} revision={revision} />
}

const components: Components = {
  pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
  a: function Link({ href, children }) {
    const { baseDir, home } = useContext(MarkdownBase)
    const local = href ? localPath(href, baseDir, home) : null
    return (
      <a
        href={href}
        onClick={(e) => {
          e.preventDefault()
          if (href && /^https?:\/\//.test(href)) void window.agentswitch.sys.openExternal(href)
          else if (local) void window.agentswitch.sys.showInFolder(local)
        }}
        title={local ? `${local}\n${t('common.showInFinder')}` : href}
      >
        {children}
      </a>
    )
  },
  img: function Img({ src, alt }) {
    const { baseDir, home, projectDir = baseDir, sourceProjectDir, outputFiles, onRebindProject, revision } = useContext(MarkdownBase)
    if (typeof src !== 'string' || !src) return null
    const file = findMatchingOutputFile(src, baseDir, home, outputFiles, sourceProjectDir)
    if (file) return <OutputImage file={file} projectDir={projectDir} alt={alt ?? undefined} onRebindProject={onRebindProject} revision={revision} />
    const own = upgradeFileUrl(src)
    if (own) return <ZoomImage src={own} alt={alt ?? ''} />
    if (/^(https?:|data:image\/)/i.test(src)) return <ZoomImage src={src} alt={alt ?? ''} />

    const local = resolveMarkdownImagePath(src, baseDir, home)
    const previous = resolveMarkdownImagePath(src, sourceProjectDir, home)
    const relativePath = previous ? deriveRelativePath(previous, sourceProjectDir) : null
    if (relativePath) {
      const path = projectDir ? joinPosixRelative(projectDir, relativePath) : null
      return <ZoomImage src={path && fileUrl(path)} alt={alt ?? ''} path={path}
        name={baseName(relativePath)} fullPath={path ?? previous} relativePath={relativePath}
        onRebindProject={onRebindProject} revision={revision} />
    }
    if (local) return <ZoomImage src={fileUrl(local)} alt={alt ?? ''} path={local} name={baseName(local)} revision={revision} />
    return null
  },
  table: ({ children }) => (
    <div className="md-table">
      <table>{children}</table>
    </div>
  )
}

/** Links allow file:// in addition to react-markdown's safe default; images allow inline data and local file URLs. */
const urlTransform = (url: string, key: string) =>
  (key === 'src' && /^(?:[a-z]:[\\/]|data:image\/(png|jpe?g|gif|webp)[;,]|file:\/\/|agentswitch-file:\/\/|agentmux-file:\/\/)/i.test(url)) ||
  (key === 'href' && /^file:\/\//i.test(url))
    ? url
    : defaultUrlTransform(url)

/** Driver's machine-readable dispatch block is shown as tags on the dispatched replies instead. */
const visible = (text: string) => stripMarks(text.replace(/```(?:agentswitch|agentmux):dispatch[\s\S]*?(```|$)/g, '')).trimEnd()

const readOnlyComponents: Components = {
  ...components,
  pre: ({ children }) => <pre className="whitespace-pre-wrap">{children}</pre>,
  a: ({ children }) => <>{children}</>,
  img: ({ alt }) => <>{alt}</>
}

export const Markdown = memo(function Markdown({ text, readOnly = false }: { text: string; readOnly?: boolean }) {
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, [remarkMath, { singleDollarTextMath: true }]]}
        rehypePlugins={[
          [rehypeKatex, { throwOnError: false, strict: 'ignore', output: 'htmlAndMathml' }],
          [rehypeHighlight, { detect: false, ignoreMissing: true, plainText: ['mermaid'] }]
        ]}
        components={readOnly ? readOnlyComponents : components}
        urlTransform={urlTransform}
      >
        {readOnly ? text : visible(text)}
      </ReactMarkdown>
    </div>
  )
})
