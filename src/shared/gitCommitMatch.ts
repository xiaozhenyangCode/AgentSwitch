import type { GitGraphCommit } from './types'

export function normalizeGitCommitQuery(value: unknown): string {
  if (typeof value !== 'string' || value.includes('\0')) return ''
  const query = value.trim()
  return query.length <= 200 ? query : ''
}

export function matchesGitCommit(commit: GitGraphCommit, query: string): boolean {
  const terms = query.trim().toLowerCase().split(/\s+/)
  const text = [commit.subject, commit.hash, commit.shortHash, commit.author].join(' ').toLowerCase()
  return terms.every((term) => text.includes(term))
}
