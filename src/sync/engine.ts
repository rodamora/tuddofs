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
 */
import posix from 'node:path/posix'

import { sha256 } from '../hashing.js'
import { InvariantError, NotFoundError } from '../errors.js'
import { InvalidPathError, validateMountKey, validatePath } from '../validation.js'
import type { SessionFileSystem, SessionMount, WriteOptions } from '../session.js'
import type { CaptureWrite, WriteResult } from '../kernel.js'
import { SyncTargetError } from './errors.js'
import {
  STAMP_FILENAME,
  STATE_DIRNAME,
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
  /** Sha the mirror held before the last Phase-2 write; drives the straggler guard. */
  previousSha256?: string
  /** The Phase-2 mirror write failed; re-materialize before the next touch. */
  dirty?: boolean
}

export function createSyncEngine(options: SyncEngineOptions): SyncEngine {
  const { session, target } = options
  const root = posix.resolve(options.root)
  const events = options.events ?? {}
  const now = options.now ?? (() => Date.now())
  const verifySampleSize = options.verifySampleSize ?? DEFAULT_VERIFY_SAMPLE_SIZE

  const index = new Map<string, Map<string, IndexEntry>>()
  const pendingMirrorWrites = new Set<Promise<void>>()
  const hydrated = new Set<string>()
  let table: readonly SessionMount[] = []
  let mirrorDirs = new Map<string, string>()
  // Set while one mount is being captured so a thrown failure can name it in
  // onCaptureFailed. Safe because capture runs single-threaded inside the slot.
  let capturingMount: string | undefined

  const slot = new CaptureSlot(
    () => capture(false),
    (attempt, error) =>
      events.onCaptureFailed?.({ ...(capturingMount ? { mountKey: capturingMount } : {}), attempt, error }),
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
      resolveUnderRoot(root, `${STATE_DIRNAME}/hydrated`),
      Buffer.from(`${[...hydrated].sort().join('\n')}\n`),
    )
  }

  /** Warm re-acquire: index check only, never a per-file probe (§7.3 phase 1 step 3). */
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
    // re-hydrated above and the watermark restarts from the end of acquire.
    if (cold || !stampPresent) await runExec(stampCommand(root, now()), 'stamp initialization')
  }

  const settleMirrorWrites = async (): Promise<void> => {
    while (pendingMirrorWrites.size > 0) await Promise.all([...pendingMirrorWrites])
  }

  const restageDirty = async (): Promise<void> => {
    for (const [mountKey, entries] of index) {
      for (const [path, entry] of entries) {
        if (entry.dirty) await materializePath(mountKey, path)
      }
    }
  }

  /**
   * Phases 3 and 4 share one scan-and-commit body. `full` drops `-newer` and
   * enables deletes; §7.4 forbids deleting from an incremental scan, where an
   * unmodified file simply does not appear.
   */
  async function capture(full: boolean): Promise<void> {
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

    for (const mount of table) {
      if (mount.virtual) continue
      capturingMount = mount.key
      try {
        const entries = entriesFor(mount.key)
        const seen = observed.get(mount.key) ?? new Map<string, string>()
        const changed: string[] = []
        const stragglers: string[] = []
        for (const [path, observedSha] of seen) {
          const entry = entries.get(path)
          if (entry?.sha256 === observedSha) continue
          // Straggler guard: disk still holds the sha this path had BEFORE the
          // last Phase-2 write, so the mirror write never landed. Committing it
          // would revert the agent's own tool write (§7.3 phase 4).
          if (entry?.previousSha256 === observedSha) stragglers.push(path)
          else changed.push(path)
        }
        const deletes = full ? [...entries.keys()].filter(path => !seen.has(path)) : []
        for (const path of stragglers) await materializePath(mount.key, path)
        if (changed.length === 0 && deletes.length === 0) continue
        if (mount.write === 'none') {
          events.onReadOnlySkipped?.({ mountKey: mount.key, paths: [...changed, ...deletes].sort() })
          continue
        }

        // Bytes are fetched and re-hashed by the kernel; the target-reported sha
        // is a diff prefilter only (§7.3 step 4, §7.4).
        const writes: CaptureWrite[] = []
        for (const path of changed) writes.push({ path, bytes: await target.readFile(mirrorPath(mount.key, path)) })
        const result = await session.mount(mount.key).capture({ writes, deletes })
        const written = new Map(writes.map(entry => [entry.path, sha256(entry.bytes as Buffer)] as const))
        for (const path of result.changedPaths) {
          const observedSha = written.get(path)
          if (observedSha === undefined) entries.delete(path)
          else entries.set(path, { sha256: observedSha })
        }
        for (const path of deletes) entries.delete(path)
        if (result.created) {
          events.onCapture?.({ mountKey: mount.key, commitSha: result.commitSha, paths: result.changedPaths })
        }
      } finally {
        capturingMount = undefined
      }
    }

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
      entries.set(path, {
        sha256: result.sha256,
        ...(previous?.sha256 === undefined ? {} : { previousSha256: previous.sha256 }),
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
      pendingMirrorWrites.add(mirrored)
      void mirrored.finally(() => pendingMirrorWrites.delete(mirrored))
      return result
    },

    async exec(cmd, execOptions) {
      await settleMirrorWrites()
      await restageDirty()
      const result = await target.exec(cmd, execOptions)
      slot.trigger()
      return result
    },

    captureAfterExec() {
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
