import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readlink, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, posix, resolve } from 'node:path'
import { entryAt, CheckpointLimit, CHECKPOINT_MAX_BYTES, fileMode, parentEntry, SKIP_DIRS, SNAPSHOT_MAX_FILES, validPath, type FileVersion } from './checkpointFiles'
import { gitBytes } from './gitOps'

export interface CheckpointRepo {
  root: string
  gitDir: string
  hidden: boolean
}

export interface FileChange {
  path: string
  before: FileVersion | null
  after: FileVersion | null
}

const args = [
  '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false', '-c', 'maintenance.auto=false', '-c', 'gc.auto=0',
  '-c', 'core.fsmonitor=false', '-c', 'core.splitIndex=false', '-c', 'core.untrackedCache=false'
]
const identity = {
  GIT_AUTHOR_NAME: 'AgentSwitch', GIT_AUTHOR_EMAIL: 'checkpoints@agentswitch.app',
  GIT_COMMITTER_NAME: 'AgentSwitch', GIT_COMMITTER_EMAIL: 'checkpoints@agentswitch.app',
  GIT_AUTHOR_DATE: undefined, GIT_COMMITTER_DATE: undefined, GIT_NO_REPLACE_OBJECTS: '1',
  GIT_NO_LAZY_FETCH: '1'
}
const command = (cwd: string, commandArgs: string[], options: Parameters<typeof gitBytes>[2] = {}) =>
  gitBytes(cwd, [...args, ...commandArgs], { ...options, env: { ...identity, ...options.env } })

export async function openCheckpointRepo(cwd: string, data: string): Promise<CheckpointRepo> {
  const dir = await realpath(cwd)
  let top: Buffer | undefined
  try {
    top = await command(dir, ['rev-parse', '--show-toplevel'])
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes('not a git repository')) throw error
  }
  if (top) {
    const root = await realpath(top.toString().replace(/\n$/, ''))
    const common = (await command(root, ['rev-parse', '--git-common-dir'])).toString().replace(/\n$/, '')
    return { root, gitDir: await realpath(resolve(root, common)), hidden: false }
  }
  const gitDir = join(data, '.checkpoint-repos', createHash('sha256').update(dir).digest('hex'))
  if (!await entryAt(join(gitDir, 'HEAD'))) {
    await mkdir(dirname(gitDir), { recursive: true, mode: 0o700 })
    await command(data, ['init', '--bare', '--quiet', '--template=', '--', gitDir])
  }
  return { root: dir, gitDir, hidden: true }
}

export function checkpointGit(repo: CheckpointRepo, commandArgs: string[], options?: Parameters<typeof gitBytes>[2]) {
  return command(repo.root, ['--git-dir=' + repo.gitDir, '--work-tree=' + repo.root, ...commandArgs], options)
}

export const checkpointRef = (id: string, side: 'before' | 'after') => `refs/agentswitch/checkpoints/${id}/${side}`

function pathTokens(data: Buffer): string[] {
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(data).split('\0').filter(Boolean)
}

