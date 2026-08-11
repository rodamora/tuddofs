/**
 * The §7.5 kill matrix, written once and run against every {@link SyncTarget}.
 *
 * Spec: §7.5 (acceptance), §7.3 (four phases), §7.4 (gotchas), §6.1 (virtual
 * mounts), §13.4 (local target in CI, SSH target behind an opt-in flag).
 *
 * The engine's contract is the four-verb seam and nothing else, so its
 * acceptance suite must not know which target it is driving either. Everything
 * target-specific lives behind {@link KillMatrixHarness}:
 *
 * - `create` supplies a fresh workspace root and a target for it.
 * - `disk` is how the TEST inspects and tampers with the workspace, out of band
 *   from the engine — `node:fs` for a local root, a remote shell for an SSH
 *   host. Never the engine's own path.
 * - `kill`/`revive` take the target away and bring it back. A local target
 *   simulates it; a real remote kills the real daemon.
 * - `createProbeFailureTarget` is a host without GNU coreutils (§7.3 phase 1
 *   step 1).
 *
 * A test that needed a fourth verb, or an engine change, would be a seam bug.
 */
import assert from 'node:assert/strict'
import posix from 'node:path/posix'
import test, { after, before, beforeEach } from 'node:test'

import { Pool } from 'pg'

import { PermissionDeniedError, createTuddoFs, type SessionFileSystem, type WriteMode } from '../index.js'
import { SyncTargetError, createSyncEngine, migrate, type SyncEngine, type SyncTarget } from '../internal.js'

/** What `stat` has to answer for the matrix, on any target. */
export interface WorkspaceStat {
  readonly mtimeMs: number
  /** POSIX mode bits, as `fs.Stats.mode` reports them. */
  readonly mode: number
}

/**
 * Out-of-band access to the workspace, standing in for the shell tools and host
 * processes the engine does not control. Paths are absolute on the target, and
 * deliberately unconfined: two of the matrix cases plant files outside the root.
 */
export interface WorkspaceDisk {
  readText(path: string): Promise<string>
  writeText(path: string, content: string): Promise<void>
  /** `undefined` for an absent path, so absence is an assertion, not a rejection. */
  stat(path: string): Promise<WorkspaceStat | undefined>
  symlink(existingPath: string, linkPath: string): Promise<void>
  chmod(path: string, mode: number): Promise<void>
}

/** Failure modes the matrix injects between the engine and its target (§7.5). */
export interface TargetControls {
  /** Mirror paths whose `writeFile` reports success and silently drops the bytes. */
  readonly swallowWrites: Set<string>
  /** Scan output substituted for the target's, to inject hostile records. */
  scanOutput: string | null
  /** Number of upcoming capture scans to fail. */
  failScans: number
}

/** One disposable workspace: a root, a target for it, and a way to break both. */
export interface KillMatrixWorkspace {
  readonly root: string
  /** The target the engine drives, with the matrix's failure injection wrapped around it. */
  readonly target: SyncTarget
  readonly controls: TargetControls
  readonly disk: WorkspaceDisk
  /** Take the target away: every verb must fail until `revive`. */
  kill(): Promise<void>
  revive(): Promise<void>
  dispose(): Promise<void>
}

/** Everything the matrix needs to know about a target implementation. */
export interface KillMatrixHarness {
  /** Short label; appears in every test name. */
  readonly name: string
  /** Tenant for this harness's data, so two harnesses never share rows. */
  readonly tenant: string
  create(): Promise<KillMatrixWorkspace>
  /** A target whose GNU coreutils probe fails, e.g. a busybox host (§7.3 phase 1 step 1). */
  createProbeFailureTarget(): Promise<{ root: string; target: SyncTarget }>
  /** Torn down after the whole matrix. */
  dispose?(): Promise<void>
}

type CaptureEvent = { mountKey: string; commitSha: string; paths: readonly string[] }
type FailureEvent = { mountKey?: string; attempt: number; error: Error }
type SkippedEvent = { mountKey: string; paths: readonly string[] }

/**
 * Wrap a target with the matrix's failure injection. It is target-agnostic on
 * purpose: `kill` belongs to the harness, because a real remote can lose its
 * daemon for real, and a simulated kill would prove less.
 */
