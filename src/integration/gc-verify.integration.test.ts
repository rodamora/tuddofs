import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import test, { after, before, beforeEach } from 'node:test'

import { Pool } from 'pg'

import type { BlobStore } from '../index.js'
import { createTuddoFs, migrate } from '../internal.js'

const pool = new Pool({ connectionString: process.env.TUDDOFS_DATABASE_URL })
const tenant = 'gc-verify-tenant'
const tenant2 = 'gc-verify-tenant-two'
const mount = 'project:gc'
const actor = 'gc-user'
const now = new Date('2026-08-10T12:00:00.000Z')
const grants = { resolve: async () => ({ read: true, write: 'direct' as const }) }
function deferred<T = void>() {
  let resolve!: (value?: T | PromiseLike<T>) => void
  const promise = new Promise<T>(resolvePromise => {
    resolve = value => resolvePromise(value as T)
  })
  return { promise, resolve }
}

class MemoryStore implements BlobStore {
  readonly objects = new Map<string, { bytes: Buffer; lastModified: Date }>()
  listStarted: (() => void) | undefined
  listGate: Promise<void> | undefined

  async put(key: string, bytes: Buffer): Promise<void> {
    this.objects.set(key, {
      bytes: Buffer.from(bytes),
      lastModified: new Date(now),
    })
  }

  async head(key: string): Promise<{ sizeBytes: number } | null> {
    const value = this.objects.get(key)
    return value ? { sizeBytes: value.bytes.length } : null
  }

  async get(key: string): Promise<Readable> {
    const value = this.objects.get(key)
    if (!value) throw new Error(`missing ${key}`)
    return Readable.from([value.bytes])
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key)
  }

  async list(prefix: string): Promise<readonly { key: string; lastModified: Date }[]> {
    this.listStarted?.()
    if (this.listGate) await this.listGate
    return [...this.objects]
      .filter(([key]) => key.startsWith(prefix))
      .map(([key, value]) => ({ key, lastModified: value.lastModified }))
  }
}

before(async () => {
  await migrate(pool)
})

beforeEach(async () => {
  await pool.query(
    'TRUNCATE tuddo_heads, tuddo_refs, tuddo_commits, tuddo_tree_entries, tuddo_trees, tuddo_blobs RESTART IDENTITY CASCADE',
  )
})

after(async () => {
  await pool.end()
})

test('gc keeps every commit reachable from refs and tags while collecting unreachable old history', async () => {
  const fs = createTuddoFs({ pool, grants, now: () => now })
  const branch = await fs.fork({
    tenant,
    mount,
    sessionId: 'gc-reachable',
    authorUser: actor,
  })
  assert.ok(branch)
  await fs.write({
    tenant,
    mount,
    ref: branch.ref,
    path: '/reachable.txt',
    bytes: 'reachable',
    authorUser: actor,
  })
  await pool.query(
    `INSERT INTO tuddo_refs (tenant, name, kind, commit_id, state)
     SELECT tenant, 'tag/project:gc/keep', 'tag', commit_id, 'open'
     FROM tuddo_refs WHERE tenant = $1 AND name = $2`,
    [tenant, branch.ref],
  )
  const unreachable = await pool.query<{ id: string }>(
    `INSERT INTO tuddo_commits
       (tenant, commit_sha, tree_id, parents, author_user, op, created_at)
     SELECT tenant, repeat('f', 64), tree_id, '{}', $2, 'write', now() - interval '2 days'
     FROM tuddo_commits WHERE tenant = $1 ORDER BY id LIMIT 1
     RETURNING id::text AS id`,
    [tenant, actor],
  )
  assert.equal(unreachable.rows.length, 1)
  const result = await fs.gc({ tenant, graceMs: 0 })
  assert.equal(result.skipped, false)
  const rows = await pool.query<{ id: string }>(
    'SELECT id::text AS id FROM tuddo_commits WHERE tenant = $1 ORDER BY id',
    [tenant],
  )
  assert.ok(rows.rows.some(row => row.id === branch.commitId.toString()))
  assert.ok(!rows.rows.some(row => row.id === unreachable.rows[0]?.id))
})
test('gc reports skipped false when no tenants are available', async () => {
  const fs = createTuddoFs({ pool, grants, now: () => now })

  const result = await fs.gc({ graceMs: 0 })

  assert.equal(result.skipped, false)
  assert.deepEqual(result.skippedTenants, [])
})

