/**
 * Blanks out fenced code blocks (``` … ```, an unclosed fence runs to the end) and inline
 * `code` with spaces of the same length, so @mentions inside pasted code or examples are not
 * matched while indices still line up with the original text.
 */
export function maskCode(text: string): string {
  const blank = (m: string) => m.replace(/[^\n]/g, ' ')
  return text.replace(/```[\s\S]*?(?:```|$)/g, blank).replace(/`[^`\n]+`/g, blank)
}
