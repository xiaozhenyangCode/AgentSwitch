import { createHash, randomUUID } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { mkdir, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { isAbsolute, join, posix } from 'node:path'
import type { CheckpointChoice, CheckpointPlan, CheckpointResult, CheckpointStatus, RewindCheckResult, RewindExecuteResult, TurnCheckpoint } from '@shared/checkpoints'
import { captureCheckpoint, checkpointChanges, checkpointGit, openCheckpointRepo, pruneHiddenObjects, publishCheckpoint, removeCheckpointRefs, type CheckpointRepo, type FileChange } from './checkpointGit'
import { CheckpointLimit, currentVersion, directoryHasOtherFiles, parentEntry, restoreFile, sameVersion, type FileVersion } from './checkpointFiles'
import { git, isInside } from './gitOps'

const allowedId = (id: string) => /^[\w-]{1,128}$/.test(id)
const overlap = (a: string, b: string) => isInside(a, b) || isInside(b, a)
const sizeLimit = (error: unknown) => error instanceof CheckpointLimit
  || (error instanceof Error && (error.cause as NodeJS.ErrnoException | undefined)?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER')

interface RecordOnDisk {
  threadId: string
  turnId: string
  repo: CheckpointRepo
  order: number
  status: CheckpointStatus | 'pending' | 'unchanged'
  files?: string[]
  before?: string
  after?: string
  permissions?: [string, number][]
}

interface Capture {
  dir: string
  overlap: boolean
  record?: RecordOnDisk
}

interface InspectedChange extends FileChange {
  current: FileVersion | null
  parent: Awaited<ReturnType<typeof parentEntry>>
  group: string
  blocked: boolean
}

export class Checkpoints {
  private readonly dir: string
  private sequence = 0
  private readonly running = new Map<string, Capture>()
  private operations = Promise.resolve<unknown>(undefined)
  private restoring: string | null = null

  constructor(
    private readonly data: string,
    private readonly options: { retain?: number; maxFiles?: number; gitAvailable?: () => Promise<boolean> } = {}
  ) {
    this.dir = join(data, 'checkpoints')
  }

  isRestoring(dir: string): boolean {
    if (this.restoring === null) return false
    try {
      return overlap(this.restoring, realpathSync(dir))
    } catch {
      return false
    }
  }

  private async available() {
    return this.options.gitAvailable?.() ?? git(this.data, ['--version']).then(() => true, () => false)
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.operations.then(operation, operation)
    this.operations = next
    return next
  }

  private file(id: string) {
    return join(this.dir, id + '.json')
  }

  private async read(id: string): Promise<RecordOnDisk | null> {
    try {
      const record: RecordOnDisk | null = JSON.parse(await readFile(this.file(id), 'utf8'))
      if (record?.turnId !== id || typeof record.repo?.root !== 'string' || !isAbsolute(record.repo.root)
        || typeof record.repo.gitDir !== 'string' || !isAbsolute(record.repo.gitDir)
        || [record.before, record.after].some((oid) => oid !== undefined && !/^([a-f0-9]{40}|[a-f0-9]{64})$/.test(oid))) {
        throw new Error('Invalid checkpoint record')
      }
      return record
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
  }

  private async records(): Promise<RecordOnDisk[]> {
    const names = await readdir(this.dir).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return []
      throw error
    })
    const ids = names.filter((name) => name.endsWith('.json')).map((name) => name.slice(0, -5)).filter(allowedId)
    const records: RecordOnDisk[] = []
    for (const id of ids) {
      const record = await this.read(id).catch(() => null)
      if (record) records.push(record)
    }
    return records
  }

  private async save(record: RecordOnDisk) {
    await mkdir(this.dir, { recursive: true, mode: 0o700 })
    const temp = join(this.dir, randomUUID() + '.tmp')
    try {
      await writeFile(temp, JSON.stringify(record), { flag: 'wx', flush: true, mode: 0o600 })
      await rename(temp, this.file(record.turnId))
    } finally {
      await rm(temp, { force: true })
    }
  }

  private markOverlap(turnId: string, capture: Capture) {
    for (const [id, other] of this.running) {
      if (id !== turnId && overlap(capture.dir, other.dir)) capture.overlap = other.overlap = true
    }
  }

  async begin(threadId: string, turnId: string, cwd: string): Promise<void> {
    if (!allowedId(turnId) || this.running.has(turnId)) return
    const capture: Capture = { dir: cwd, overlap: false }
    this.running.set(turnId, capture)
    const order = this.sequence = Math.max(Date.now(), this.sequence + 1)
    try {
      capture.dir = await realpath(cwd)
      this.markOverlap(turnId, capture)
      if (!await this.available() || await this.read(turnId)) return
      const repo = await openCheckpointRepo(capture.dir, this.data)
      capture.dir = repo.root
      this.markOverlap(turnId, capture)
      // Still snapshot overlapping turns, so finish can tell whether the project changed and say why undo is unavailable.
      const record: RecordOnDisk = { threadId, turnId, repo, order, status: 'pending' }
      capture.record = record
      const before = await captureCheckpoint(repo, 'before', this.options.maxFiles)
      record.before = before.sha
      await this.save(record)
      await publishCheckpoint(repo, turnId, 'before', before.sha)
      record.permissions = before.permissions
    } catch (error) {
      const record = capture.record
      if (record) {
        await this.discard(record, sizeLimit(error) ? 'tooLarge' : undefined).catch(() => {})
        capture.record = undefined
      }
    }
  }

  async finish(threadId: string, turnId: string): Promise<void> {
    const capture = this.running.get(turnId)
    if (!capture) return
    try {
      const record = capture.record
      if (!record || record.threadId !== threadId) return
      await this.enqueue(async () => {
        try {
          if (record.before) {
            const { sha: after } = await captureCheckpoint(record.repo, 'after', this.options.maxFiles)
            record.after = after
            await this.save({ ...record, permissions: undefined })
            await publishCheckpoint(record.repo, turnId, 'after', after)
            const files = (await checkpointChanges(record.repo, record.before, after)).map((change) => change.path)
            if (!capture.overlap) {
              const changed = new Set(files)
              const permissions = record.permissions?.filter(([path]) => changed.has(path))
              await this.save({ ...record, after, status: files.length ? 'ready' : 'unchanged', files, permissions })
              await this.prune(record.repo).catch(() => {})
              return
            }
            // Another turn changed the same project meanwhile: the changes cannot be attributed, so explain instead of offering undo.
            if (files.length) {
              await this.discard(record, 'overlap')
              return
            }
          }
          await this.discard(record)
        } catch (error) {
          await this.discard(record, sizeLimit(error) ? 'tooLarge' : undefined).catch(() => {})
        }
      })
    } finally {
      this.running.delete(turnId)
    }
  }

  private async discard(record: RecordOnDisk, keep?: CheckpointStatus) {
    await removeCheckpointRefs(record.repo, record.turnId, this.data, record)
    if (keep) await this.save({
      ...record, status: keep, files: undefined, before: undefined, after: undefined, permissions: undefined
    })
    else await rm(this.file(record.turnId), { force: true })
  }

  private async prune(repo: CheckpointRepo) {
    const records = (await this.records()).filter((record) => (record.before || record.after) && record.repo.gitDir === repo.gitDir)
    const abandoned = records.filter((record) => record.status === 'pending' && !this.running.has(record.turnId))
    const expired = records.filter((record) => record.status !== 'pending')
      .sort((a, b) => b.order - a.order).slice(this.options.retain ?? 50)
    for (const record of [...abandoned, ...expired]) {
      await this.discard(record, record.status === 'undone' ? 'undone' : undefined).catch(() => {})
    }
    if (repo.hidden && (abandoned.length || expired.length)) await pruneHiddenObjects(repo)
  }

  async deleteThread(threadId: string): Promise<string[]> {
    return this.enqueue(async () => {
      const failed: string[] = []
      for (const record of await this.records()) {
        if (record.threadId !== threadId) continue
        try {
          await this.discard(record)
        } catch {
          failed.push(record.repo.root)
        }
      }
      return [...new Set(failed)]
    })
  }

  async list(threadId: string): Promise<TurnCheckpoint[]> {
    const records = (await this.records()).filter((r) => r.threadId === threadId)
    if (!records.length || !await this.available()) return []
    return records.flatMap(({ status, turnId }) =>
      status === 'pending' || status === 'unchanged' ? [] : [{ status, turnId }]
    )
  }

  private async inspect(record: RecordOnDisk) {
    const { repo, before, after } = record
    if (!before || !after || await realpath(repo.root) !== repo.root) throw new Error('Checkpoint unavailable')
    const changes = await checkpointChanges(repo, before, after)
    const laterFiles = new Set((await this.records()).flatMap((later) =>
      later.threadId === record.threadId && later.order > record.order && later.repo.root === repo.root ? later.files ?? [] : []
    ))
    const algorithm: 'sha1' | 'sha256' = changes.some(({ before, after }) => (before ?? after)?.oid.length === 64) ? 'sha256' : 'sha1'
    const groups = new Map<string, string>()
    const afterDirectories = new Set<string>()
    const paths = new Set(changes.map(({ path }) => path))
    const removable = new Set(changes.filter(({ before }) => !before).map(({ path }) => path))
    // A file can become a directory or vice versa. Undo dependent paths together.
    for (const { path, after } of changes) {
      let group = path
      for (let parent = posix.dirname(path); parent !== '.'; parent = posix.dirname(parent)) {
        if (paths.has(parent)) group = parent
        if (after) afterDirectories.add(parent)
      }
      groups.set(path, group)
    }
    const entries: InspectedChange[] = []
    const conflicting = new Set<string>()
    const token = createHash('sha256')
    for (const change of changes) {
      const { path, after } = change
      const parent = await parentEntry(repo.root, path)
      const current = await currentVersion(repo.root, path, algorithm)
      const group = groups.get(path)!
      const isDirectory = current?.mode === 'directory'
      const expectedDirectory = !after && isDirectory && afterDirectories.has(path)
      const blocked = current?.mode === 'special' || (parent === 'blocked' && group === path)
        || (isDirectory && await directoryHasOtherFiles(join(repo.root, path), path, removable))
      if ((!sameVersion(current, after) && !expectedDirectory) || laterFiles.has(path) || blocked) conflicting.add(group)
      entries.push({ ...change, current, parent, group, blocked })
      token.update(JSON.stringify([path, change.before, after, current, parent, blocked, conflicting.has(group)]))
    }
    const conflicts = entries.filter((entry) => conflicting.has(entry.group)).map((entry) => entry.path)
    const plan: CheckpointPlan = { kind: 'plan', token: token.digest('hex'), files: changes.map((change) => change.path), conflicts }
    return { plan, entries, algorithm }
  }

  action(threadId: string, turnId: string, busy: (root: string) => boolean, token?: string, choice?: CheckpointChoice): Promise<CheckpointResult> {
    return this.enqueue(async () => {
      if (!allowedId(turnId)) return { kind: 'unavailable' }
      try {
        const record = await this.read(turnId)
        if (!record || record.threadId !== threadId || record.status !== 'ready') return { kind: 'unavailable' }
        const { repo } = record
        if (busy(repo.root)) return { kind: 'busy' }
        if (token) this.restoring = repo.root
        const { plan, entries, algorithm } = await this.inspect(record)
        if (!token || token !== plan.token) return plan

        const conflicts = new Set(plan.conflicts)
        const selected = entries.filter((entry) => choice === 'overwrite' || !conflicts.has(entry.path))
        let restored = 0
        let failed = 0
        const permissions = new Map(record.permissions)
        const failedGroups = new Set(selected.filter(({ blocked }) => blocked).map(({ group }) => group))
        const groupSizes = new Map<string, number>()
        for (const entry of selected) {
          groupSizes.set(entry.group, (groupSizes.get(entry.group) ?? 0) + 1)
          // Recheck each group before touching any of its paths.
          if (!sameVersion(await currentVersion(repo.root, entry.path, algorithm), entry.current)) failedGroups.add(entry.group)
        }
        // Remove files first so their names can become directories during restoration.
        selected.sort((a, b) => Number(!!a.before) - Number(!!b.before))
        for (const entry of selected) {
          if (failedGroups.has(entry.group)) {
            failed++
            continue
          }
          try {
            const bytes = entry.before
              ? await checkpointGit(repo, ['cat-file', 'blob', entry.before.oid], { maxBuffer: 21 * 1024 * 1024 })
              : undefined
            if (groupSizes.get(entry.group) === 1 && !sameVersion(await currentVersion(repo.root, entry.path, algorithm), entry.current)) {
              throw new Error('Checkpoint file changed')
            }
            // An ancestor file can stand in for an absent descendant.
            if (entry.before || entry.parent === 'directory' || entry.current) {
              await restoreFile(repo.root, entry.path, entry.before, bytes, permissions.get(entry.path))
            }
            restored++
          } catch {
            failedGroups.add(entry.group)
            failed++
          }
        }

        if (failed) return { kind: 'partial', restored, failed }
        await this.save({ ...record, status: 'undone' })
        return { kind: 'undone', restored, skipped: entries.length - selected.length }
      } catch {
        return { kind: 'failed' }
      } finally {
        this.restoring = null
      }
    })
  }

  /**
   * Read-only pre-flight inspection for rewinding a conversation from `turnIds` onward.
   * Verifies every checkpoint in range before any files or chat state are touched.
   */
  planRewind(threadId: string, turnIds: string[], busy: (root: string) => boolean): Promise<RewindCheckResult> {
    return this.enqueue(async () => {
      const validIds = [...new Set(turnIds.filter(allowedId))]
      if (!validIds.length) return { kind: 'invalid', reason: 'No target turns' }
      const turnSet = new Set(validIds)
      if ([...this.running.values()].some((c) => c.record?.threadId === threadId)) return { kind: 'busy' }

      const all = (await this.records())
        .filter((r) => r.threadId === threadId && turnSet.has(r.turnId))
        .sort((a, b) => b.order - a.order)

      if (!all.length) return { kind: 'ready', checkpointTurnIds: [], files: [], conflicts: [], unavailableTurnIds: [] }
      if (!await this.available()) {
        return { kind: 'ready', checkpointTurnIds: [], files: [], conflicts: [], unavailableTurnIds: all.map((r) => r.turnId) }
      }

      const checkedRoots = new Set<string>()
      for (const r of all) {
        if (!checkedRoots.has(r.repo.root)) {
          checkedRoots.add(r.repo.root)
          if (busy(r.repo.root)) return { kind: 'busy' }
        }
      }

      const checkpointTurnIds: string[] = []
      const unavailableTurnIds: string[] = []
      const fileSet = new Set<string>()
      const conflictSet = new Set<string>()
      for (const record of all) {
        if (record.status === 'unchanged' || record.status === 'undone') continue
        if (record.status !== 'ready') {
          unavailableTurnIds.push(record.turnId)
          continue
        }
        try {
          const { plan } = await this.inspect(record)
          checkpointTurnIds.push(record.turnId)
          for (const f of plan.files) fileSet.add(f)
          for (const c of plan.conflicts) conflictSet.add(c)
        } catch {
          unavailableTurnIds.push(record.turnId)
        }
      }
      return {
        kind: 'ready',
        checkpointTurnIds,
        files: [...fileSet],
        conflicts: [...conflictSet],
        unavailableTurnIds
      }
    })
  }

  /**
   * Atomically validates and (when `restoreFiles` is true) restores workspace files across all
   * checkpoints in `turnIds` from newest -> oldest, then discards the truncated checkpoint records.
   * If any pre-check fails, refuses BEFORE modifying any file or discarding any checkpoint.
   */
  rewind(
    threadId: string,
    turnIds: string[],
    restoreFiles: boolean,
    busy: (root: string) => boolean,
    choice: CheckpointChoice = 'overwrite'
  ): Promise<RewindExecuteResult> {
    return this.enqueue(async () => {
      const validIds = [...new Set(turnIds.filter(allowedId))]
      if (!validIds.length) return { kind: 'invalid', reason: 'No target turns' }
      if ([...this.running.values()].some((c) => c.record?.threadId === threadId)) return { kind: 'busy' }

      const turnSet = new Set(validIds)
      const all = (await this.records())
        .filter((r) => r.threadId === threadId && turnSet.has(r.turnId))
        .sort((a, b) => b.order - a.order)

      const checkedRoots = new Set<string>()
      for (const r of all) {
        if (!checkedRoots.has(r.repo.root)) {
          checkedRoots.add(r.repo.root)
          if (busy(r.repo.root)) return { kind: 'busy' }
        }
      }

      let totalRestored = 0
      let totalSkipped = 0

      if (restoreFiles && all.length) {
        if (!await this.available()) return { kind: 'unavailable', reason: 'Git is not available to restore checkpoints' }

        const readyRecords: RecordOnDisk[] = []
        for (const record of all) {
          if (record.status === 'unchanged' || record.status === 'undone') continue
          if (record.status !== 'ready') {
            return { kind: 'unavailable', reason: `Checkpoint for turn ${record.turnId} is ${record.status}` }
          }
          readyRecords.push(record)
        }

        // Phase 1: Validate every checkpoint & every readable blob BEFORE touching any file on disk.
        type PreparedStep = {
          record: RecordOnDisk
          selected: (InspectedChange & { bytes?: Buffer })[]
          skipped: number
          permissions: Map<string, number>
          algorithm: 'sha1' | 'sha256'
        }
        const prepared: PreparedStep[] = []
        for (const record of readyRecords) {
          let inspected: Awaited<ReturnType<Checkpoints['inspect']>>
          try {
            inspected = await this.inspect(record)
          } catch {
            return { kind: 'unavailable', reason: `Checkpoint snapshot for turn ${record.turnId} is missing or unreadable` }
          }
          const conflicts = new Set(inspected.plan.conflicts)
          const selected = inspected.entries.filter((entry) => choice === 'overwrite' || !conflicts.has(entry.path))
          if (selected.some((entry) => entry.blocked)) {
            return { kind: 'unavailable', reason: `Cannot restore blocked path in turn ${record.turnId}` }
          }
          const loaded: (InspectedChange & { bytes?: Buffer })[] = []
          for (const entry of selected) {
            try {
              const bytes = entry.before
                ? await checkpointGit(record.repo, ['cat-file', 'blob', entry.before.oid], { maxBuffer: 21 * 1024 * 1024 })
                : undefined
              loaded.push({ ...entry, bytes })
            } catch {
              return { kind: 'unavailable', reason: `Snapshot blob unreadable for ${entry.path}` }
            }
          }
          loaded.sort((a, b) => Number(!!a.before) - Number(!!b.before))
          prepared.push({
            record,
            selected: loaded,
            skipped: inspected.entries.length - selected.length,
            permissions: new Map(record.permissions),
            algorithm: inspected.algorithm
          })
        }

        // Phase 2: Restore turns strictly from newest -> oldest so each file returns to pre-target state.
        let totalFailed = 0
        try {
          for (const step of prepared) {
            this.restoring = step.record.repo.root
            for (const entry of step.selected) {
              try {
                if (entry.before || entry.parent === 'directory' || entry.current) {
                  await restoreFile(step.record.repo.root, entry.path, entry.before, entry.bytes, step.permissions.get(entry.path))
                }
                totalRestored++
              } catch {
                totalFailed++
              }
            }
            totalSkipped += step.skipped
            if (totalFailed > 0) {
              return { kind: 'partial', restored: totalRestored, failed: totalFailed, reason: 'Some files could not be restored' }
            }
          }
        } finally {
          this.restoring = null
        }
      }

      // Phase 3: Discard truncated checkpoint records & refs (only after restore succeeded or wasn't requested).
      const hiddenRepos = new Map<string, CheckpointRepo>()
      for (const record of all) {
        if (record.repo.hidden) hiddenRepos.set(record.repo.gitDir, record.repo)
        await this.discard(record).catch(() => {})
      }
      for (const repo of hiddenRepos.values()) await pruneHiddenObjects(repo).catch(() => {})

      return { kind: 'ok', restored: totalRestored, skipped: totalSkipped, clearedSessions: false }
    })
  }
}