test('gc deletes old orphan uploads under tuddo tenant prefix but keeps young and foreign keys', async () => {
  const storage = new MemoryStore()
  storage.objects.set(`tuddo/${tenant}/old-orphan`, {
    bytes: Buffer.from('old'),
    lastModified: new Date('2026-08-08T00:00:00.000Z'),
  })
  storage.objects.set(`tuddo/${tenant}/young-orphan`, {
    bytes: Buffer.from('young'),
    lastModified: now,
  })
  storage.objects.set(`other/${tenant}/must-stay`, {
    bytes: Buffer.from('foreign'),
    lastModified: new Date('2026-08-01T00:00:00.000Z'),
  })
  const fs = createTuddoFs({ pool, grants, storage, now: () => now })

  await fs.gc({ tenant, graceMs: 24 * 60 * 60 * 1000 })

  assert.equal(storage.objects.has(`tuddo/${tenant}/old-orphan`), false)
  assert.equal(storage.objects.has(`tuddo/${tenant}/young-orphan`), true)
  assert.equal(storage.objects.has(`other/${tenant}/must-stay`), true)
})
test('seeded randomized GC preserves reachable forks, merge-shaped parents, and tags', async () => {
  const fs = createTuddoFs({ pool, grants, now: () => now })
  const configuredSeed = process.env.TUDDOFS_PROPERTY_SEED
  const initialSeed = configuredSeed === undefined ? 0x9e3779b9 : Number(configuredSeed)
  assert.ok(
    Number.isInteger(initialSeed) && initialSeed >= 0 && initialSeed <= 0xffffffff,
    'TUDDOFS_PROPERTY_SEED must be an unsigned 32-bit integer',
  )
  let seed = initialSeed
  const next = (): number => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
    return seed
  }
  const refs: string[] = []
  let iteration = 0
  try {
    for (; iteration < 24; iteration += 1) {
      const branch = await fs.fork({
        tenant,
        mount,
        sessionId: `property-${iteration}`,
        authorUser: actor,
      })
      assert.ok(branch)
      refs.push(branch.ref)
      const writes = 1 + (next() % 3)
      for (let write = 0; write < writes; write += 1) {
        const path = `/random-${next() % 5}.txt`
        const bytes = `property-${iteration}-${write}-${next()}`
        await fs.write({
          tenant,
          mount,
          ref: branch.ref,
          path,
          bytes,
          authorUser: actor,
        })
        assert.equal((await fs.read({ tenant, ref: branch.ref, path })).bytes.toString(), bytes)
      }
      if (iteration > 0 && next() % 2 === 0) {
        await pool.query(
          `INSERT INTO tuddo_refs (tenant, name, kind, commit_id, state)
         SELECT tenant, $2, 'tag', commit_id, 'open'
         FROM tuddo_refs WHERE tenant = $1 AND name = $3`,
          [tenant, `tag/property-${iteration}`, branch.ref],
        )
      }
      if (iteration > 1 && next() % 3 === 0) {
        const merge = await pool.query<{ id: string }>(
          `WITH current AS (
           SELECT r.commit_id, c.tree_id, c.commit_sha, c.parents, c.author_user, c.agent_kind,
                  c.thread_id, c.run_id, c.op
           FROM tuddo_refs r JOIN tuddo_commits c ON c.id = r.commit_id
           WHERE r.tenant = $1 AND r.name = $2
         ), other AS (
           SELECT commit_id FROM tuddo_refs
           WHERE tenant = $1 AND name <> $2
           ORDER BY name LIMIT 1
         )
         INSERT INTO tuddo_commits
           (tenant, commit_sha, tree_id, parents, author_user, agent_kind, thread_id, run_id, op, created_at)
         SELECT $1, repeat(md5(random()::text), 2), current.tree_id,
                ARRAY[current.commit_id, other.commit_id]::bigint[], current.author_user,
                current.agent_kind, current.thread_id, current.run_id, current.op, now()
         FROM current CROSS JOIN other
         RETURNING id::text AS id`,
          [tenant, branch.ref],
        )
        const mergeId = merge.rows[0]?.id
        if (mergeId) {
          await pool.query('UPDATE tuddo_refs SET commit_id = $3::bigint WHERE tenant = $1 AND name = $2', [
            tenant,
            branch.ref,
            mergeId,
          ])
        }
      }
      const gcResult = await fs.gc({ tenant, graceMs: 0 })
      assert.equal(gcResult.skipped, false, `seed=${initialSeed} iteration=${iteration}`)
      for (const ref of refs.slice(-2)) {
        const head = await pool.query<{ path: string }>(
          'SELECT path FROM tuddo_heads WHERE tenant = $1 AND ref_name = $2 ORDER BY path LIMIT 1',
          [tenant, ref],
        )
        if (head.rows[0]) {
          await fs.read({ tenant, ref, path: head.rows[0].path })
        }
      }
    }
  } catch (error) {
    throw new Error(`seed=${initialSeed} iteration=${iteration}`, {
      cause: error,
    })
  }
})

