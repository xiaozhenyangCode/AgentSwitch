export type CheckpointStatus = 'ready' | 'tooLarge' | 'overlap' | 'undone'
export interface TurnCheckpoint {
  turnId: string
  status: CheckpointStatus
}

export interface CheckpointPlan {
  kind: 'plan'
  token: string
  files: string[]
  conflicts: string[]
}

export type CheckpointResult = CheckpointPlan
  | { kind: 'undone'; restored: number; skipped: number }
  | { kind: 'busy' | 'unavailable' | 'failed' }
  | { kind: 'partial'; failed: number; restored: number }

export type CheckpointChoice = 'skip' | 'overwrite'
