import { describe, expect, it } from 'vitest'
import type { GitGraphCommit, GitGraphData } from '@shared/types'
import { appendGraphPage, getGraphNodes, graphCommits, graphLinePath, layoutGitGraph, matchesGitCommit, WORKTREE_NODE } from './gitGraph'

function commit(hash: string, parents: string[], subject = 'Update docs'): GitGraphCommit {
  return { hash, shortHash: hash.slice(0, 7), sha: hash.slice(0, 7), parents, subject, refs: [], author: 'Ana Li',
    timestamp: 1700000000000, authoredAt: 1700000000000 }
}

const root = commit('a', [])
const main = commit('b', [root.hash])
const side = commit('c', [root.hash])
const head = commit('d', [main.hash, side.hash])
const defaultData: GitGraphData = {
  commits: [], headHash: head.hash, branch: 'main', dirty: true, hasMore: false, nextSkip: 0, branches: [],
  uncommittedCount: 1, staged: 0, unstaged: 1
}

describe('SVG commit graph layout', () => {
  it('uses one lane for a linear history with straight segments', () => {
    const { rows, laneCount } = layoutGitGraph([main, root])
    expect(laneCount).toBe(1)
    expect(rows.map(({ lane }) => lane)).toEqual([0, 0])
    expect(rows[0].lines[0]).toMatchObject({ from: 0, to: 0, part: 'below' })
    expect(rows[1].lines[0]).toMatchObject({ from: 0, to: 0, part: 'above' })
    expect(graphLinePath(rows[0].lines[0])).toBe('M 12 16 V 32')
  })

  it('continues the second parent in its own lane and draws merge curves', () => {
    const { rows, laneCount } = layoutGitGraph([head, main, side, root])
    expect(laneCount).toBe(2)
    expect(rows.map(({ lane }) => lane)).toEqual([0, 0, 1, 0])
    expect(rows[0].lines.map(({ to }) => to)).toEqual([0, 1])
    expect(graphLinePath(rows[0].lines[1])).toBe('M 12 16 C 12 25, 26 23, 26 32')
    expect(rows[1].lines).toContainEqual(expect.objectContaining({ from: 1, to: 1, part: 'through' }))
    expect(rows[2].lines).toContainEqual(expect.objectContaining({ from: 1, to: 0, part: 'below' }))
  })

  it('connects the working tree to the actual HEAD lane in both rows', () => {
    const child = commit('newer', [head.hash])
    const nodes = getGraphNodes([child, head, main, side, root], head.hash, true)
    expect(nodes[1]).toEqual({ hash: WORKTREE_NODE, parents: [head.hash] })
    const { rows } = layoutGitGraph(nodes)
    expect(rows[1].lane).toBe(rows[2].lane)
    expect(rows[1].lines).toContainEqual(expect.objectContaining({ part: 'below', dashed: true }))
    expect(rows[2].lines).toContainEqual(expect.objectContaining({ part: 'above', dashed: true }))
  })

  it('omits edges and synthetic nodes whose targets are hidden', () => {
    expect(getGraphNodes([side], head.hash, true).map(({ hash }) => hash)).toEqual([side.hash])
    expect(getGraphNodes([], null, true)).toEqual([])
    expect(layoutGitGraph([head, root]).rows.flatMap((row) => row.lines)).toEqual([])
  })
})

describe('commit graph pages and search', () => {
  it('merges pages in order and moves a supplemental HEAD to its actual position once paged in', () => {
    const first = { ...defaultData, commits: [head, main], headHash: root.hash, headCommit: root, hasMore: true, nextSkip: 2 }
    const next = { ...defaultData, commits: [main, side, root], headHash: root.hash, nextSkip: 5 }
    expect(graphCommits(first).map(({ hash }) => hash)).toEqual(['d', 'b', 'a'])
    const merged = appendGraphPage(first, next)
    expect(graphCommits(merged).map(({ hash }) => hash)).toEqual(['d', 'b', 'c', 'a'])
    expect(merged).toMatchObject({ headCommit: undefined, nextSkip: 5, hasMore: false })
  })

  it('matches multiple case-insensitive terms across subject, hash and author', () => {
    const entry = commit('abcd12345678', [])
    expect(matchesGitCommit(entry, '  DOCS ana ABCD123 ')).toBe(true)
    expect(matchesGitCommit(entry, '5678')).toBe(true)
    expect(matchesGitCommit(entry, 'docs missing')).toBe(false)
    expect(matchesGitCommit(entry, '  ')).toBe(true)
  })
})