test('gc protects ancestors of grace-protected commits and collects both after grace expiry', async () => {
  const fs = createTuddoFs({ pool, grants, now: () => now })
  const branch = await fs.fork({
    tenant,
    mount,
    sessionId: 'grace-ancestor',
    authorUser: actor,
  })
  assert.ok(branch)
  await pool.query('DELETE FROM tuddo_refs WHERE tenant = $1', [tenant])
  await pool.query('UPDATE tuddo_commits SET created_at = $2 WHERE tenant = $1 AND id = $3', [
    tenant,
    new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000),
    branch.commitId.toString(),
  ])
  const child = await pool.query<{ id: string }>(
    `INSERT INTO tuddo_commits
       (tenant, commit_sha, tree_id, parents, author_user, op, created_at)
     SELECT tenant, repeat('a', 64), tree_id, ARRAY[$2::bigint], $3, 'write', $4
     FROM tuddo_commits WHERE tenant = $1 AND id = $2
     RETURNING id::text AS id`,
    [tenant, branch.commitId.toString(), actor, now],
  )
  assert.equal(child.rows.length, 1)

  await fs.gc({ tenant, graceMs: 24 * 60 * 60 * 1000 })
  assert.equal(
    (
      await pool.query('SELECT 1 FROM tuddo_commits WHERE tenant = $1 AND id = ANY($2::bigint[])', [
        tenant,
        [branch.commitId.toString(), child.rows[0]?.id],
      ])
    ).rowCount,
    2,
  )

  await pool.query('UPDATE tuddo_commits SET created_at = $2 WHERE tenant = $1 AND id = $3', [
    tenant,
    new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000),
    child.rows[0]?.id,
  ])
  await fs.gc({ tenant, graceMs: 24 * 60 * 60 * 1000 })
  assert.equal(
    (
      await pool.query('SELECT 1 FROM tuddo_commits WHERE tenant = $1 AND id = ANY($2::bigint[])', [
        tenant,
        [branch.commitId.toString(), child.rows[0]?.id],
      ])
    ).rowCount,
    0,
  )
})

test('shared advisory locks require shared unlock and block GC exclusive acquisition', async () => {
  const key = `tuddo:gc:${tenant}`
  const holder = await pool.connect()
  const probe = await pool.connect()
  let probeLocked = false
  try {
    await holder.query('SELECT pg_advisory_lock_shared(hashtext($1))', [key])
    const wrongMode = await holder.query<{ unlocked: boolean }>('SELECT pg_advisory_unlock(hashtext($1)) AS unlocked', [
      key,
    ])
    assert.equal(wrongMode.rows[0]?.unlocked, false)
    const blocked = await probe.query<{ locked: boolean }>('SELECT pg_try_advisory_lock(hashtext($1)) AS locked', [key])
    assert.equal(blocked.rows[0]?.locked, false)
    const released = await holder.query<{ unlocked: boolean }>(
      'SELECT pg_advisory_unlock_shared(hashtext($1)) AS unlocked',
      [key],
    )
    assert.equal(released.rows[0]?.unlocked, true)
    const acquired = await probe.query<{ locked: boolean }>('SELECT pg_try_advisory_lock(hashtext($1)) AS locked', [
      key,
    ])
    probeLocked = acquired.rows[0]?.locked === true
    assert.equal(probeLocked, true)
  } finally {
    if (probeLocked) await probe.query('SELECT pg_advisory_unlock(hashtext($1))', [key]).catch(() => undefined)
    await holder.query('SELECT pg_advisory_unlock_shared(hashtext($1))', [key]).catch(() => undefined)
    probe.release()
    holder.release()
  }
})

