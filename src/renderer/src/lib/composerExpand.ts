export const COMPOSER_MAX_HEIGHT = 200
const EXPAND_AFTER_LINES = 5
const ROUNDING_TOLERANCE = 1

export function showComposerExpand({
  expanded, hasText, scrollHeight, clientHeight, padding, lineHeight
}: {
  expanded: boolean
  hasText: boolean
  scrollHeight: number
  clientHeight: number
  padding: number
  lineHeight: number
}): boolean {
  return expanded || (hasText && (
    scrollHeight - padding > EXPAND_AFTER_LINES * lineHeight + ROUNDING_TOLERANCE ||
    scrollHeight > clientHeight + ROUNDING_TOLERANCE
  ))
}

export function nextComposerExpanded(expanded: boolean, action: 'toggle' | 'escape' | 'send' | 'thread'): boolean {
  return action === 'toggle' && !expanded
}

export function composerEscapeAction({
  expanded, composing, higherLayer, extensionsOpen, mention, slash, file, ghost
}: {
  expanded: boolean
  composing: boolean
  higherLayer: boolean
  extensionsOpen: boolean
  mention: boolean
  slash: boolean
  file: boolean
  ghost: boolean
}): 'mention' | 'slash' | 'file' | 'ghost' | 'collapse' | null {
  if (composing || higherLayer || extensionsOpen) return null
  if (mention) return 'mention'
  if (slash) return 'slash'
  if (file) return 'file'
  if (ghost) return 'ghost'
  return expanded ? 'collapse' : null
}
