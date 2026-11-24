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

export interface RewindPlan {
  kind: 'ready'
  /** Turns from target onward that have ready file checkpoints (newest -> oldest). */
  checkpointTurnIds: string[]
  /** Distinct file paths touched by those turns. */
  files: string[]
  /** Files whose current disk state differs from the recorded snapshot. */
  conflicts: string[]
  /** Turns from target onward whose checkpoints exist but cannot be restored (overlap/tooLarge/broken). */
  unavailableTurnIds: string[]
}

export type RewindCheckResult =
  | RewindPlan
  | { kind: 'busy' | 'invalid' | 'unavailable'; reason?: string }

export type RewindExecuteResult =
  | { kind: 'ok'; restored: number; skipped: number; clearedSessions: boolean }
  | { kind: 'busy' | 'invalid' | 'unavailable' | 'failed'; reason?: string }
  | { kind: 'partial'; restored: number; failed: number; reason?: string }
