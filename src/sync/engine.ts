/**
 * The sync engine: architecture §7, layer 4.
 *
 * Real files on a disk somewhere so any binary works natively, with the kernel
 * remaining the source of truth. Four phases, verbatim from §7.3:
 *
 * 1. materialize (acquire)  — probe, write the branch view, freeze read-only
 *    mounts, seed the index, stamp.
 * 2. write-through          — kernel commit FIRST, then the mirror write, off
 *    the critical path; a failed mirror write marks the path dirty and is
 *    re-materialized on the next touch.
 * 3. exec capture           — one scan exec per cycle, one in flight per target,
 *    extra triggers coalesce to one follow-up, the slot released on failure.
 * 4. turn-end reconcile     — authoritative full scan, stragglers, then deletes.
 *
 * Load-bearing invariants:
 * - The engine imports {@link SyncTarget}, never a target implementation and
 *   never a provider SDK (§7.1).
 * - The target is untrusted input. Scan paths are re-validated against mount
 *   mirror directories and shas are recomputed server-side from fetched bytes
 *   (§7.3 steps 2 and 4, §13 never-do list).
 * - A failed scan is an error event, never an empty diff (§7.2).
 * - Deletes happen ONLY at reconcile (§7.4).
 * - Virtual mounts are skipped at materialize and rejected in mirror-path
 *   mapping (§6.1).
 * - The index is a CACHE, rebuildable from heads plus a full scan (§7.3 state).
 * - The straggler guard is WINDOWED, and the window is bounded by BOTH ends of
 *   the ambiguity. It opens at a Phase-2 commit and closes at the first of: a
 *   scan that observes those bytes on disk (the mirror write demonstrably
 *   landed), or an exec (everything the target holds afterwards is that exec's
 *   work). Without the exec bound the guard misreads a revert — a checkout, a
 *   formatter, an undo — as a lost mirror write and silently overwrites the
 *   agent's file; without the scan bound a genuinely lost mirror write is
 *   committed away. Neither signal alone separates the two (§7.3 phase 4).
 * - Across a warm re-acquire the guard is rebuilt from durable history: disk
 *   content the path held anywhere in its lineage is stale-but-known and the
 *   durable head wins, because the crashed process took its in-memory copy with
 *   it (§7.5).
 * - Host callbacks are untrusted: a throwing handler never aborts a capture and
 *   never rejects the fire-and-forget capture chain (§7.2).
 */
import posix from 'node:path/posix'

import { sha256 } from '../hashing.js'
import { InvariantError, NotFoundError } from '../errors.js'
import { InvalidPathError, validateMountKey, validatePath } from '../validation.js'
import type { DiffRecord, HistoryRecord, SessionFileSystem, SessionMount, WriteOptions } from '../session.js'
import type { CaptureWrite, TuddoFsLogger, WriteResult } from '../kernel.js'
import { SyncTargetError } from './errors.js'
import {
  HYDRATION_MARKER_FILENAME,
  STAMP_FILENAME,
  chmodReadOnlyCommand,
  chmodWritableCommand,
  hydrationManifestCommand,
  mirrorDirName,
  parseScanRecords,
  probeCommand,
  resolveUnderRoot,
  scanCommand,
  stampCommand,
} from './paths.js'
import { CaptureSlot } from './slot.js'
import type { ExecOptions, ExecResult, SyncTarget } from './target.js'

/** Host callbacks defined by architecture §7.2. There is no tool loop to piggyback on. */
export interface SyncEngineEvents {
  onCapture(event: { mountKey: string; commitSha: string; paths: readonly string[] }): void
  onCaptureFailed(event: { mountKey?: string; attempt: number; error: Error }): void
  onReadOnlySkipped(event: { mountKey: string; paths: readonly string[] }): void
}

/** Construction inputs for {@link createSyncEngine}. */
export interface SyncEngineOptions {
  readonly session: SessionFileSystem
  readonly target: SyncTarget
  /** Workspace root inside the target; mounts live at `<root>/<mirrorDir>`. */
  readonly root: string
  readonly events?: Partial<SyncEngineEvents>
  /** Clock for stamp arithmetic; epoch milliseconds. */
  readonly now?: () => number
  /** Files re-read and re-hashed after materialize to prove the transfer (§7.3 phase 1 step 2). */
  readonly verifySampleSize?: number
  /** Receives host-callback failures; without one they go to `console.error`, exactly as the kernel's `onCommit` hook does. */
  readonly logger?: TuddoFsLogger
}