test('storage-backed writes hold a shared tenant lock while GC exclusive acquisition fails', async () => {
  const entered = deferred()
  const releaseStorage = deferred()
  let enteredOnce = false
  const storage: BlobStore = {
    async put() {},
    async head() {
      if (!enteredOnce) {
        enteredOnce = true
        entered.resolve()
      }
      await releaseStorage.promise
      return null
    },
    async get() {
      return Readable.from([])
    },
    async delete() {},
  }
  const fs = createTuddoFs({
    pool,
    grants,
    storage,
    inlineMaxBytes: 1,
    now: () => now,
  })
  const branch = await fs.fork({
    tenant,
    mount,
    sessionId: 'shared-write-lock',
    authorUser: actor,
  })
  assert.ok(branch)
  const write = fs.write({
    tenant,
    mount,
    ref: branch.ref,
    path: '/shared-lock.bin',
    bytes: 'large',
    authorUser: actor,
  })
  await entered.promise
  const probe = await pool.connect()
  try {
    const lock = await probe.query<{ locked: boolean }>('SELECT pg_try_advisory_lock(hashtext($1)) AS locked', [
      `tuddo:gc:${tenant}`,
    ])
    assert.equal(lock.rows[0]?.locked, false)
  } finally {
    probe.release()
    releaseStorage.resolve()
  }
  await write
})

