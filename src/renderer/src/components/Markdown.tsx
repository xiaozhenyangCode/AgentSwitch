import { Children, createContext, isValidElement, memo, useContext, useEffect, useState, type ReactElement, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import ReactMarkdown, { defaultUrlTransform, type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import { fileUrl, localPath } from '../lib/fileUrl'
import { IconCheck, IconCopy, IconFolder } from './icons'

/** Folder relative image paths resolve against (the thread's working dir) + real HOME for `~/`. */
export const MarkdownBase = createContext<{ baseDir: string | null; home: string | null }>({ baseDir: null, home: null })

/** Plain text of a rendered (highlighted) React subtree. */
function textOf(node: ReactNode): string {
  if (node == null || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (isValidElement(node)) return textOf((node as ReactElement<{ children?: ReactNode }>).props.children)
  return ''
}

function CodeBlock({ children }: { children?: ReactNode }) {
  const [copied, setCopied] = useState(false)
  const code = Children.toArray(children)[0] as ReactElement<{ className?: string; children?: ReactNode }> | undefined
  const lang = /language-([\w+-]+)/.exec(code?.props.className ?? '')?.[1] ?? ''
  const copy = async () => {
    await window.agentmux.sys.copy(textOf(code?.props.children).replace(/\n$/, ''))
    setCopied(true)
    setTimeout(() => setCopied(false), 1400)
  }
  return (
    <div className="md-code group">
      <div className="flex h-8 items-center justify-between px-3.5 text-[12px] text-ink-3">
        <span className="font-mono">{lang || 'text'}</span>
        <button onClick={() => void copy()} className="flex items-center gap-1 rounded-md px-1.5 py-0.5 opacity-0 transition-opacity group-hover:opacity-100 hover:bg-black/[0.05] hover:text-ink">
          {copied ? <IconCheck size={13} className="text-[#1A7F45]" /> : <IconCopy size={13} />}
          {copied ? '已复制' : '复制'}
        </button>
      </div>
      <pre>{children}</pre>
    </div>
  )
}

/** Inline preview; click for a large lightbox view (Esc / click to close). */
export function ZoomImage({ src, alt, path }: { src: string; alt: string; path?: string | null }) {
  const [broken, setBroken] = useState(false)
  const [open, setOpen] = useState(false)
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])
  return (
    <>
      <span className={`md-figure${broken ? ' md-figure-broken' : ''}`} onClick={() => !broken && setOpen(true)} title={broken ? `无法预览：${path ?? src}` : '点击查看大图'}>
        {broken ? <span className="md-broken">图片无法预览</span> : <img src={src} alt={alt} loading="lazy" onError={() => setBroken(true)} />}
        {(alt || path) && <span className="md-caption">{alt || path!.split('/').pop()}</span>}
      </span>
      {open &&
        createPortal(
          <div className="fixed inset-0 z-[80] flex cursor-zoom-out flex-col items-center justify-center gap-3 bg-black/55 backdrop-blur-md" onClick={() => setOpen(false)}>
            <img src={src} alt={alt} className="max-h-[78vh] max-w-[78vw] rounded-2xl shadow-[0_24px_80px_rgba(0,0,0,0.45)]" />
            <div className="flex items-center gap-3 text-[14px] font-medium text-white/90">
              {alt && <span>{alt}</span>}
              {path && (
                <button
                  className="flex items-center gap-1.5 rounded-full bg-white/15 px-3 py-1 text-[13px] hover:bg-white/25"
                  onClick={(e) => {
                    e.stopPropagation()
                    void window.agentmux.sys.showInFolder(path)
                  }}
                >
                  <IconFolder size={14} /> 在 Finder 中显示
                </button>
              )}
            </div>
          </div>,
          document.body
        )}
    </>
  )
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
          if (href && /^https?:\/\//.test(href)) void window.agentmux.sys.openExternal(href)
          else if (local) void window.agentmux.sys.showInFolder(local)
        }}
        title={local ? `${local}\n在 Finder 中显示` : href}
      >
        {children}
      </a>
    )
  },
  img: function Img({ src, alt }) {
    const { baseDir, home } = useContext(MarkdownBase)
    if (typeof src !== 'string' || !src) return null
    const local = localPath(src, baseDir, home)
    if (local) return <ZoomImage src={fileUrl(local)} alt={alt ?? ''} path={local} />
    return /^(https?:|data:image\/)/i.test(src) ? <ZoomImage src={src} alt={alt ?? ''} /> : null
  },
  table: ({ children }) => (
    <div className="md-table">
      <table>{children}</table>
    </div>
  )
}

/** Links keep react-markdown's safe default; images additionally allow inline data and demo images. */
const urlTransform = (url: string, key: string) =>
  key === 'src' && /^(data:image\/(png|jpe?g|gif|webp)[;,]|file:\/\/)/i.test(url) ? url : defaultUrlTransform(url)

/** Driver's machine-readable dispatch block is shown as tags on the dispatched replies instead. */
const visible = (text: string) => text.replace(/```agentmux:dispatch[\s\S]*?(```|$)/g, '').trimEnd()

export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <div className="md">
      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[[rehypeHighlight, { detect: false, ignoreMissing: true }]]} components={components} urlTransform={urlTransform}>
        {visible(text)}
      </ReactMarkdown>
    </div>
  )
})