export function controlledTarget(target: SyncTarget): { target: SyncTarget; controls: TargetControls } {
  const controls: TargetControls = { swallowWrites: new Set(), scanOutput: null, failScans: 0 }
  return {
    controls,
    target: {
      async exec(cmd, opts) {
        const isScan = cmd.includes('sha256sum --zero')
        if (isScan && controls.failScans > 0) {
          controls.failScans -= 1
          return { exitCode: 1, output: 'simulated scan failure' }
        }
        const result = await target.exec(cmd, opts)
        if (controls.scanOutput !== null && isScan) {
          const output = controls.scanOutput
          controls.scanOutput = null
          return { exitCode: result.exitCode, output }
        }
        return result
      },
      async readFile(path) {
        return target.readFile(path)
      },
      async writeFile(path, bytes) {
        if (controls.swallowWrites.has(path)) return
        return target.writeFile(path, bytes)
      },
      async mkdir(path) {
        return target.mkdir(path)
      },
    },
  }
}

/**
 * Register the whole §7.5 acceptance suite against one target implementation.
 * Call it at the top level of a test file; every case owns its workspace.
 */
export function runKillMatrix(harness: KillMatrixHarness): void {
  const pool = new Pool({ connectionString: process.env.TUDDOFS_DATABASE_URL })
  const tenant = harness.tenant
  const actor = { id: 'user-engine', tenant }
  const grants: Record<string, WriteMode> = { 'project:docs': 'direct', 'refs:public': 'none' }
  const workspaces: KillMatrixWorkspace[] = []

  let captures: CaptureEvent[] = []
  let failures: FailureEvent[] = []
  let skipped: SkippedEvent[] = []

  before(async () => migrate(pool))
  beforeEach(async () => {
    grants['project:docs'] = 'direct'
    grants['refs:public'] = 'none'
    captures = []
    failures = []
    skipped = []
    await pool.query(
      'TRUNCATE tuddo_heads, tuddo_refs, tuddo_commits, tuddo_tree_entries, tuddo_trees, tuddo_blobs RESTART IDENTITY CASCADE',
    )
  })
  after(async () => {
    await pool.end()
    for (const workspace of workspaces) await workspace.dispose().catch(() => undefined)
    await harness.dispose?.()
  })

  async function openSession(sessionId: string, withVirtual = true): Promise<SessionFileSystem> {
    return createTuddoFs({
      pool,
      grants: {
        resolve: async (_actorInput, mount) => ({ read: mount.key in grants, write: grants[mount.key] ?? 'none' }),
      },
    }).open({
      actor,
      sessionId,
      attribution: { runId: 'run-engine' },
      mounts: withVirtual
        ? [
            { key: 'project:docs' },
            { key: 'refs:public' },
            {
              key: 'live:data',
              virtual: {
                async list() {
                  return [{ path: '/now.txt', type: 'file' as const }]
                },
                async read() {
                  return Buffer.from('live')
                },
              },
            },
          ]
        : [{ key: 'project:docs' }, { key: 'refs:public' }],
    })
  }

  type Fixture = {
    session: SessionFileSystem
    engine: SyncEngine
    workspace: KillMatrixWorkspace
    root: string
    disk: WorkspaceDisk
    controls: TargetControls
    target: SyncTarget
  }

  async function setup(sessionId: string, options: { withVirtual?: boolean } = {}): Promise<Fixture> {
    const workspace = await harness.create()
    workspaces.push(workspace)
    const session = await openSession(sessionId, options.withVirtual ?? true)
    const engine = createSyncEngine({
      session,
      target: workspace.target,
      root: workspace.root,
      events: {
        onCapture: event => captures.push(event),
        onCaptureFailed: event => failures.push(event),
        onReadOnlySkipped: event => skipped.push(event),
      },
    })
    return {
      session,
      engine,
      workspace,
      root: workspace.root,
      disk: workspace.disk,
      controls: workspace.controls,
      target: workspace.target,
    }
  }

  const named = (title: string): string => `[${harness.name}] ${title}`
  const docsDir = (root: string): string => posix.join(root, 'project%3Adocs')
  const docsFile = (root: string, name: string): string => posix.join(docsDir(root), name)

  test(named('materialize writes the branch view, skips virtual mounts, and freezes read-only mounts'), async () => {
    const { session, engine, root, disk } = await setup('engine-materialize')
    await session.mount('project:docs').write('/notes/today.md', 'ship safely')
    await session.mount('project:docs').write('/a.md', 'alpha')
    grants['refs:public'] = 'direct'
    await session.mount('refs:public').write('/policy.md', 'frozen')
    grants['refs:public'] = 'none'

    await engine.materialize()

    assert.equal(await disk.readText(docsFile(root, 'notes/today.md')), 'ship safely')
    assert.equal(await disk.readText(posix.join(root, 'refs%3Apublic', 'policy.md')), 'frozen')
    assert.ok(await disk.stat(posix.join(root, '.tuddofs-stamp')))
    // A copy of live host data is stale by definition (§6.1).
    assert.equal(await disk.stat(posix.join(root, 'live%3Adata')), undefined)
    assert.equal(((await disk.stat(posix.join(root, 'refs%3Apublic', 'policy.md')))!.mode & 0o222) === 0, true)
    assert.equal(((await disk.stat(docsFile(root, 'a.md')))!.mode & 0o200) !== 0, true)

    assert.throws(() => engine.mirrorPath('live:data', '/now.txt'), /virtual/iu)
    assert.throws(() => engine.mirrorPath('nope:missing', '/x'))
    assert.equal(engine.mirrorPath('project:docs', '/a.md'), docsFile(root, 'a.md'))
  })

  test(named('materialize fails loudly when the target lacks GNU coreutils'), async () => {
    const probe = await harness.createProbeFailureTarget()
    const engine = createSyncEngine({
      session: await openSession('engine-probe', false),
      root: probe.root,
      target: probe.target,
    })

    await assert.rejects(engine.materialize(), SyncTargetError)
  })

  test(named('a warm re-acquire seeds the index from heads without rewriting a single file'), async () => {
    const { session, engine, root, disk, target } = await setup('engine-warm')
    await session.mount('project:docs').write('/a.md', 'alpha')
    await engine.materialize()
    const before = await disk.stat(docsFile(root, 'a.md'))

    const warm = createSyncEngine({ session, target, root })
    await warm.materialize()

    assert.equal((await disk.stat(docsFile(root, 'a.md')))!.mtimeMs, before!.mtimeMs)
    // The seeded index makes an unchanged workspace a no-op reconcile.
    await warm.reconcile()
    assert.deepEqual(captures, [])
  })

  test(named('a tool write commits before it mirrors and survives an instant target kill'), async () => {
    const { session, engine, root, disk, workspace } = await setup('engine-kill-write')
    await session.mount('project:docs').write('/a.md', 'v1')
    await engine.materialize()

    await workspace.kill()
    const result = await engine.write('project:docs', '/a.md', 'v2')
    await engine.settle()

    // Commit landed even though the workspace is gone.
    assert.equal(await session.mount('project:docs').read('/a.md'), 'v2')
    assert.equal(result.sha256.length, 64)

    await workspace.revive()
    assert.equal(await disk.readText(docsFile(root, 'a.md')), 'v1')
    await engine.exec('true')
    await engine.settle()
    assert.equal(await disk.readText(docsFile(root, 'a.md')), 'v2')
  })

  test(named('a write refused by the grant never reaches the workspace'), async () => {
    const { engine, root, disk } = await setup('engine-write-denied')
    await engine.materialize()

    await assert.rejects(engine.write('refs:public', '/blocked.md', 'nope'), PermissionDeniedError)
    await engine.settle()
    assert.equal(await disk.stat(posix.join(root, 'refs%3Apublic', 'blocked.md')), undefined)
  })

  test(named('exec capture commits shell-written files and coalesces repeated triggers'), async () => {
    const { session, engine, root, disk } = await setup('engine-capture')
    await session.mount('project:docs').write('/a.md', 'v1')
    await engine.materialize()

    await engine.exec("printf 'from shell' > 'project%3Adocs/from-shell.md'; printf v2 > 'project%3Adocs/a.md'")
    engine.captureAfterExec()
    engine.captureAfterExec()
    await engine.settle()

    assert.equal(await session.mount('project:docs').read('/from-shell.md'), 'from shell')
    assert.equal(await session.mount('project:docs').read('/a.md'), 'v2')
    assert.deepEqual(failures, [])
    assert.equal(captures.length >= 1, true)
    assert.deepEqual([...new Set(captures.flatMap(event => event.paths))].sort(), ['/a.md', '/from-shell.md'])
    assert.equal(captures[0]?.mountKey, 'project:docs')

    // Deletes land only at reconcile (§7.4).
    await engine.exec("rm 'project%3Adocs/from-shell.md'")
    await engine.settle()
    assert.equal(await session.mount('project:docs').read('/from-shell.md'), 'from shell')
    await engine.reconcile()
    await assert.rejects(session.mount('project:docs').read('/from-shell.md'))
    assert.equal(await disk.readText(docsFile(root, 'a.md')), 'v2')
  })

  test(named('repeated scan failures surface as error events and never wedge the capture slot'), async () => {
    const { session, engine, controls } = await setup('engine-scan-failure')
    await session.mount('project:docs').write('/a.md', 'v1')
    await engine.materialize()

    controls.failScans = 3
    await engine.exec("printf v2 > 'project%3Adocs/a.md'")
    await engine.settle()
    for (let attempt = 2; attempt <= 3; attempt += 1) {
      engine.captureAfterExec()
      await engine.settle()
    }

    assert.deepEqual(
      failures.map(event => event.attempt),
      [1, 2, 3],
    )
    for (const failure of failures) assert.ok(failure.error instanceof SyncTargetError)
    assert.equal(failures[0]?.mountKey, undefined)
    // The stamp was never advanced, so three failures lost nothing.
    assert.equal(await session.mount('project:docs').read('/a.md'), 'v1')

    engine.captureAfterExec()
    await engine.settle()
    assert.equal(await session.mount('project:docs').read('/a.md'), 'v2')
    assert.equal(failures.length, 3)
  })

  test(named('an mtime-only change is a prefilter hit, never a commit'), async () => {
    const { session, engine } = await setup('engine-mtime-prefilter')
    await session.mount('project:docs').write('/a.md', 'v1')
    await engine.materialize()
    const before = await session.mount('project:docs').stat('/a.md')

    await engine.exec("touch 'project%3Adocs/a.md'")
    await engine.settle()
    await engine.reconcile()

    // Transfer decisions are ALWAYS sha-vs-index; mtime only narrows the scan (§7.4).
    assert.deepEqual(captures, [])
    assert.deepEqual(failures, [])
    assert.equal((await session.mount('project:docs').stat('/a.md')).sha256, before.sha256)
  })

  test(named('capture refuses hostile scan output instead of committing outside the mount'), async () => {
    const { session, engine, controls } = await setup('engine-hostile-scan')
    await session.mount('project:docs').write('/a.md', 'v1')
    await engine.materialize()

    const digest = 'a'.repeat(64)
    controls.scanOutput = `${digest}  project%3Adocs/../../etc/passwd\0`
    await engine.exec("printf v2 > 'project%3Adocs/a.md'")
    await engine.settle()

    assert.equal(failures.length, 1)
    assert.match(String(failures[0]?.error.message), /escape|strictly under|mirror directory/iu)
    assert.equal(await session.mount('project:docs').read('/a.md'), 'v1')
  })

  test(named('a symlink planted in the workspace never becomes a commit'), async () => {
    const { session, engine, root, disk } = await setup('engine-symlink')
    await session.mount('project:docs').write('/a.md', 'v1')
    await engine.materialize()
    const secret = posix.join(root, '..', `engine-secret-${process.pid}.txt`)
    await disk.writeText(secret, 'host secret')

    await disk.symlink(secret, docsFile(root, 'leak.md'))
    engine.captureAfterExec()
    await engine.settle()
    await engine.reconcile()

    await assert.rejects(session.mount('project:docs').read('/leak.md'))
    assert.deepEqual(
      (await session.mount('project:docs').list('/')).map(entry => entry.path),
      ['/a.md'],
    )
    assert.equal(await disk.readText(secret), 'host secret')
  })

  test(named('read-only mounts are reported as skipped, never captured'), async () => {
    const { session, engine, root, disk } = await setup('engine-readonly')
    grants['refs:public'] = 'direct'
    await session.mount('refs:public').write('/policy.md', 'v1')
    grants['refs:public'] = 'none'
    await engine.materialize()

    await engine.exec("chmod -R u+w 'refs%3Apublic' && printf tampered > 'refs%3Apublic/policy.md'")
    await engine.settle()

    assert.deepEqual(skipped, [{ mountKey: 'refs:public', paths: ['/policy.md'] }])
    assert.deepEqual(captures, [])
    assert.equal(await session.mount('refs:public').read('/policy.md'), 'v1')
    await disk.chmod(posix.join(root, 'refs%3Apublic'), 0o755)
  })

  test(named('filenames with spaces, newlines, and astral-plane characters round-trip through capture'), async () => {
    const { session, engine, root, disk } = await setup('engine-hostile-names')
    await engine.materialize()
    const names = [
      'two  spaces.md',
      'line\nbreak.md',
      'astral \u{1F600}.md',
      'quote\'and"quote.md',
      '$(touch pwned).md',
      'amp&semi;.md',
      '`backtick`.md',
    ]
    for (const [index, name] of names.entries()) await disk.writeText(docsFile(root, name), `content ${index}`)

    engine.captureAfterExec()
    await engine.settle()

    assert.deepEqual(failures, [])
    for (const [index, name] of names.entries()) {
      assert.equal(await session.mount('project:docs').read(`/${name}`), `content ${index}`)
    }
    // Not one interpolated value was ever evaluated by a shell (§7.4).
    assert.equal(await disk.stat(docsFile(root, 'pwned')), undefined)
    assert.equal(await disk.stat(posix.join(root, 'pwned')), undefined)
  })

  test(named('captured content survives shell metacharacters and NUL-adjacent bytes'), async () => {
    const { session, engine, root, disk } = await setup('engine-hostile-content')
    await engine.materialize()
    const content = 'line one\n$(touch pwned-content) `id` & \'quoted\' "double" \\backslash\nlast'
    await disk.writeText(docsFile(root, 'hostile.md'), content)

    engine.captureAfterExec()
    await engine.settle()

    assert.deepEqual(failures, [])
    assert.equal(await session.mount('project:docs').read('/hostile.md'), content)
    assert.equal(await disk.stat(docsFile(root, 'pwned-content')), undefined)

    // The same content survives the other direction: commit, mirror, re-read.
    await engine.write('project:docs', '/hostile-out.md', content)
    await engine.settle()
    assert.equal(await disk.readText(docsFile(root, 'hostile-out.md')), content)
  })

  test(named('capturing a path that implies a directory deletes the masked head file'), async () => {
    const { session, engine, root, disk } = await setup('engine-coherence')
    await session.mount('project:docs').write('/a', 'file first')
    await engine.materialize()
    assert.equal(await disk.readText(docsFile(root, 'a')), 'file first')

    await engine.exec("rm 'project%3Adocs/a' && mkdir 'project%3Adocs/a' && printf nested > 'project%3Adocs/a/x.md'")
    await engine.settle()

    assert.equal(await session.mount('project:docs').read('/a/x.md'), 'nested')
    await assert.rejects(session.mount('project:docs').read('/a'))
    assert.equal(captures.length, 1)
    assert.deepEqual(captures[0]?.paths, ['/a', '/a/x.md'])
    assert.deepEqual(failures, [])
  })

  test(named('a killed exec loses at most itself and reconcile recovers everything on disk'), async () => {
    const { session, engine } = await setup('engine-kill-exec')
    await engine.materialize()

    const killed = await engine.exec(
      "printf one > 'project%3Adocs/one.md'; printf two > 'project%3Adocs/two.md'; kill -9 $$; printf three > 'project%3Adocs/three.md'",
    )
    assert.equal(killed.exitCode, 137)
    await engine.settle()
    await engine.reconcile()

    assert.equal(await session.mount('project:docs').read('/one.md'), 'one')
    assert.equal(await session.mount('project:docs').read('/two.md'), 'two')
    await assert.rejects(session.mount('project:docs').read('/three.md'))
    assert.deepEqual(failures, [])
  })

  test(named('an exec that exceeds its timeout is killed and reported, not left running'), async () => {
    const { engine } = await setup('engine-exec-timeout')
    await engine.materialize()

    const startedAt = Date.now()
    const timedOut = await engine.exec("printf start > 'project%3Adocs/started.md'; sleep 30", { timeoutMs: 250 })
    assert.equal(timedOut.exitCode, 137)
    assert.ok(Date.now() - startedAt < 15_000, `exec settled after ${Date.now() - startedAt}ms`)
    await engine.settle()
  })

  test(named('the straggler guard re-materializes a lost mirror write instead of reverting'), async () => {
    const { session, engine, root, disk, controls } = await setup('engine-straggler')
    await session.mount('project:docs').write('/a.md', 'v1')
    await engine.materialize()

    // The mirror write reports success and silently loses the bytes: disk still
    // holds the previous head, which reconcile must not commit back (§7.3 phase
    // 4). No exec has run since the commit, so nothing on the target could have
    // produced those bytes — the divergence can only be the lost mirror write.
    controls.swallowWrites.add(docsFile(root, 'a.md'))
    await engine.write('project:docs', '/a.md', 'v2')
    await engine.settle()
    assert.equal(await disk.readText(docsFile(root, 'a.md')), 'v1')

    controls.swallowWrites.clear()
    await engine.reconcile()

    assert.equal(await session.mount('project:docs').read('/a.md'), 'v2')
    assert.equal(await disk.readText(docsFile(root, 'a.md')), 'v2')
    assert.deepEqual(captures, [])
  })

  test(named('reconcile never deletes a committed file whose mirror write was silently lost'), async () => {
    const { session, engine, root, disk, controls } = await setup('engine-lost-new-file')
    await engine.materialize()

    controls.swallowWrites.add(docsFile(root, 'fresh.md'))
    await engine.write('project:docs', '/fresh.md', 'durable')
    await engine.settle()
    assert.equal(await disk.stat(docsFile(root, 'fresh.md')), undefined)

    controls.swallowWrites.clear()
    await engine.reconcile()

    // Absent-on-disk means "delete" only for paths a scan has actually seen.
    assert.equal(await session.mount('project:docs').read('/fresh.md'), 'durable')
    assert.equal(await disk.readText(docsFile(root, 'fresh.md')), 'durable')

    // Once the mirror is confirmed, a real removal does delete at reconcile.
    await engine.exec("rm 'project%3Adocs/fresh.md'")
    await engine.settle()
    await engine.reconcile()
    await assert.rejects(session.mount('project:docs').read('/fresh.md'))
  })

  test(named('an exec that reverts a tool write in the same turn is captured, never re-materialized'), async () => {
    const { session, engine, root, disk } = await setup('engine-exec-revert')
    await session.mount('project:docs').write('/a.md', 'v1')
    await engine.materialize()

    // Phase 2 puts v2 on the mirror. No scan has confirmed it yet, so the
    // straggler window is open on the pre-write sha.
    await engine.write('project:docs', '/a.md', 'v2')
    await engine.settle()
    assert.equal(await disk.readText(docsFile(root, 'a.md')), 'v2')

    // Same turn, before any confirming scan: an exec puts v1 back. Disk now
    // holds exactly the sha a lost mirror write would have left, and only the
    // exec tells the two apart. Re-materializing here would discard the agent's
    // revert, commit nothing and fire no event (§7.3 phase 4).
    await engine.exec("printf v1 > 'project%3Adocs/a.md'")
    await engine.settle()

    assert.equal(await session.mount('project:docs').read('/a.md'), 'v1')
    assert.equal(await disk.readText(docsFile(root, 'a.md')), 'v1')
    assert.deepEqual(
      captures.flatMap(event => event.paths),
      ['/a.md'],
    )
    assert.deepEqual(failures, [])

    // Reconcile agrees: the revert is the durable head, on disk and on the branch.
    await engine.reconcile()
    assert.equal(await session.mount('project:docs').read('/a.md'), 'v1')
    assert.equal(await disk.readText(docsFile(root, 'a.md')), 'v1')
  })

  test(named('an exec that overwrites an unconfirmed tool write with new bytes is captured'), async () => {
    const { session, engine, root, disk } = await setup('engine-exec-overwrite')
    await session.mount('project:docs').write('/a.md', 'v1')
    await engine.materialize()

    await engine.write('project:docs', '/a.md', 'v2')
    await engine.settle()
    await engine.exec("printf v3 > 'project%3Adocs/a.md'")
    await engine.settle()

    assert.equal(await session.mount('project:docs').read('/a.md'), 'v3')
    assert.equal(await disk.readText(docsFile(root, 'a.md')), 'v3')
    assert.deepEqual(failures, [])
  })

  test(named('an exec that deletes an unconfirmed tool write is a delete, not a straggler'), async () => {
    const { session, engine, root, disk } = await setup('engine-exec-delete')
    await engine.materialize()

    await engine.write('project:docs', '/fresh.md', 'durable')
    await engine.settle()
    assert.equal(await disk.readText(docsFile(root, 'fresh.md')), 'durable')

    // The absent-on-disk half of the same window. No scan has confirmed the
    // mirror write, so absence still looks like a lost write — but the exec is
    // what removed the file, and resurrecting it would undo the agent's work.
    await engine.exec("rm 'project%3Adocs/fresh.md'")
    await engine.settle()
    await engine.reconcile()

    await assert.rejects(session.mount('project:docs').read('/fresh.md'))
    assert.equal(await disk.stat(docsFile(root, 'fresh.md')), undefined)
    assert.deepEqual(failures, [])
  })

  test(named('a confirming scan retires the straggler guard so a later revert is captured'), async () => {
    const { session, engine, root, disk } = await setup('engine-guard-retired')
    await session.mount('project:docs').write('/a.md', 'v1')
    await engine.materialize()

    await engine.write('project:docs', '/a.md', 'v2')
    await engine.settle()
    // This scan observes v2 on disk, which closes the straggler window: the
    // mirror write demonstrably landed (§7.3 phase 4).
    await engine.exec('true')
    await engine.settle()
    assert.equal(await disk.readText(docsFile(root, 'a.md')), 'v2')

    // A tool now puts the pre-write bytes back — a checkout, a formatter, an
    // undo. That is the agent's work, not a lost mirror write, and a guard that
    // never retired would overwrite it from the branch and commit nothing.
    await engine.exec("printf v1 > 'project%3Adocs/a.md'")
    await engine.settle()

    assert.equal(await session.mount('project:docs').read('/a.md'), 'v1')
    assert.equal(await disk.readText(docsFile(root, 'a.md')), 'v1')
    await engine.reconcile()
    assert.equal(await session.mount('project:docs').read('/a.md'), 'v1')
    assert.equal(await disk.readText(docsFile(root, 'a.md')), 'v1')
    assert.deepEqual(failures, [])
  })

  test(named('a resumed engine restages a tool write the crashed process never mirrored'), async () => {
    const { session, engine, root, disk, controls, target } = await setup('engine-resume-straggler')
    await session.mount('project:docs').write('/a.md', 'v1')
    await session.mount('project:docs').write('/b.md', 'b1')
    await engine.materialize()

    // The process dies between the durable commit and the mirror write, taking
    // previousSha256/unconfirmed with it. A shell edit to another file is still
    // on disk and uncaptured (§7.5 lines 1 and 2).
    controls.swallowWrites.add(docsFile(root, 'a.md'))
    await engine.write('project:docs', '/a.md', 'v2')
    await engine.settle()
    await disk.writeText(docsFile(root, 'b.md'), 'b2 from the shell')
    assert.equal(await disk.readText(docsFile(root, 'a.md')), 'v1')
    controls.swallowWrites.clear()

    const resumed = createSyncEngine({
      session: await openSession('engine-resume-straggler'),
      target,
      root,
      events: { onCapture: event => captures.push(event), onCaptureFailed: event => failures.push(event) },
    })
    await resumed.materialize()
    await resumed.reconcile()

    // Rebuilt from history: stale disk bytes never overwrite the durable commit…
    assert.equal(await session.mount('project:docs').read('/a.md'), 'v2')
    assert.equal(await disk.readText(docsFile(root, 'a.md')), 'v2')
    // …and a genuine uncaptured shell change is still committed, not reverted.
    assert.equal(await session.mount('project:docs').read('/b.md'), 'b2 from the shell')
    assert.deepEqual(failures, [])

    // The guard is retired by that authoritative scan; ordinary edits follow the
    // ordinary path.
    await resumed.exec("printf v3 > 'project%3Adocs/a.md'")
    await resumed.settle()
    assert.equal(await session.mount('project:docs').read('/a.md'), 'v3')
  })

  test(named('a resumed engine never deletes a committed file the crashed process never mirrored'), async () => {
    const { session, engine, root, disk, controls, target } = await setup('engine-resume-lost-create')
    await session.mount('project:docs').write('/a.md', 'v1')
    await engine.materialize()

    controls.swallowWrites.add(docsFile(root, 'fresh.md'))
    await engine.write('project:docs', '/fresh.md', 'durable')
    await engine.settle()
    assert.equal(await disk.stat(docsFile(root, 'fresh.md')), undefined)
    controls.swallowWrites.clear()

    const resumed = createSyncEngine({
      session: await openSession('engine-resume-lost-create'),
      target,
      root,
      events: { onCapture: event => captures.push(event), onCaptureFailed: event => failures.push(event) },
    })
    await resumed.materialize()
    await resumed.reconcile()

    assert.equal(await session.mount('project:docs').read('/fresh.md'), 'durable')
    assert.equal(await disk.readText(docsFile(root, 'fresh.md')), 'durable')
    assert.deepEqual(failures, [])

    // A real removal after the guard retires still deletes at reconcile.
    await resumed.exec("rm 'project%3Adocs/fresh.md'")
    await resumed.settle()
    await resumed.reconcile()
    await assert.rejects(session.mount('project:docs').read('/fresh.md'))
  })

  test(named('a resumed engine weighs divergence against the whole durable lineage'), async () => {
    const { session, engine, root, disk, controls, target } = await setup('engine-resume-lineage')
    await session.mount('project:docs').write('/a.md', 'v0')
    await engine.materialize()

    // Two consecutive Phase-2 writes whose mirror writes are both silently lost.
    // Disk is stuck two versions back, on a sha the NEWEST write's parent never
    // held, so a rebuild that only knows that parent reads v0 as an agent change
    // and commits the durable v2 away (§7.3 phase 4 across resume).
    controls.swallowWrites.add(docsFile(root, 'a.md'))
    await engine.write('project:docs', '/a.md', 'v1')
    await engine.write('project:docs', '/a.md', 'v2')
    await engine.settle()
    assert.equal(await disk.readText(docsFile(root, 'a.md')), 'v0')
    controls.swallowWrites.clear()

    const resumed = createSyncEngine({
      session: await openSession('engine-resume-lineage'),
      target,
      root,
      events: { onCapture: event => captures.push(event), onCaptureFailed: event => failures.push(event) },
    })
    await resumed.materialize()
    await resumed.reconcile()

    assert.equal(await session.mount('project:docs').read('/a.md'), 'v2')
    assert.equal(await disk.readText(docsFile(root, 'a.md')), 'v2')
    assert.deepEqual(captures, [])
    assert.deepEqual(failures, [])

    // Disk content from outside the lineage is still an uncaptured exec change.
    await disk.writeText(docsFile(root, 'a.md'), 'from the shell')
    await resumed.reconcile()
    assert.equal(await session.mount('project:docs').read('/a.md'), 'from the shell')
  })

  test(named('the first exec after a resume owns the mirror, whatever the lineage says'), async () => {
    const { session, engine, root, disk, target } = await setup('engine-resume-exec-revert')
    await session.mount('project:docs').write('/a.md', 'v0')
    await session.mount('project:docs').write('/a.md', 'v1')
    await engine.materialize()
    assert.equal(await disk.readText(docsFile(root, 'a.md')), 'v1')

    const resumed = createSyncEngine({
      session: await openSession('engine-resume-exec-revert'),
      target,
      root,
      events: { onCapture: event => captures.push(event), onCaptureFailed: event => failures.push(event) },
    })
    await resumed.materialize()

    // The history-backed guard is armed and v0 is squarely inside the lineage,
    // so on content alone this is indistinguishable from the stale mirror a
    // crash leaves behind. The exec is the signal that says otherwise, and
    // re-materializing v1 over it would discard the agent's revert.
    await resumed.exec("printf v0 > 'project%3Adocs/a.md'")
    await resumed.settle()

    assert.equal(await session.mount('project:docs').read('/a.md'), 'v0')
    assert.equal(await disk.readText(docsFile(root, 'a.md')), 'v0')
    assert.deepEqual(failures, [])

    await resumed.reconcile()
    assert.equal(await session.mount('project:docs').read('/a.md'), 'v0')
    assert.equal(await disk.readText(docsFile(root, 'a.md')), 'v0')
  })

  test(named('a throwing host handler neither aborts a capture nor kills the process'), async () => {
    // Nothing awaits what trigger() starts. Before the fix a throwing handler
    // rejected the capture chain, which Node reports as an unhandled rejection
    // and, by default, exits on — this test file surviving IS that assertion.
    const workspace = await harness.create()
    workspaces.push(workspace)
    const session = await openSession('engine-throwing-handlers', false)
    const logged: unknown[] = []
    const engine = createSyncEngine({
      session,
      target: workspace.target,
      root: workspace.root,
      logger: { error: error => logged.push(error) },
      events: {
        onCapture() {
          throw new Error('host onCapture exploded')
        },
        onCaptureFailed() {
          throw new Error('host onCaptureFailed exploded')
        },
      },
    })
    await session.mount('project:docs').write('/a.md', 'v1')
    await engine.materialize()

    workspace.controls.failScans = 1
    await engine.exec("printf v2 > 'project%3Adocs/a.md'")
    await engine.settle()

    // The slot was released despite the throwing failure handler, and the retry
    // commits even though onCapture throws too.
    engine.captureAfterExec()
    await engine.settle()
    assert.equal(await session.mount('project:docs').read('/a.md'), 'v2')
    assert.equal(logged.length, 2)
    assert.deepEqual(
      logged.map(error => (error instanceof Error ? error.message : String(error))),
      ['host onCaptureFailed exploded', 'host onCapture exploded'],
    )
  })

  test(named('a capture blocked by a revoked grant names its mount in the failure event'), async () => {
    const { session, engine } = await setup('engine-revoked')
    await session.mount('project:docs').write('/a.md', 'v1')
    await engine.materialize()

    grants['project:docs'] = 'none'
    await engine.exec("printf v2 > 'project%3Adocs/a.md'")
    await engine.settle()

    assert.equal(failures.length, 1)
    assert.equal(failures[0]?.mountKey, 'project:docs')
    assert.ok(failures[0]?.error instanceof PermissionDeniedError)
    assert.equal(await session.mount('project:docs').read('/a.md'), 'v1')
  })
}
