import type { GitGraphCommit, GitGraphData } from '@shared/types'
export { matchesGitCommit } from '@shared/gitCommitMatch'

export const WORKTREE_NODE = ':worktree'
export const GRAPH_ROW_HEIGHT = 32
export const GRAPH_LEFT_PAD = 12
export const GRAPH_LANE_GAP = 14

export interface GraphNode {
  hash: string
  parents: string[]
}

export type GraphLine = {
  from: number
  to: number
  color: number
  part: 'above' | 'below' | 'through'
  dashed?: boolean
}

export interface GraphRow {
  hash: string
  lane: number
  color: number
  lines: GraphLine[]
}

export function appendGraphPage(previous: GitGraphData, page: GitGraphData): GitGraphData {
  const commits = new Map(previous.commits.map((commit) => [commit.hash, commit]))
  for (const commit of page.commits) commits.set(commit.hash, commit)
  const headCommit = page.headCommit ?? previous.headCommit
  return {
    ...page, commits: [...commits.values()],
    headCommit: headCommit?.hash === page.headHash && !commits.has(headCommit.hash) ? headCommit : undefined
  }
}

export function graphCommits(data: GitGraphData): GitGraphCommit[] {
  return data.headCommit && !data.commits.some(({ hash }) => hash === data.headCommit?.hash)
    ? [...data.commits, data.headCommit]
    : data.commits
}

export function getGraphNodes(commits: GitGraphCommit[], headHash: string | null, dirty: boolean): GraphNode[] {
  const nodes: GraphNode[] = [...commits]
  const headIndex = commits.findIndex(({ hash }) => hash === headHash)
  if (dirty && headHash && headIndex >= 0) nodes.splice(headIndex, 0, { hash: WORKTREE_NODE, parents: [headHash] })
  return nodes
}

/** Each active lane is waiting for a visible ancestor. Its color follows the first parent. */
export function layoutGitGraph(nodes: GraphNode[]): { rows: GraphRow[]; laneCount: number } {
  const positions = new Map(nodes.map(({ hash }, index) => [hash, index]))
  const active: ({ hash: string; color: number; dashed?: boolean } | undefined)[] = []
  let nextColor = 0

  const freeLane = () => {
    const index = active.findIndex((slot) => !slot)
    return index < 0 ? active.length : index
  }
  const rows = nodes.map(({ hash, parents }, index): GraphRow => {
    const worktree = hash === WORKTREE_NODE
    const incomingHash = worktree ? parents[0] : hash
    const incoming = active.findIndex((slot) => slot !== undefined && slot.hash === incomingHash)
    const lane = incoming >= 0 ? incoming : freeLane()
    const color = active[lane]?.color ?? nextColor++
    const lines: GraphLine[] = []
    active.forEach((slot, column) => {
      if (!slot) return
      lines.push({
        from: column, to: column, color: slot.color,
        part: column === lane ? 'above' : 'through', dashed: slot.dashed
      })
    })
    active[lane] = undefined
    for (const [parentIndex, parent] of parents.entries()) {
      if ((positions.get(parent) ?? -1) <= index) continue
      const reserved = active.findIndex((slot) => slot?.hash === parent)
      const nextLane = reserved >= 0 ? reserved : parentIndex === 0 ? lane : freeLane()
      const parentColor = active[nextLane]?.color ?? (parentIndex === 0 ? color : nextColor++)
      active[nextLane] = { hash: parent, color: parentColor, dashed: worktree }
      lines.push({ from: lane, to: nextLane, color: parentColor, part: 'below', dashed: worktree })
    }
    return { hash, lane, color, lines }
  })
  return { rows, laneCount: Math.max(1, active.length) }
}

export function graphLinePath(line: GraphLine): string {
  const x = GRAPH_LEFT_PAD + line.from * GRAPH_LANE_GAP
  const end = GRAPH_LEFT_PAD + line.to * GRAPH_LANE_GAP
  const center = GRAPH_ROW_HEIGHT / 2
  if (line.part === 'above') return `M ${x} 0 V ${center}`
  if (line.part === 'through') return `M ${x} 0 V ${GRAPH_ROW_HEIGHT}`
  if (x === end) return `M ${x} ${center} V ${GRAPH_ROW_HEIGHT}`
  return `M ${x} ${center} C ${x} ${center + 9}, ${end} ${GRAPH_ROW_HEIGHT - 9}, ${end} ${GRAPH_ROW_HEIGHT}`
}
