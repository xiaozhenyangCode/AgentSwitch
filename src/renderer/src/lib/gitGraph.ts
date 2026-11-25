import type { GitGraphCommit, GitGraphData } from '@shared/types'
import type { GitLogEntry } from '@tomplum/react-git-log'

export const WORKTREE_NODE = ':worktree'
export const CHECKED_OUT_LANE = ':checked-out'

export function toGitGraphEntries(data: GitGraphData): GitLogEntry[] {
  const loaded = new Set(data.commits.map(({ hash }) => hash))
  const entries = data.commits.map((commit): GitLogEntry => ({
    hash: commit.hash,
    parents: commit.parents.filter((parent) => loaded.has(parent)),
    branch: !data.dirty && commit.hash === data.headHash ? CHECKED_OUT_LANE : '',
    message: commit.subject,
    author: { name: commit.author },
    authorDate: new Date(commit.timestamp).toISOString(),
    committerDate: ''
  }))
  if (data.dirty) {
    const headIndex = entries.findIndex(({ hash }) => hash === data.headHash)
    entries.splice(Math.max(0, headIndex), 0, {
      hash: WORKTREE_NODE,
      parents: headIndex >= 0 && data.headHash ? [data.headHash] : [],
      branch: CHECKED_OUT_LANE,
      message: '',
      committerDate: ''
    })
  }
  // The library sorts its input by committerDate. Keep Git's topological order,
  // including the worktree node, and show the real author dates in the rows.
  return entries.map((entry, index) => ({ ...entry, committerDate: new Date(entries.length - index).toISOString() }))
}

export function matchesGitCommit(commit: GitGraphCommit, query: string): boolean {
  const terms = query.trim().toLowerCase().split(/\s+/)
  const text = [commit.subject, commit.hash, commit.shortHash, commit.author].join(' ').toLowerCase()
  return terms.every((term) => text.includes(term))
}