test('storage-backed writes to different refs share the tenant lock and overlap', async () => {
  const firstHead = deferred()
  const releaseStorage = deferred()
  let headCalls = 0
  const storage: BlobStore = {
    async put() {},
    async head() {
      headCalls += 1
      if (headCalls === 2) firstHead.resolve()
      await releaseStorage.promise
      return null
    },
    async get() {
      return Readable.from([])
    },
    async delete() {},
  }
  const fs = createTuddoFs({
    pool,
    grants,
    storage,
    inlineMaxBytes: 1,
    now: () => now,
  })
  const first = await fs.fork({
    tenant,
    mount,
    sessionId: 'shared-overlap-one',
    authorUser: actor,
  })
  const second = await fs.fork({
    tenant,
    mount,
    sessionId: 'shared-overlap-two',
    authorUser: actor,
  })
  assert.ok(first)
  assert.ok(second)
  const firstWrite = fs.write({
    tenant,
    mount,
    ref: first.ref,
    path: '/first.bin',
    bytes: 'first-large',
    authorUser: actor,
  })
  const secondWrite = fs.write({
    tenant,
    mount,
    ref: second.ref,
    path: '/second.bin',
    bytes: 'second-large',
    authorUser: actor,
  })
  try {
    await firstHead.promise
  } finally {
    releaseStorage.resolve()
  }
  await Promise.all([firstWrite, secondWrite])
})
test('gc deletes an unreachable deep linear chain child-first in bounded maintenance transactions', async () => {
  let commitSweepTransactions = 0
  const countingPool = {
    async connect() {
      const client = await pool.connect()
      return {
        query: async <Row extends Record<string, unknown>>(text: string, values?: readonly unknown[]) => {
          if (text.includes('WITH RECURSIVE reachable')) commitSweepTransactions += 1
          const result = await client.query<Row>(text, values as unknown[])
          if (text === 'COMMIT') {
            const dangling = await pool.query(
              `SELECT 1
               FROM tuddo_commits child
               CROSS JOIN LATERAL unnest(child.parents) AS parent_ids(parent_id)
               WHERE child.tenant = $1
                 AND NOT EXISTS (
                   SELECT 1 FROM tuddo_commits parent
                   WHERE parent.tenant = $1 AND parent.id = parent_ids.parent_id
                 )`,
              [tenant],
            )
            assert.equal(dangling.rowCount, 0, 'every committed maintenance boundary must preserve parent integrity')
          }
          return result
        },
        release: (error?: Error) => client.release(error),
      }
    },
  }
  const fs = createTuddoFs({ pool: countingPool, grants, now: () => now })
  const branch = await fs.fork({
    tenant,
    mount,
    sessionId: 'batch-chain',
    authorUser: actor,
  })
  assert.ok(branch)
  await pool.query('DELETE FROM tuddo_refs WHERE tenant = $1', [tenant])
  const old = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000)
  await pool.query(
    `DO $$
     DECLARE
       parent_id BIGINT := ${branch.commitId.toString()}::bigint;
       idx INTEGER;
     BEGIN
       UPDATE tuddo_commits
       SET created_at = TIMESTAMPTZ '${old.toISOString()}'
       WHERE tenant = '${tenant}' AND id = parent_id;
       FOR idx IN 0..599 LOOP
         INSERT INTO tuddo_commits
           (tenant, commit_sha, tree_id, parents, author_user, op, created_at)
         SELECT '${tenant}', repeat(md5(idx::text), 2), tree_id, ARRAY[parent_id],
                '${actor}', 'write', TIMESTAMPTZ '${old.toISOString()}'
         FROM tuddo_commits
         WHERE tenant = '${tenant}' AND id = parent_id;
       END LOOP;
     END $$`,
  )
  await fs.gc({ tenant, graceMs: 0 })
  assert.equal((await pool.query('SELECT 1 FROM tuddo_commits WHERE tenant = $1', [tenant])).rowCount, 0)
  assert.equal(
    (
      await pool.query(
        `SELECT 1
         FROM tuddo_commits child
         CROSS JOIN LATERAL unnest(child.parents) AS parent_ids(parent_id)
         WHERE child.tenant = $1
           AND NOT EXISTS (SELECT 1 FROM tuddo_commits parent WHERE parent.tenant = $1 AND parent.id = parent_ids.parent_id)`,
        [tenant],
      )
    ).rowCount,
    0,
  )
  assert.ok(
    commitSweepTransactions <= Math.ceil(601 / 500) + 2,
    `commit sweep used ${commitSweepTransactions} transactions`,
  )
})
test('gc race keeps a blob readable when an identical write lands during orphan deletion', async () => {
  const storage = new MemoryStore()
  const fs = createTuddoFs({
    pool,
    grants,
    storage,
    inlineMaxBytes: 1,
    now: () => now,
  })
  const oldBranch = await fs.fork({
    tenant,
    mount,
    sessionId: 'race-old',
    authorUser: actor,
  })
  const liveBranch = await fs.fork({
    tenant,
    mount,
    sessionId: 'race-live',
    authorUser: actor,
  })
  assert.ok(oldBranch)
  assert.ok(liveBranch)
  const bytes = 'race-large-content'
  const oldWrite = await fs.write({
    tenant,
    mount,
    ref: oldBranch.ref,
    path: '/race.bin',
    bytes,
    authorUser: actor,
  })
  await pool.query(
    `UPDATE tuddo_blobs SET created_at = $2
     WHERE tenant = $1 AND sha256 = $3`,
    [tenant, new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000), oldWrite.sha256],
  )
  const object = storage.objects.get(`tuddo/${tenant}/${oldWrite.sha256}`)
  assert.ok(object)
  object.lastModified = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000)
  await pool.query(
    `UPDATE tuddo_commits SET created_at = $2
     WHERE tenant = $1 AND id = (SELECT commit_id FROM tuddo_refs WHERE tenant = $1 AND name = $3)`,
    [tenant, new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000), oldBranch.ref],
  )
  await pool.query('UPDATE tuddo_refs SET state = $3, settled_at = $4 WHERE tenant = $1 AND name = $2', [
    tenant,
    oldBranch.ref,
    'merged',
    new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000),
  ])
  let started!: () => void
  const startedPromise = new Promise<void>(resolve => {
    started = resolve
  })
  let unblock!: () => void
  const gate = new Promise<void>(resolve => {
    unblock = resolve
  })
  storage.listStarted = () => started()
  storage.listGate = gate
  const gcPromise = fs.gc({ tenant, graceMs: 0, settledBranchRetentionMs: 0 })
  await startedPromise
  const rewritePromise = fs.write({
    tenant,
    mount,
    ref: liveBranch.ref,
    path: '/race.bin',
    bytes,
    authorUser: actor,
  })
  unblock()
  await gcPromise
  await rewritePromise
  assert.equal((await fs.read({ tenant, ref: liveBranch.ref, path: '/race.bin' })).bytes.toString(), bytes)
})