/** The disk-level runtime for one session against one target. */
export interface SyncEngine {
  readonly root: string
  /** Phase 1. Idempotent: a hydrated workspace takes the warm path (§7.3 phase 1 step 3). */
  materialize(): Promise<void>
  /** Absolute mirror path for a governed path; throws for virtual and unknown mounts (§6.1). */
  mirrorPath(mountKey: string, path: string): string
  /** Phase 2. Commits, then mirrors asynchronously. */
  write(
    mountKey: string,
    path: string,
    bytes: Buffer | Uint8Array | string,
    options?: WriteOptions,
  ): Promise<WriteResult>
  /** Run a shell-capable step and trigger Phase 3 for it, whatever its exit code. */
  exec(cmd: string, options?: ExecOptions): Promise<ExecResult>
  /** Phase 3 trigger for hosts that run their own exec. Fire-and-forget. */
  captureAfterExec(): void
  /** Phase 4. Authoritative; rejects on failure instead of firing `onCaptureFailed`. */
  reconcile(): Promise<void>
  /** Await pending mirror writes and the capture slot. */
  settle(): Promise<void>
}

const DEFAULT_VERIFY_SAMPLE_SIZE = 3

type IndexEntry = {
  /** Sha the engine believes the mirror holds. */
  sha256: string
  /**
   * Sha a scan last CONFIRMED on the mirror, carried only while the straggler
   * window is open. Disk content equal to it means the Phase-2 mirror write
   * never landed — but only while {@link IndexEntry.writeEpoch} still matches
   * the current exec epoch, because after an exec the same bytes are a revert
   * the agent asked for and re-materializing them destroys its work.
   */
  previousSha256?: string
  /** The Phase-2 mirror write failed; re-materialize before the next touch. */
  dirty?: boolean
  /** No scan has yet observed this Phase-2 write on disk; absence means a lost mirror write, not a delete. */
  unconfirmed?: boolean
  /**
   * Exec epoch this Phase-2 write was issued in, carried alongside
   * `unconfirmed`. Once the epoch moves on, an exec has run against the mirror
   * and owns whatever the next scan finds there.
   */
  writeEpoch?: number
}

/** One Phase-2 mirror write still in flight, named so an exec epoch can find its entry. */
type PendingMirrorWrite = {
  readonly mountKey: string
  readonly path: string
  readonly promise: Promise<void>
}

/**
 * Per-cycle memo for the resume guard's durable-history queries: `history` by
 * `<mountKey>\0<path>`, `deltas` by `<parentSha>..<commitSha>`. Both are
 * per-path server round trips, so they are shared across every divergent path
 * in one capture and thrown away with it.
 */
type LineageCache = {
  readonly history: Map<string, readonly HistoryRecord[]>
  readonly deltas: Map<string, Map<string, DiffRecord>>
}

