/**
 * Architecture §12 performance budgets over a real network target (§11 S2:
 * "S2 re-measures the same rows over a real network target, where remote exec
 * dominates"; §14 risk 4).
 *
 * Only the rows that touch the target are measured here. Session read, fork,
 * and merge never speak to a target at all — they are kernel-and-PostgreSQL
 * work, already measured by `sync-budgets.integration.test.ts`, and running
 * them again through an ssh suite would measure the same code twice and call
 * the second number "SSH".
 *
 * What a network target actually changes is the shape claims, and they are the
 * point of this file:
 *
 * - A Phase-2 write must still resolve on the durable commit alone. If the ssh
 *   `writeFile` were on the critical path, every visible write would pay a
 *   round trip, and the §12 write budget would be a fiction off-machine.
 * - A Phase-3 trigger must still cost nothing visible, with the scan exec —
 *   the most expensive single operation in the system — entirely behind it.
 * - A warm re-acquire is one liveness probe, so it costs one remote exec and
 *   not a reseed. That is the row where the network legitimately shows up.
 *
 * Method matches the local suite: warm up, run N times, judge the BEST run, and
 * print every measurement. Budgets are set from measured containerized-sshd
 * numbers with headroom for a shared runner, and the printed value is the
 * regression signal. A loopback container is the FLOOR of the §12 remote-exec
 * assumption (150-500 ms), never its ceiling: a real WAN host is slower by its
 * RTT, and the assertions below are ceilings on this fixture, not promises
 * about someone's datacenter.
 *
 * Opt-in by construction, exactly like the kill matrix: this file matches
 * neither the unit nor the integration glob, and only `npm run test:ssh` runs
 * it. It never skips silently.
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import posix from 'node:path/posix'
import test, { after, before } from 'node:test'

import { Pool } from 'pg'

import { createTuddoFs, type SessionFileSystem } from '../index.js'
import { createSshTarget, createSyncEngine, migrate, type SyncEngine, type SyncTarget } from '../internal.js'
import { externalSshHost, startContainerSshHost, type SshHost } from './ssh-host.js'

if (!process.env.TUDDOFS_DATABASE_URL) {
  throw new Error('TUDDOFS_DATABASE_URL is required; the SSH budget suite never skips silently')
}

const pool = new Pool({ connectionString: process.env.TUDDOFS_DATABASE_URL })
const tenant = 'sync-budgets-ssh'
const actor = { id: 'user-budgets-ssh', tenant }
const mount = 'project:docs'

/** Fewer samples than the local suite: every run here is a real ssh session. */
const SAMPLES = 5
const WARMUPS = 2

let sshHost: Promise<SshHost> | undefined
const workspaces: string[] = []

function host(): Promise<SshHost> {
  sshHost ??=
    process.env.TUDDOFS_SSH_HOST === undefined ? startContainerSshHost('gnu') : Promise.resolve(externalSshHost())
  return sshHost
}

before(async () => {
  await migrate(pool)
  await pool.query(
    'TRUNCATE tuddo_heads, tuddo_refs, tuddo_commits, tuddo_tree_entries, tuddo_trees, tuddo_blobs RESTART IDENTITY CASCADE',
  )
})

after(async () => {
  if (sshHost !== undefined) {
    const started = await sshHost
    const target = createSshTarget(started.targetOptions(started.workspaceBase))
    for (const root of workspaces) {
      await target.exec(`rm -rf '${root}'`).catch(() => undefined)
    }
    await started.dispose()
  }
  await pool.end()
})

async function openSession(sessionId: string): Promise<SessionFileSystem> {
  const fs = createTuddoFs({
    pool,
    grants: { resolve: async () => ({ read: true, write: 'direct' as const }) },
  })
  return fs.open({ actor, sessionId, mounts: [mount] })
}

async function freshWorkspace(): Promise<{ root: string; target: SyncTarget }> {
  const started = await host()
  const root = posix.join(started.workspaceBase, `budget-${randomUUID()}`, 'workspace')
  workspaces.push(posix.dirname(root))
  return { root, target: createSshTarget(started.targetOptions(root)) }
}