test('verify keeps same-named refs isolated across tenants', async () => {
  const fs = createTuddoFs({ pool, grants, now: () => now })
  const first = await fs.fork({
    tenant,
    mount,
    sessionId: 'same-ref',
    authorUser: actor,
  })
  const second = await fs.fork({
    tenant: tenant2,
    mount,
    sessionId: 'same-ref',
    authorUser: actor,
  })
  assert.ok(first)
  assert.ok(second)
  await fs.write({
    tenant,
    mount,
    ref: first.ref,
    path: '/tenant-one',
    bytes: 'one',
    authorUser: actor,
  })
  await fs.write({
    tenant: tenant2,
    mount,
    ref: second.ref,
    path: '/tenant-two',
    bytes: 'two',
    authorUser: actor,
  })
  const report = await fs.verify()
  assert.equal(report.findings.length, 0)
})

test('verify reports zero checked blobs when storage sampling is unavailable', async () => {
  const fs = createTuddoFs({ pool, grants, now: () => now })
  const branch = await fs.fork({
    tenant,
    mount,
    sessionId: 'verify-no-storage',
    authorUser: actor,
  })
  assert.ok(branch)
  await fs.write({
    tenant,
    mount,
    ref: branch.ref,
    path: '/inline',
    bytes: 'inline',
    authorUser: actor,
  })
  const report = await fs.verify({ tenant })
  assert.equal(report.checked.blobs, 0)
})
test('verify SQL sampling limits hash and storage checks without false ref drift', async () => {
  const storage = new MemoryStore()
  const fs = createTuddoFs({
    pool,
    grants,
    storage,
    inlineMaxBytes: 1,
    now: () => now,
  })
  const branch = await fs.fork({
    tenant,
    mount,
    sessionId: 'verify-sample',
    authorUser: actor,
  })
  assert.ok(branch)
  await fs.write({
    tenant,
    mount,
    ref: branch.ref,
    path: '/sample.bin',
    bytes: 'sample',
    authorUser: actor,
  })
  const report = await fs.verify({ tenant, sample: 1 })
  assert.equal(report.ok, true)
  assert.ok(report.checked.trees <= 1)
  assert.ok(report.checked.commits <= 1)
  assert.ok(report.checked.blobs <= 1)
})

test('tag-only commits survive collection after their branch ref is removed', async () => {
  const fs = createTuddoFs({ pool, grants, now: () => now })
  const branch = await fs.fork({
    tenant,
    mount,
    sessionId: 'tag-only',
    authorUser: actor,
  })
  assert.ok(branch)
  const tagName = 'tag/project:gc/tag-only'
  await fs.write({
    tenant,
    mount,
    ref: branch.ref,
    path: '/tagged',
    bytes: 'tagged',
    authorUser: actor,
  })
  const tip = await pool.query<{ id: string }>(
    'SELECT commit_id::text AS id FROM tuddo_refs WHERE tenant = $1 AND name = $2',
    [tenant, branch.ref],
  )
  await pool.query(
    `INSERT INTO tuddo_refs (tenant, name, kind, commit_id, state)
     VALUES ($1, $2, 'tag', $3::bigint, 'open')`,
    [tenant, tagName, tip.rows[0]?.id],
  )
  await pool.query('DELETE FROM tuddo_refs WHERE tenant = $1 AND name = $2', [tenant, branch.ref])
  await fs.gc({ tenant, graceMs: 0 })
  assert.equal(
    (await pool.query('SELECT 1 FROM tuddo_commits WHERE tenant = $1 AND id = $2', [tenant, tip.rows[0]?.id])).rowCount,
    1,
  )
})