export async function captureCheckpoint(repo: CheckpointRepo, side: 'before' | 'after', maxFiles = SNAPSHOT_MAX_FILES) {
  const listArgs = ['ls-files', '-z', '--others', '--exclude-standard']
  // A linked worktree's tracked file list lives in its own index.
  const options = { maxBuffer: 32 * 1024 * 1024 }
  const tracked = new Set<string>()
  const gitLinks = new Set<string>()
  let untracked: Buffer
  if (repo.hidden) {
    untracked = await checkpointGit(repo, [...listArgs, ...[...SKIP_DIRS].map((dir) => `--exclude=${dir}/`)], options)
  } else {
    const [staged, others] = await Promise.all([
      command(repo.root, ['ls-files', '-z', '--stage'], options),
      command(repo.root, listArgs, options)
    ])
    for (const row of pathTokens(staged)) {
      const path = row.slice(row.indexOf('\t') + 1)
      if (row.startsWith('160000 ')) gitLinks.add(path)
      else tracked.add(path)
    }
    untracked = others
  }
  const paths = [...new Set([...tracked, ...pathTokens(untracked)])].filter((path) =>
    validPath(path) && !gitLinks.has(path) && (!repo.hidden || !path.split('/').slice(0, -1).some((part) => SKIP_DIRS.has(part)))
  )
  if (paths.length > maxFiles) throw new CheckpointLimit()

  const temp = await mkdtemp(join(tmpdir(), 'agentswitch-checkpoint-'))
  const env = { GIT_INDEX_FILE: join(temp, 'index') }
  try {
    const entries: string[] = []
    const permissions: [string, number][] = []
    const regular: { path: string; mode: string }[] = []
    let argBytes = 0
    const flush = async () => {
      if (!regular.length) return
      // Hash the on-disk bytes so attributes and external clean filters cannot change the snapshot.
      const hashes = (await checkpointGit(repo, ['hash-object', '-w', '--no-filters', '--', ...regular.map((f) => f.path)])).toString().trimEnd().split('\n')
      for (const [i, file] of regular.entries()) entries.push(`${file.mode} ${hashes[i]}\t${file.path}\0`)
      regular.length = 0
      argBytes = 0
    }
    for (const path of paths) {
      if (await parentEntry(repo.root, path) !== 'directory') continue
      const target = join(repo.root, path)
      const entry = await entryAt(target)
      if (!entry || entry.isDirectory()) continue
      if (entry.size > CHECKPOINT_MAX_BYTES) throw new CheckpointLimit()
      if (entry.isSymbolicLink()) {
        const input = await readlink(target, { encoding: 'buffer' })
        const oid = (await checkpointGit(repo, ['hash-object', '-w', '--stdin'], { input })).toString().trim()
        entries.push(`120000 ${oid}\t${path}\0`)
      } else if (entry.isFile()) {
        regular.push({ path, mode: fileMode(entry.mode) })
        if (side === 'before') permissions.push([path, entry.mode & 0o777])
        argBytes += Buffer.byteLength(path) + 1
        if (argBytes >= 32 * 1024) await flush()
      }
    }
    await flush()
    if (entries.length) {
      await checkpointGit(repo, ['update-index', '-z', '--index-info'], { env, input: Buffer.from(entries.join('')) })
    }
    const tree = (await checkpointGit(repo, ['write-tree'], { env })).toString().trim()
    const sha = (await checkpointGit(repo, ['commit-tree', tree, '--no-gpg-sign', '-m', `AgentSwitch checkpoint ${side}`, '-m', randomUUID()])).toString().trim()
    return { sha, permissions }
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
}

export async function checkpointChanges(repo: CheckpointRepo, before: string, after: string): Promise<FileChange[]> {
  const diff = await checkpointGit(repo, ['diff-tree', '-r', '--raw', '-z', '--no-renames', '--no-abbrev',
    before, after, '--'], { maxBuffer: 32 * 1024 * 1024 })
  const tokens = pathTokens(diff)
  const changes: FileChange[] = []
  for (let i = 0; i < tokens.length; i += 2) {
    const [oldMode, newMode, oldOid, newOid] = tokens[i].slice(1).split(' ')
    const path = tokens[i + 1]
    if (!validPath(path) || ![oldMode, newMode].every((mode) => /^(000000|100644|100755|120000)$/.test(mode))) {
      throw new Error('Invalid checkpoint entry')
    }
    changes.push({
      path,
      before: oldMode === '000000' ? null : { mode: oldMode, oid: oldOid },
      after: newMode === '000000' ? null : { mode: newMode, oid: newOid }
    })
  }
  return changes
}

export async function publishCheckpoint(repo: CheckpointRepo, id: string, side: 'before' | 'after', sha: string) {
  await checkpointGit(repo, ['update-ref', '--no-deref', checkpointRef(id, side), sha, '0'.repeat(sha.length)])
}

export async function removeCheckpointRefs(repo: CheckpointRepo, id: string, data: string, owned: {
  before?: string; after?: string
}) {
  if ((!owned.before && !owned.after) || !await entryAt(repo.gitDir)) return
  // The worktree can be gone while its shared or hidden repository still exists.
  const prefix = ['--git-dir=' + repo.gitDir]
  const base = posix.dirname(checkpointRef(id, 'before'))
  const listed = (await command(data, [...prefix, 'for-each-ref', '--format=%(refname)%00%(objectname)%00%(symref)', base])).toString()
  const directRefs = new Map<string, string>()
  for (const line of listed.split('\n')) {
    const [ref, oid, symbolic] = line.split('\0')
    if (oid && !symbolic) directRefs.set(ref, oid)
  }
  const deletes: string[] = []
  for (const side of ['before', 'after'] as const) {
    const ref = checkpointRef(id, side)
    const sha = owned[side]
    if (sha && directRefs.get(ref) === sha) deletes.push(`option no-deref\ndelete ${ref} ${sha}\n`)
  }
  if (deletes.length) {
    await command(data, [...prefix, 'update-ref', '--stdin'], { input: Buffer.from(deletes.join('')) })
  }
}

export function pruneHiddenObjects(repo: CheckpointRepo) {
  // Disable detaching so maintenance cannot outlive the application's repository operation.
  return checkpointGit(repo, ['-c', 'gc.auto=6700', '-c', 'gc.autoDetach=false', 'gc', '--auto'])
}
