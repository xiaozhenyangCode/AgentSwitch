import { describe, expect, it } from 'vitest'
import type { GitGraphCommit, GitGraphData } from '@shared/types'
import { CHECKED_OUT_LANE, matchesGitCommit, toGitGraphEntries, WORKTREE_NODE } from './gitGraph'

function commit(hash: string, parents: string[], subject = 'Update docs'): GitGraphCommit {
  return { hash, shortHash: hash.slice(0, 7), sha: hash.slice(0, 7), parents, subject, refs: [], author: 'Ana Li',
    timestamp: 1700000000000, authoredAt: 1700000000000 }
}

const other = commit('abcd12345678', ['outside-limit'])
const head = commit('12345678abcd', [])
const data: GitGraphData = {
  commits: [other, head], headHash: head.hash, branch: 'main', dirty: true,
  uncommittedCount: 1, staged: 0, unstaged: 1
}

describe('Git graph entries', () => {
  it('places the worktree node immediately above HEAD and drops parents outside the history window', () => {
    const rows = toGitGraphEntries(data)
    expect(rows.map((row) => row.hash)).toEqual([other.hash, WORKTREE_NODE, head.hash])
    expect(rows[0].parents).toEqual([])
    expect(rows[1]).toMatchObject({ branch: CHECKED_OUT_LANE, parents: [head.hash] })
    expect(rows[2].authorDate).toBe(new Date(head.timestamp).toISOString())
    expect(rows.map((row) => row.committerDate)).toEqual([...rows.map((row) => row.committerDate)].sort().reverse())
  })

  it('handles clean and unborn worktrees', () => {
    const clean = toGitGraphEntries({ ...data, dirty: false })
    expect(clean.map((entry) => [entry.hash, entry.branch])).toEqual([[other.hash, ''], [head.hash, CHECKED_OUT_LANE]])
    expect(toGitGraphEntries({ ...data, commits: [], headHash: null })).toMatchObject([{ hash: WORKTREE_NODE, parents: [] }])
    expect(toGitGraphEntries({ ...data, commits: [], headHash: null, dirty: false })).toEqual([])
  })

  it('matches multiple search terms across title, author and hashes', () => {
    expect(matchesGitCommit(other, '  DOCS ana ABCD123 ')).toBe(true)
    expect(matchesGitCommit(other, '5678')).toBe(true)
    expect(matchesGitCommit(other, 'docs missing')).toBe(false)
    expect(matchesGitCommit(other, '  ')).toBe(true)
  })
})