test('concurrent gc skips when the tenant advisory lock is already held', async () => {
  const storage = new MemoryStore()
  let started!: () => void
  const startedPromise = new Promise<void>(resolve => {
    started = resolve
  })
  storage.listStarted = started
  let release!: () => void
  storage.listGate = new Promise<void>(resolve => {
    release = resolve
  })
  const fs = createTuddoFs({ pool, grants, storage, now: () => now })

  const first = fs.gc({ tenant, graceMs: 0 })
  await startedPromise
  const second = await fs.gc({ tenant, graceMs: 0 })
  assert.equal(second.skipped, true)
  release()
  assert.equal((await first).skipped, false)
})
test('unscoped gc reports busy tenants separately from tenants it processed', async () => {
  const fs = createTuddoFs({ pool, grants, now: () => now })
  const first = await fs.fork({
    tenant,
    mount,
    sessionId: 'busy-tenant',
    authorUser: actor,
  })
  const second = await fs.fork({
    tenant: tenant2,
    mount,
    sessionId: 'free-tenant',
    authorUser: actor,
  })
  assert.ok(first)
  assert.ok(second)
  const holder = await pool.connect()
  await holder.query('SELECT pg_advisory_lock(hashtext($1))', [`tuddo:gc:${tenant}`])
  try {
    const report = await fs.gc({ graceMs: 0 })
    assert.equal(report.skipped, false)
    assert.deepEqual(report.skippedTenants, [tenant])
  } finally {
    await holder.query('SELECT pg_advisory_unlock(hashtext($1))', [`tuddo:gc:${tenant}`])
    holder.release()
  }
})

test('gc removes settled branch refs and heads atomically after retention', async () => {
  const fs = createTuddoFs({ pool, grants, now: () => now })
  const branch = await fs.fork({
    tenant,
    mount,
    sessionId: 'gc-settled',
    authorUser: actor,
  })
  assert.ok(branch)
  await fs.write({
    tenant,
    mount,
    ref: branch.ref,
    path: '/settled.txt',
    bytes: 'settled',
    authorUser: actor,
  })
  await pool.query(
    `UPDATE tuddo_refs
     SET state = 'merged', settled_at = now() - interval '8 days'
     WHERE tenant = $1 AND name = $2`,
    [tenant, branch.ref],
  )

  const result = await fs.gc({
    tenant,
    graceMs: 0,
    settledBranchRetentionMs: 0,
  })

  assert.equal(result.settledBranches, 1)
  assert.equal(
    (await pool.query('SELECT 1 FROM tuddo_refs WHERE tenant = $1 AND name = $2', [tenant, branch.ref])).rowCount,
    0,
  )
  assert.equal(
    (await pool.query('SELECT 1 FROM tuddo_heads WHERE tenant = $1 AND ref_name = $2', [tenant, branch.ref])).rowCount,
    0,
  )
})

test('verify reports tree hash drift as a finding without throwing', async () => {
  const fs = createTuddoFs({ pool, grants, now: () => now })
  const branch = await fs.fork({
    tenant,
    mount,
    sessionId: 'verify-tree',
    authorUser: actor,
  })
  assert.ok(branch)
  const tree = await pool.query<{ id: string }>(`SELECT c.tree_id::text AS id FROM tuddo_commits c WHERE c.id = $1`, [
    branch.commitId.toString(),
  ])
  await pool.query("UPDATE tuddo_trees SET tree_sha = repeat('0', 64) WHERE id = $1", [tree.rows[0]?.id])

  const report = await fs.verify({ tenant })
  assert.ok(report.findings.some(finding => finding.kind === 'tree-hash-drift'))
})

