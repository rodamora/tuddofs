/**
 * Architecture §12 performance budgets, measured rather than asserted by
 * assumption (§14 risk 4: "perf budgets are estimates until S1/S2 measure").
 *
 * Method: every operation is warmed, then run N times against real PostgreSQL
 * and a real local-directory target, and judged on the BEST observed run. A
 * budget describes what the system costs, not what a shared CI runner happens
 * to schedule; the minimum is the only statistic that survives an unrelated
 * process stealing the core mid-measurement. Every measurement is printed, so a
 * regression that stays inside the budget is still visible in the log.
 *
 * Two rows of §12 are shape claims, not latency claims, and are asserted as
 * shapes: "exec capture 0 visible" means the trigger returns before its scan
 * commits, and "session write, mirror write off the critical path" means the
 * mirror write is still pending when `write` resolves.
 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { after, before, beforeEach } from 'node:test'

import { Pool } from 'pg'
import { createTuddoFs, type SessionFileSystem } from '../index.js'
import { createLocalDirectoryTarget, createSyncEngine, migrate } from '../internal.js'

const pool = new Pool({ connectionString: process.env.TUDDOFS_DATABASE_URL })
const tenant = 'sync-budgets-integration'
const actor = { id: 'user-budgets', tenant }
const roots: string[] = []

const SAMPLES = 9
const WARMUPS = 3

before(async () => migrate(pool))
beforeEach(async () => {
  await pool.query(
    'TRUNCATE tuddo_heads, tuddo_refs, tuddo_commits, tuddo_tree_entries, tuddo_trees, tuddo_blobs RESTART IDENTITY CASCADE',
  )
})
after(async () => {
  await pool.end()
  for (const root of roots) await rm(root, { recursive: true, force: true }).catch(() => undefined)
})

const fs = () =>
  createTuddoFs({
    pool,
    grants: { resolve: async () => ({ read: true, write: 'direct' as const }) },
  })

async function openSession(sessionId: string): Promise<SessionFileSystem> {
  return fs().open({ actor, sessionId, mounts: ['project:docs'] })
}

async function freshRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'tuddofs-budget-'))
  roots.push(root)
  return root
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
  console.log(`§12 ${label}: ${fastest.toFixed(2)} ms (best of ${SAMPLES})`)
  return fastest
}

test('§12 session read stays inside 3 ms', async () => {
  const session = await openSession('budget-read')
  await session.mount('project:docs').write('/a.md', 'alpha')

  const elapsed = await best('session read', () => session.mount('project:docs').read('/a.md'))
  assert.ok(elapsed <= 3, `session read budget is 1-3 ms, measured ${elapsed.toFixed(2)} ms`)
})

test('§12 session write stays inside 20 ms visible with the mirror write off the critical path', async () => {
  const root = await freshRoot()
  const session = await openSession('budget-write')
  const engine = createSyncEngine({ session, target: createLocalDirectoryTarget({ root }), root })
  await engine.materialize()

  const elapsed = await best('session write', iteration => engine.write('project:docs', '/a.md', `v${iteration}`))
  assert.ok(elapsed <= 20, `session write budget is 8-20 ms visible, measured ${elapsed.toFixed(2)} ms`)

  // "Mirror write off the critical path" is why that budget is reachable at
  // all. Hold the target's writeFile open and the visible write still resolves
  // on the durable commit alone, with nothing on disk yet.
  let release!: () => void
  const held = new Promise<void>(resolve => {
    release = resolve
  })
  const base = createLocalDirectoryTarget({ root })
  const gated = createSyncEngine({
    session,
    root,
    // A warm re-acquire touches no file, so only the Phase-2 write is gated.
    target: {
      exec: (cmd, execOptions) => base.exec(cmd, execOptions),
      readFile: path => base.readFile(path),
      mkdir: path => base.mkdir(path),
      writeFile: async (path, bytes) => {
        await held
        await base.writeFile(path, bytes)
      },
    },
  })
  await gated.materialize()
  const result = await gated.write('project:docs', '/late.md', 'not yet on disk')
  assert.equal(result.sha256.length, 64)
  await assert.rejects(stat(join(root, 'project%3Adocs', 'late.md')))
  release()
  await gated.settle()
  assert.equal(await readFile(join(root, 'project%3Adocs', 'late.md'), 'utf8'), 'not yet on disk')
})

test('§12 exec capture costs nothing visible', async () => {
  const root = await freshRoot()
  const session = await openSession('budget-capture')
  let captures = 0
  const engine = createSyncEngine({
    session,
    target: createLocalDirectoryTarget({ root }),
    root,
    events: { onCapture: () => (captures += 1) },
  })
  await session.mount('project:docs').write('/a.md', 'alpha')
  await engine.materialize()

  await engine.exec("printf triggered > 'project%3Adocs/a.md'")
  const before = captures
  const started = performance.now()
  engine.captureAfterExec()
  const elapsed = performance.now() - started
  console.log(`§12 exec capture trigger: ${elapsed.toFixed(3)} ms`)

  // Zero visible cost: the trigger hands the scan to the slot and returns
  // before any commit happens.
  assert.equal(captures, before)
  assert.ok(elapsed <= 1, `exec capture must be invisible, measured ${elapsed.toFixed(3)} ms`)
  await engine.settle()
  assert.equal(await session.mount('project:docs').read('/a.md'), 'triggered')
})

test('§12 warm re-acquire stays inside 0.1 s', async () => {
  const root = await freshRoot()
  const session = await openSession('budget-warm')
  for (let index = 0; index < 25; index += 1) {
    await session.mount('project:docs').write(`/file-${index}.md`, `body ${index}`)
  }
  const target = createLocalDirectoryTarget({ root })
  await createSyncEngine({ session, target, root }).materialize()

  const elapsed = await best('warm re-acquire', () => createSyncEngine({ session, target, root }).materialize())
  assert.ok(elapsed <= 100, `warm re-acquire budget is 0.1 s, measured ${elapsed.toFixed(2)} ms`)
})

test('§12 fork costs under 100 ms per mount and merge under 1 s at 100 paths', async () => {
  let forks = 0
  const forked = await best('fork', () => openSession(`budget-fork-${(forks += 1)}`))
  assert.ok(forked <= 100, `fork budget is 10-100 ms per mount, measured ${forked.toFixed(2)} ms`)

  // Merge is timed on its own: each branch is built first with its own 100
  // paths, so no run pays for another run's setup or collides with it.
  const rounds = 3
  let fastest = Infinity
  for (let round = 0; round < rounds; round += 1) {
    const branch = await openSession(`budget-merge-${round}`)
    for (let index = 0; index < 100; index += 1) {
      await branch.mount('project:docs').write(`/merge-${round}-${index}.md`, `body ${index}`)
    }
    const started = performance.now()
    const result = await branch.merge()
    fastest = Math.min(fastest, performance.now() - started)
    assert.equal(result['project:docs']?.status, 'merged')
  }
  console.log(`§12 merge at 100 paths: ${fastest.toFixed(2)} ms (best of ${rounds})`)
  assert.ok(fastest <= 1000, `merge budget is < 1 s at 100 paths, measured ${fastest.toFixed(2)} ms`)
})
