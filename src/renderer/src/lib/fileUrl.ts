/** `agentmux-file://f/<base64url(abs path)>` — served read-only by the main process (images in allowed project folders). */
export function fileUrl(abs: string): string {
  const bytes = new TextEncoder().encode(abs)
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return 'agentmux-file://f/' + btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

const join = (base: string, rel: string): string => {
  const parts = base.replace(/\/+$/, '').split('/')
  for (const seg of rel.split('/')) {
    if (!seg || seg === '.') continue
    if (seg === '..') parts.pop()
    else parts.push(seg)
  }
  return parts.join('/') || '/'
}

/** Absolute local path for a markdown src (relative to baseDir, absolute, ~ or file://); null for remote/data URLs. */
export function localPath(src: string, baseDir: string | null, home: string | null): string | null {
  if (/^(https?:|data:|agentmux-file:|blob:)/i.test(src)) return null
  let p = src
  try {
    p = decodeURI(src)
  } catch {
    /* keep raw */
  }
  if (p.startsWith('file://')) p = p.slice(7)
  if (p.startsWith('~/') && home) return join(home, p.slice(2))
  if (p.startsWith('/')) return p
  return baseDir ? join(baseDir, p) : null
}

export const IMAGE_RE = /\.(png|jpe?g|gif|webp)$/i
export const baseName = (p: string): string => p.split('/').filter(Boolean).pop() ?? p