test('verify reports heads drift as a finding without throwing', async () => {
  const fs = createTuddoFs({ pool, grants, now: () => now })
  const branch = await fs.fork({
    tenant,
    mount,
    sessionId: 'verify-heads',
    authorUser: actor,
  })
  assert.ok(branch)
  await fs.write({
    tenant,
    mount,
    ref: branch.ref,
    path: '/heads.txt',
    bytes: 'heads',
    authorUser: actor,
  })
  await pool.query('DELETE FROM tuddo_heads WHERE tenant = $1 AND ref_name = $2 AND path = $3', [
    tenant,
    branch.ref,
    '/heads.txt',
  ])

  const report = await fs.verify({ tenant })
  assert.ok(report.findings.some(finding => finding.kind === 'heads-drift'))
})
test('verify includes actual values for unexpected heads drift', async () => {
  const fs = createTuddoFs({ pool, grants, now: () => now })
  const branch = await fs.fork({
    tenant,
    mount,
    sessionId: 'verify-unexpected-head',
    authorUser: actor,
  })
  assert.ok(branch)
  const write = await fs.write({
    tenant,
    mount,
    ref: branch.ref,
    path: '/expected',
    bytes: 'expected',
    authorUser: actor,
  })
  const blob = await pool.query<{ id: string; size_bytes: string }>(
    'SELECT id::text, size_bytes::text FROM tuddo_blobs WHERE tenant = $1 AND sha256 = $2',
    [tenant, write.sha256],
  )
  await pool.query(
    `INSERT INTO tuddo_heads (tenant, ref_name, path, blob_id, sha256, size_bytes)
     VALUES ($1, $2, '/unexpected', $3::bigint, $4, $5::bigint)`,
    [tenant, branch.ref, blob.rows[0]?.id, write.sha256, blob.rows[0]?.size_bytes],
  )
  const report = await fs.verify({ tenant })
  const finding = report.findings.find(
    candidate => candidate.kind === 'heads-drift' && candidate.issue === 'unexpected',
  )
  assert.deepEqual(finding && 'actual' in finding ? finding.actual : undefined, {
    blobId: blob.rows[0]?.id,
    sha256: write.sha256,
    sizeBytes: blob.rows[0]?.size_bytes,
  })
})

test('verify reports missing CAS storage as a finding without throwing', async () => {
  const storage = new MemoryStore()
  const fs = createTuddoFs({
    pool,
    grants,
    storage,
    inlineMaxBytes: 1,
    now: () => now,
  })
  const branch = await fs.fork({
    tenant,
    mount,
    sessionId: 'verify-storage',
    authorUser: actor,
  })
  assert.ok(branch)
  const write = await fs.write({
    tenant,
    mount,
    ref: branch.ref,
    path: '/storage.bin',
    bytes: 'large',
    authorUser: actor,
  })
  storage.objects.delete(`tuddo/${tenant}/${write.sha256}`)

  const report = await fs.verify({ tenant })
  assert.ok(report.findings.some(finding => finding.kind === 'storage-missing'))
})

test('verify reports dangling parent ids as a finding without throwing', async () => {
  const fs = createTuddoFs({ pool, grants, now: () => now })
  const branch = await fs.fork({
    tenant,
    mount,
    sessionId: 'verify-parent',
    authorUser: actor,
  })
  assert.ok(branch)
  await pool.query('UPDATE tuddo_commits SET parents = ARRAY[987654321::bigint] WHERE id = $1', [
    branch.commitId.toString(),
  ])

  const report = await fs.verify({ tenant })
  assert.ok(report.findings.some(finding => finding.kind === 'dangling-parent'))
})

test('verify reports orphaned heads rows as a finding', async () => {
  const fs = createTuddoFs({ pool, grants, now: () => now })
  await pool.query(
    `INSERT INTO tuddo_heads (tenant, ref_name, path, blob_id, sha256, size_bytes)
     VALUES ($1, 'missing-ref', '/orphan', 1, repeat('0', 64), 1)`,
    [tenant],
  )
  const report = await fs.verify({ tenant })
  assert.ok(report.findings.some(finding => finding.kind === 'orphaned-head'))
})