export function createSyncEngine(options: SyncEngineOptions): SyncEngine {
  const { session, target } = options
  const root = posix.resolve(options.root)
  const events = options.events ?? {}
  const now = options.now ?? (() => Date.now())
  const verifySampleSize = options.verifySampleSize ?? DEFAULT_VERIFY_SAMPLE_SIZE

  const index = new Map<string, Map<string, IndexEntry>>()
  const pendingMirrorWrites = new Set<PendingMirrorWrite>()
  const hydrated = new Set<string>()
  /**
   * Mounts seeded from heads by a warm re-acquire, each against the exec epoch
   * it was seeded in. Their straggler guard lives only in the previous
   * process's memory, so divergence is checked against durable history instead
   * — but only until the first authoritative scan retires the guard, or the
   * first exec of the resumed process claims the mirror. Past either bound,
   * lineage content on disk is a revert an exec asked for, not the stale mirror
   * the crash left behind (§7.3 phase 4, §7.5 line 1 across a crash-resume).
   */
  const resumeGuard = new Map<string, number>()
  let table: readonly SessionMount[] = []
  let mirrorDirs = new Map<string, string>()
  // Set while one mount is being captured so a thrown failure can name it in
  // onCaptureFailed. Safe because capture runs single-threaded inside the slot.
  let capturingMount: string | undefined
  /**
   * Number of execs the engine knows have run against the mirror. It is the
   * second bound on the straggler window: an unconfirmed Phase-2 write is
   * protected only while no exec has run since it was issued, because after
   * one, disk content equal to the pre-write bytes is that exec reverting the
   * file (§7.3 phase 4).
   */
  let execEpoch = 0

  /**
   * Deliver one §7.2 event. Host callbacks are outside the engine's trust
   * boundary: a throwing handler must neither abort a capture cycle nor reject
   * the fire-and-forget capture chain, which Node turns into an unhandled
   * rejection and, by default, a dead process.
   */
  const emit = (name: keyof SyncEngineEvents, deliver: () => void): void => {
    try {
      deliver()
    } catch (error: unknown) {
      try {
        if (options.logger) options.logger.error(error, { event: name })
        else console.error(`TuddoFs sync ${name} handler failed`, error)
      } catch (loggerError: unknown) {
        console.error(`TuddoFs sync ${name} logger failed`, loggerError, { error })
      }
    }
  }

  const slot = new CaptureSlot(
    () => capture(false),
    (attempt, error) =>
      emit('onCaptureFailed', () =>
        events.onCaptureFailed?.({ ...(capturingMount ? { mountKey: capturingMount } : {}), attempt, error }),
      ),
  )

  const entriesFor = (mountKey: string): Map<string, IndexEntry> => {
    let entries = index.get(mountKey)
    if (!entries) {
      entries = new Map()
      index.set(mountKey, entries)
    }
    return entries
  }

  const mountFor = (mountKey: string): SessionMount => {
    validateMountKey(mountKey)
    const mount = table.find(candidate => candidate.key === mountKey)
    if (!mount) throw new NotFoundError(`Mount is not materialized: ${mountKey}`, { mount: mountKey })
    return mount
  }

  function mirrorPath(mountKey: string, rawPath: string): string {
    const mount = mountFor(mountKey)
    if (mount.virtual) {
      throw new InvalidPathError(rawPath, 'virtual mounts have no mirror and are never synced', { mount: mountKey })
    }
    const path = validatePath(rawPath, { mount: mountKey })
    return resolveUnderRoot(root, posix.join(mirrorDirName(mountKey), path.slice(1)))
  }

  const runExec = async (cmd: string, what: string): Promise<ExecResult> => {
    const result = await target.exec(cmd)
    if (result.exitCode !== 0) {
      throw new SyncTargetError(`${what} failed`, { exitCode: result.exitCode, output: result.output })
    }
    return result
  }

  const refreshMountTable = async (): Promise<void> => {
    table = await session.mounts()
    mirrorDirs = new Map(
      table.filter(mount => !mount.virtual).map(mount => [mirrorDirName(mount.key), mount.key] as const),
    )
  }

  /** Fetch a governed file and put it on disk, replacing whatever is there. */
  const materializePath = async (mountKey: string, path: string): Promise<void> => {
    const bytes = await session.mount(mountKey).readBytes(path)
    const mirror = mirrorPath(mountKey, path)
    await target.mkdir(posix.dirname(mirror))
    await target.writeFile(mirror, bytes)
    entriesFor(mountKey).set(path, { sha256: sha256(bytes) })
  }

  const hydrate = async (mount: SessionMount): Promise<void> => {
    const handle = session.mount(mount.key)
    const entries = await handle.glob('/**')
    const mountDir = resolveUnderRoot(root, mirrorDirName(mount.key))
    await target.mkdir(mountDir)
    // A previously frozen mount is still `a-w` on disk; unfreeze before rewriting.
    if (mount.write === 'none')
      await runExec(chmodWritableCommand(root, mirrorDirName(mount.key)), 'read-only unfreeze')

    const seeded = new Map<string, IndexEntry>()
    for (const entry of entries) {
      if (entry.sha256 === undefined) {
        throw new InvariantError(`Branch view entry without a sha: ${entry.path}`, { mount: mount.key })
      }
      const mirror = resolveUnderRoot(root, posix.join(mirrorDirName(mount.key), entry.path.slice(1)))
      await target.mkdir(posix.dirname(mirror))
      await target.writeFile(mirror, await handle.readBytes(entry.path))
      seeded.set(entry.path, { sha256: entry.sha256 })
    }

    // Spot-check the transfer rather than trusting the target's write (§7.3).
    const sample = [...seeded.keys()].filter(
      (_path, position, all) =>
        position === 0 || position === all.length - 1 || position === Math.floor(all.length / 2),
    )
    for (const path of sample.slice(0, verifySampleSize)) {
      const observed = sha256(
        await target.readFile(resolveUnderRoot(root, posix.join(mirrorDirName(mount.key), path.slice(1)))),
      )
      if (observed !== seeded.get(path)?.sha256) {
        throw new SyncTargetError(`Materialized ${mount.key}:${path} does not match the branch view`)
      }
    }

    if (mount.write === 'none') await runExec(chmodReadOnlyCommand(root, mirrorDirName(mount.key)), 'read-only freeze')
    index.set(mount.key, seeded)
    hydrated.add(mount.key)
    // The hydration marker is written LAST, per mount, so a crash mid-acquire
    // re-hydrates only the mounts that never finished (§7.3 phase 1 step 2).
    await target.writeFile(
      resolveUnderRoot(root, HYDRATION_MARKER_FILENAME),
      Buffer.from(`${[...hydrated].sort().join('\n')}\n`),
    )
  }

  /**
   * Warm re-acquire: index check only, never a per-file probe (§7.3 phase 1
   * step 3).
   *
   * Heads carry no straggler state. A crash between a Phase-2 commit and its
   * mirror write leaves the branch ahead of the disk, and a naive index seeded
   * from heads would read the stale disk bytes back as a change and commit the
   * durable write away. The mount is therefore marked for the history-backed
   * guard until the first authoritative scan retires it, or the first exec of
   * this process takes ownership of the mirror (§7.5 line 1 across resume).
   */
  const seedIndexFromHeads = async (mount: SessionMount): Promise<void> => {
    const seeded = new Map<string, IndexEntry>()
    for (const entry of await session.mount(mount.key).glob('/**')) {
      if (entry.sha256 === undefined) {
        throw new InvariantError(`Branch view entry without a sha: ${entry.path}`, { mount: mount.key })
      }
      seeded.set(entry.path, { sha256: entry.sha256 })
    }
    index.set(mount.key, seeded)
    hydrated.add(mount.key)
    resumeGuard.set(mount.key, execEpoch)
  }

  async function materialize(): Promise<void> {
    // GNU coreutils are required: busybox lacks `--zero`. Fail at acquire, not
    // silently at capture (§7.3 phase 1 step 1).
    await runExec(probeCommand(), 'GNU coreutils probe')
    const state = await runExec(hydrationManifestCommand(root), 'workspace state probe')
    const lines = state.output.split('\n').filter(Boolean)
    const stampPresent = lines.includes(STAMP_FILENAME)
    const alreadyHydrated = new Set(lines.filter(line => line !== STAMP_FILENAME))

    await refreshMountTable()
    let cold = false
    for (const mount of table) {
      if (mount.virtual) continue
      if (stampPresent && alreadyHydrated.has(mount.key)) {
        hydrated.add(mount.key)
        await seedIndexFromHeads(mount)
        continue
      }
      cold = true
      await hydrate(mount)
    }
    // A missing stamp means the workspace contract is broken, so every mount was
    // re-hydrated above and the watermark restarts from the end of acquire. The
    // watermark keeps its granularity margin here even though it makes the first
    // scan re-hash the hydrated files: see stampCommand for why an
    // acquire-tick watermark loses the writes that follow it.
    if (cold || !stampPresent) await runExec(stampCommand(root, now()), 'stamp initialization')
  }

  const settleMirrorWrites = async (): Promise<void> => {
    while (pendingMirrorWrites.size > 0) await Promise.all([...pendingMirrorWrites].map(pending => pending.promise))
  }

  /**
   * An exec is about to run against the mirror, or the host has just run one.
   * That closes the straggler window on every Phase-2 write already on the
   * wire: from here, disk content equal to a path's pre-write bytes is the
   * exec reverting the file, and re-materializing over it would discard the
   * agent's work, commit nothing and fire no event (§7.3 phase 4).
   *
   * Mirror writes still in flight keep their guard. `exec` settles them first,
   * so this only concerns `captureAfterExec`, where the host ran its own
   * command and nothing orders it against a write the engine has not finished.
   *
   * The residual case, named because it is a deliberate trade and not an
   * oversight: a mirror write that RESOLVED while silently dropping its bytes,
   * followed by an exec, is captured as an exec change and the branch head goes
   * back one version. Ranked against the alternative it is the cheap failure.
   * It needs a target whose `writeFile` lies — a kill rejects the write and
   * marks the path dirty, a crash goes through the resume guard — and its
   * outcome is a `capture` commit with an `onCapture` event, so the superseded
   * bytes stay in history and are recoverable. Guarding instead would delete
   * the exec's output from disk and from the branch, with no commit and no
   * event: silent and permanent.
   */
  const noteExec = (): void => {
    execEpoch += 1
    for (const pending of pendingMirrorWrites) {
      const entry = index.get(pending.mountKey)?.get(pending.path)
      if (entry?.unconfirmed) entry.writeEpoch = execEpoch
    }
  }

  /** True while the in-memory straggler guard still covers this Phase-2 write. */
  const guarded = (entry: IndexEntry): boolean => entry.unconfirmed === true && entry.writeEpoch === execEpoch

  const restageDirty = async (): Promise<void> => {
    for (const [mountKey, entries] of index) {
      for (const [path, entry] of entries) {
        if (entry.dirty) await materializePath(mountKey, path)
      }
    }
  }

  /** `path`'s before/after shas across one parent→commit step, memoized per pair. */
  const pathDelta = async (
    parent: string,
    commitSha: string,
    path: string,
    lineage: LineageCache,
  ): Promise<DiffRecord | undefined> => {
    const pair = `${parent}..${commitSha}`
    let delta = lineage.deltas.get(pair)
    if (!delta) {
      delta = new Map((await session.diff(parent, commitSha)).map(record => [record.path, record]))
      lineage.deltas.set(pair, delta)
    }
    return delta.get(path)
  }

  /** Every commit that changed `path`, newest first, memoized for the cycle. */
  const pathHistory = async (
    mountKey: string,
    path: string,
    lineage: LineageCache,
  ): Promise<readonly HistoryRecord[]> => {
    const key = `${mountKey}\0${path}`
    let records = lineage.history.get(key)
    if (!records) {
      records = await session.mount(mountKey).history(path)
      lineage.history.set(key, records)
    }
    return records
  }

  /**
   * Did `path` ever hold `sha` anywhere in this ref's lineage? Rebuilt from
   * durable history for a warm-acquired mount, whose in-memory guard died with
   * the previous process.
   *
   * Known content on disk means the mirror is stale-but-known — one lost write
   * or ten — and the durable head wins. Unknown content is work an exec did
   * before the crash and reconcile must commit it (§7.5 lines 1 and 2). The
   * newest write's parent alone is not enough: consecutive lost mirror writes
   * leave the disk further back than that, and the branch head is then
   * committed away.
   *
   * A parentless commit is the genesis import, whose tree is empty; the `after`
   * side of any deeper commit reappears as the `before` side of the next one
   * that touched the path, so walking the parented steps covers the whole
   * chain. Cost is one history query plus at most one diff per commit that
   * touched the path, for divergent paths only, once per resume — never per
   * file and never on the write path. The walk short-circuits on the first
   * match, which is the newest commit in the common single-lost-write case.
   */
  const heldInLineage = async (
    mountKey: string,
    path: string,
    sha: string,
    lineage: LineageCache,
  ): Promise<boolean> => {
    for (const record of await pathHistory(mountKey, path, lineage)) {
      const parent = record.parentShas[0]
      if (parent === undefined) continue
      const delta = await pathDelta(parent, record.commitSha, path, lineage)
      if (delta?.beforeSha === sha || delta?.afterSha === sha) return true
    }
    return false
  }

  /**
   * Is the newest durable commit for `path` a Phase-2 write that CREATED it?
   * Then the mirror should hold the file and its absence is a lost write, not a
   * delete. A newest `capture` proves the opposite: those bytes were READ off
   * the mirror, so they were on disk by construction and absence is a removal.
   */
  const createdByNewestWrite = async (mountKey: string, path: string, lineage: LineageCache): Promise<boolean> => {
    const [newest] = await pathHistory(mountKey, path, lineage)
    if (!newest || newest.op !== 'write') return false
    const parent = newest.parentShas[0]
    if (parent === undefined) return true
    return ((await pathDelta(parent, newest.commitSha, path, lineage))?.beforeSha ?? null) === null
  }

  /**
   * Phases 3 and 4 share one scan-and-commit body. `full` drops `-newer` and
   * enables deletes; §7.4 forbids deleting from an incremental scan, where an
   * unmodified file simply does not appear.
   */
  async function capture(full: boolean): Promise<void> {
    capturingMount = undefined
    if (mirrorDirs.size === 0) return
    const scanStart = now()
    const scan = await runExec(
      scanCommand({ root, mirrorDirs: [...mirrorDirs.keys()].sort(), newerThanStamp: !full }),
      'capture scan',
    )
    const observed = new Map<string, Map<string, string>>()
    for (const record of parseScanRecords(scan.output, mirrorDirs)) {
      let paths = observed.get(record.mountKey)
      if (!paths) {
        paths = new Map()
        observed.set(record.mountKey, paths)
      }
      paths.set(record.path, record.sha256)
    }
    const lineage: LineageCache = { history: new Map(), deltas: new Map() }

    // A failure below aborts the whole cycle without advancing the stamp, so the
    // untouched mounts are re-scanned next cycle rather than silently dropped.
    for (const mount of table) {
      if (mount.virtual) continue
      capturingMount = mount.key
      const entries = entriesFor(mount.key)
      const seen = observed.get(mount.key) ?? new Map<string, string>()
      const resuming = resumeGuard.get(mount.key) === execEpoch
      const changed: string[] = []
      const restage: string[] = []
      for (const [path, observedSha] of seen) {
        const entry = entries.get(path)
        if (entry?.sha256 === observedSha) {
          // The scan proves the Phase-2 write reached disk. That RETIRES the
          // straggler window: from here, disk content equal to the pre-write
          // bytes is the agent reverting the file, not a lost mirror write.
          delete entry.unconfirmed
          delete entry.previousSha256
          delete entry.writeEpoch
          continue
        }
        if (entry === undefined) {
          changed.push(path)
          continue
        }
        // Straggler guard: disk still holds the sha this path had BEFORE the
        // last Phase-2 write, and no exec has run since that write, so nothing
        // on the target could have put those bytes back — the mirror write
        // never landed. Committing it would revert the agent's own tool write.
        // Once an exec HAS run, the same bytes are that exec's revert and the
        // capture below is what preserves them (§7.3 phase 4).
        if (guarded(entry) && entry.previousSha256 === observedSha) restage.push(path)
        else if (resuming && !entry.unconfirmed && (await heldInLineage(mount.key, path, observedSha, lineage))) {
          // Warm re-acquire: content the path held anywhere in its durable
          // lineage is a stale mirror, however many writes were lost, and the
          // head wins. Content from nowhere in the lineage is uncaptured exec
          // work from before the crash and is committed.
          restage.push(path)
        } else changed.push(path)
      }
      const deletes: string[] = []
      if (full) {
        for (const [path, entry] of entries) {
          if (seen.has(path)) continue
          // Same guard, for a path the branch view never had: no scan has seen
          // the mirror write and no exec has run since it, so the file is
          // absent because the write was lost, not because anything deleted it.
          if (guarded(entry)) restage.push(path)
          else if (resuming && !entry.unconfirmed && (await createdByNewestWrite(mount.key, path, lineage))) {
            restage.push(path)
          } else deletes.push(path)
        }
      }
      // The read-only verdict comes first: a frozen mirror rejects the restage
      // write, and nothing on it can be a straggler anyway — Phase 2 refuses a
      // read-only mount before it commits (§5, §7.3 phase 3 step 5).
      if (mount.write === 'none') {
        if (changed.length > 0 || deletes.length > 0) {
          emit('onReadOnlySkipped', () =>
            events.onReadOnlySkipped?.({ mountKey: mount.key, paths: [...changed, ...deletes].sort() }),
          )
        }
        continue
      }
      for (const path of restage) await materializePath(mount.key, path)
      if (changed.length === 0 && deletes.length === 0) continue

      // Bytes are fetched and re-hashed by the kernel; the target-reported sha
      // is a diff prefilter only (§7.3 step 4, §7.4).
      const writes: CaptureWrite[] = []
      const capturedShas = new Map<string, string>()
      for (const path of changed) {
        const bytes = await target.readFile(mirrorPath(mount.key, path))
        writes.push({ path, bytes })
        capturedShas.set(path, sha256(bytes))
      }
      const result = await session.mount(mount.key).capture({ writes, deletes })
      for (const path of result.changedPaths) {
        const capturedSha = capturedShas.get(path)
        if (capturedSha === undefined) entries.delete(path)
        else entries.set(path, { sha256: capturedSha })
      }
      for (const path of deletes) entries.delete(path)
      if (result.created) {
        emit('onCapture', () =>
          events.onCapture?.({ mountKey: mount.key, commitSha: result.commitSha, paths: result.changedPaths }),
        )
      }
    }
    capturingMount = undefined
    // The first authoritative scan has now classified every divergence with the
    // durable history behind it; from here the in-memory guard is complete.
    if (full) resumeGuard.clear()

    // Files written during the scan re-appear next cycle; sha-diffing makes the
    // re-capture a no-op (§7.3 phase 3 step 6).
    await runExec(stampCommand(root, scanStart), 'stamp update')
  }

  return {
    root,
    materialize,
    mirrorPath,

    async write(mountKey, rawPath, bytes, writeOptions) {
      const path = validatePath(rawPath, { mount: mountKey })
      // Rejects virtual mounts before anything is committed (§6.1).
      const mirror = mirrorPath(mountKey, path)
      const result = await session.mount(mountKey).write(path, bytes, writeOptions)
      const entries = entriesFor(mountKey)
      const previous = entries.get(path)
      // The guard compares disk against the last sha a scan CONFIRMED, not
      // against the sha of the previous write. Two writes before the first
      // confirming scan leave the mirror on the older bytes, and forgetting
      // them here would read those bytes back as an agent change. The epoch
      // stamped alongside it is the guard's other bound: it expires the moment
      // an exec runs, because from then on those bytes could be the exec's.
      const confirmed = previous?.unconfirmed === true ? previous.previousSha256 : previous?.sha256
      entries.set(path, {
        sha256: result.sha256,
        unconfirmed: true,
        writeEpoch: execEpoch,
        ...(confirmed === undefined ? {} : { previousSha256: confirmed }),
      })
      const payload = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)
      const mirrored = (async () => {
        try {
          await target.mkdir(posix.dirname(mirror))
          await target.writeFile(mirror, payload)
        } catch {
          // Not catch-and-continue: §7.3 phase 2 prescribes marking the path
          // dirty so the next touch re-materializes it. The commit is durable
          // either way, which is the whole point of committing first.
          const entry = entriesFor(mountKey).get(path)
          if (entry) entry.dirty = true
        }
      })()
      const pending: PendingMirrorWrite = { mountKey, path, promise: mirrored }
      pendingMirrorWrites.add(pending)
      void mirrored.finally(() => pendingMirrorWrites.delete(pending))
      return result
    },

    async exec(cmd, execOptions) {
      await settleMirrorWrites()
      await restageDirty()
      noteExec()
      const result = await target.exec(cmd, execOptions)
      slot.trigger()
      return result
    },

    captureAfterExec() {
      noteExec()
      slot.trigger()
    },

    async reconcile() {
      await slot.exclusive(async () => {
        await settleMirrorWrites()
        await restageDirty()
        await refreshMountTable()
        await capture(true)
      })
    },

    async settle() {
      for (;;) {
        await settleMirrorWrites()
        await slot.settle()
        if (pendingMirrorWrites.size === 0) return
      }
    },
  }
}
