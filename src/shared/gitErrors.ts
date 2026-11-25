import type { GitErrorCode } from './types'

export function classifyGitError(stderr: string): GitErrorCode | undefined {
  if (/index\.lock|unable to (?:lock|write.*) (?:the )?index/i.test(stderr)) return 'indexLocked'
  if (/resolve your current index first|unmerged files|needs merge|fix conflicts and then commit|^CONFLICT \(|automatic merge failed/im.test(stderr)) return 'unmerged'
  if (/local changes to the following files would be overwritten by merge|untracked working tree files would be overwritten by merge/i.test(stderr)) return 'localChanges'
  if (/local changes.*would be overwritten|untracked working tree files.*would be overwritten/i.test(stderr)) return 'switchChanges'
  if (/not possible to fast-forward|divergent branches/i.test(stderr)) return 'diverged'
  if (/no (?:tracking information|upstream|push remote)|upstream is not a remote branch/i.test(stderr)) return 'noUpstream'
  if (/authentication failed|could not read (?:username|password)|unable to get password|terminal prompts disabled|permission denied \(publickey|invalid username or (?:password|token)|(?:returned error|status code):? (?:401|403)\b/i.test(stderr)) return 'auth'
  if (/non-fast-forward|\[rejected\].*(?:fetch first|non-fast-forward)|\[remote rejected\]/i.test(stderr)) return 'pushRejected'
}