/** Best of {@link SAMPLES} timed runs, in milliseconds, after {@link WARMUPS} untimed ones. */
async function best(label: string, run: (iteration: number) => Promise<unknown>): Promise<number> {
  for (let iteration = 0; iteration < WARMUPS; iteration += 1) await run(-1 - iteration)
  let fastest = Infinity
  for (let iteration = 0; iteration < SAMPLES; iteration += 1) {
    const started = performance.now()
    await run(iteration)
    fastest = Math.min(fastest, performance.now() - started)
  }
  console.log(`§12 [ssh] ${label}: ${fastest.toFixed(2)} ms (best of ${SAMPLES})`)
  return fastest
}

test('§12 [ssh] one remote exec round trip', async () => {
  const { target } = await freshWorkspace()
  const elapsed = await best('remote exec round trip', async () => {
    const result = await target.exec('true')
    assert.equal(result.exitCode, 0)
  })
  // The §12 assumption is 150-500 ms for remote exec. A containerized sshd on
  // loopback is the floor of that range, and the ceiling here only catches a
  // regression that turned one round trip into several.
  assert.ok(elapsed <= 500, `remote exec assumption is 150-500 ms, measured ${elapsed.toFixed(2)} ms`)
})

test('§12 [ssh] session write stays inside 20 ms visible over a real network', async () => {
  const { root, target } = await freshWorkspace()
  const session = await openSession('budget-ssh-write')
  const engine = createSyncEngine({ session, target, root })
  await engine.materialize()

  const elapsed = await best('session write', iteration => engine.write(mount, '/a.md', `v${iteration}`))
  assert.ok(elapsed <= 20, `session write budget is 8-20 ms visible, measured ${elapsed.toFixed(2)} ms`)

  // The claim the network is here to test: the visible write resolves on the
  // durable commit, with the remote mirror write still in flight. If it were on
  // the critical path this write could not beat one ssh round trip, which the
  // first measurement in this file shows is an order of magnitude slower.
  const mirrored = engine.mirrorPath(mount, '/late.md')
  const result = await engine.write(mount, '/late.md', 'not yet on the remote')
  assert.equal(result.sha256.length, 64)
  await engine.settle()
  assert.equal((await target.readFile(mirrored)).toString('utf8'), 'not yet on the remote')
})

test('§12 [ssh] exec capture costs nothing visible', async () => {
  const { root, target } = await freshWorkspace()
  const session = await openSession('budget-ssh-capture')
  let captures = 0
  const engine: SyncEngine = createSyncEngine({
    session,
    target,
    root,
    events: { onCapture: () => (captures += 1) },
  })
  await session.mount(mount).write('/a.md', 'alpha')
  await engine.materialize()

  await engine.exec("printf triggered > 'project%3Adocs/a.md'")
  const before = captures
  const started = performance.now()
  engine.captureAfterExec()
  const elapsed = performance.now() - started
  console.log(`§12 [ssh] exec capture trigger: ${elapsed.toFixed(3)} ms`)

  // Zero visible cost, with an entire ssh scan behind the trigger.
  assert.equal(captures, before)
  assert.ok(elapsed <= 1, `exec capture must be invisible, measured ${elapsed.toFixed(3)} ms`)
  await engine.settle()
  assert.equal(await session.mount(mount).read('/a.md'), 'triggered')
})

test('§12 [ssh] warm re-acquire is one liveness probe, not a reseed', async () => {
  const { root, target } = await freshWorkspace()
  const session = await openSession('budget-ssh-warm')
  for (let index = 0; index < 25; index += 1) {
    await session.mount(mount).write(`/file-${index}.md`, `body ${index}`)
  }
  await createSyncEngine({ session, target, root }).materialize()

  const elapsed = await best('warm re-acquire', () => createSyncEngine({ session, target, root }).materialize())
  // This is the row where the network shows up, and the only honest budget is
  // "one remote exec, not 25 file transfers". A reseed of this workspace would
  // cost dozens of round trips; the ceiling is set well below that and well
  // above one probe.
  assert.ok(elapsed <= 1_000, `warm re-acquire must stay near one remote exec, measured ${elapsed.toFixed(2)} ms`)
})
