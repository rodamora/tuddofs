import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import test, { after, before, beforeEach } from 'node:test'

import { Pool } from 'pg'

import { BranchSettledError, PreconditionFailedError, RefConflictError, createAgentFs, migrate } from '../index.js'

const pool = new Pool({ connectionString: process.env.AGENT_FS_DATABASE_URL })
const tenant = 'integration-tenant'
const mount = 'project:kernel'
const actor = 'user-1'

function deferred<T>() {
  let resolve!: (value?: T | PromiseLike<T>) => void
  const promise = new Promise<T>(resolvePromise => {
    resolve = value => resolvePromise(value as T)
  })
  return { promise, resolve }
}

before(async () => {
  await migrate(pool)
})

beforeEach(async () => {
  await pool.query(
    'TRUNCATE afs_heads, afs_refs, afs_commits, afs_tree_entries, afs_trees, afs_blobs RESTART IDENTITY CASCADE',
  )
})

after(async () => {
  await pool.end()
})

test('migrate is idempotent, records migration 001, and preserves the frozen schema', async () => {
  await migrate(pool)
  await migrate(pool)
  const tables = await pool.query<{ table_name: string }>(
    `SELECT table_name
     FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name LIKE 'afs_%'
     ORDER BY table_name`,
  )
  assert.deepEqual(
    tables.rows.map(row => row.table_name),
    ['afs_blobs', 'afs_commits', 'afs_heads', 'afs_migrations', 'afs_refs', 'afs_tree_entries', 'afs_trees'],
  )
  const columns = await pool.query<{ table_name: string; column_name: string }>(
    `SELECT table_name, column_name
     FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name IN
       ('afs_blobs', 'afs_commits', 'afs_heads', 'afs_refs', 'afs_tree_entries', 'afs_trees')
     ORDER BY table_name, ordinal_position`,
  )
  assert.equal(columns.rows.length, 41)
  const ledger = await pool.query<{ version: number; name: string }>(
    'SELECT version, name FROM afs_migrations ORDER BY version',
  )
  assert.deepEqual(ledger.rows, [{ version: 1, name: 'initial schema' }])
})

test('fork creates genesis, seeds heads, and re-fork is idempotent', async () => {
  const fs = createAgentFs({ pool })
  const first = await fs.fork({ tenant, mount, sessionId: 'session-1', authorUser: actor })
  const second = await fs.fork({ tenant, mount, sessionId: 'session-1', authorUser: actor })
  assert.ok(first)
  assert.ok(second)
  assert.equal(typeof first.commitId, 'bigint')
  assert.equal(typeof first.baseCommitId, 'bigint')

  assert.equal(first.ref, second.ref)
  assert.equal(first.commitId, second.commitId)
  assert.equal(first.baseCommitId, second.baseCommitId)
  assert.equal(first.commitSha, second.commitSha)

  const counts = await pool.query<{ refs: string; commits: string }>(
    `SELECT
       (SELECT count(*) FROM afs_refs WHERE tenant = $1)::text AS refs,
       (SELECT count(*) FROM afs_commits WHERE tenant = $1)::text AS commits`,
    [tenant],
  )
  assert.deepEqual(counts.rows[0], { refs: '2', commits: '1' })
})

test('concurrent first touches adopt one genesis commit', async () => {
  const fs = createAgentFs({ pool })
  const [first, second] = await Promise.all([
    fs.fork({ tenant, mount, sessionId: 'concurrent-a', authorUser: actor }),
    fs.fork({ tenant, mount, sessionId: 'concurrent-b', authorUser: actor }),
  ])
  assert.ok(first)
  assert.ok(second)
  assert.equal(first.commitId, second.commitId)
  const commits = await pool.query<{ count: string }>(
    'SELECT count(*)::text AS count FROM afs_commits WHERE tenant = $1',
    [tenant],
  )
  assert.equal(commits.rows[0]?.count, '1')
})

test('fork seeds existing mount heads idempotently', async () => {
  const fs = createAgentFs({ pool })
  await fs.fork({ tenant, mount, sessionId: 'seed-source', authorUser: actor })
  await fs.write({
    tenant,
    mount,
    ref: `mount/${mount}`,
    path: '/seed.txt',
    bytes: Buffer.from('seed'),
    authorUser: actor,
  })
  const first = await fs.fork({ tenant, mount, sessionId: 'seed-child', authorUser: actor })
  const second = await fs.fork({ tenant, mount, sessionId: 'seed-child', authorUser: actor })
  assert.ok(first)
  assert.ok(second)
  assert.equal((await fs.read({ tenant, mount, ref: first.ref, path: '/seed.txt' })).bytes.toString(), 'seed')
  const heads = await pool.query<{ count: string }>(
    'SELECT count(*)::text AS count FROM afs_heads WHERE tenant = $1 AND ref_name = $2',
    [tenant, first.ref],
  )
  assert.equal(heads.rows[0]?.count, '1')
})
test('re-fork does not reseed heads beyond the existing branch tip', async () => {
  const fs = createAgentFs({ pool })
  const first = await fs.fork({ tenant, mount, sessionId: 're-fork', authorUser: actor })
  assert.ok(first)
  await fs.write({
    tenant,
    mount,
    ref: first.ref,
    path: '/mine.txt',
    bytes: Buffer.from('mine'),
    authorUser: actor,
  })
  await fs.write({
    tenant,
    mount,
    ref: `mount/${mount}`,
    path: '/late.txt',
    bytes: Buffer.from('late'),
    authorUser: actor,
  })
  await fs.fork({ tenant, mount, sessionId: 're-fork', authorUser: actor })

  const heads = await pool.query<{ path: string }>(
    'SELECT path FROM afs_heads WHERE tenant = $1 AND ref_name = $2 ORDER BY path',
    [tenant, first.ref],
  )
  const tipTree = await pool.query<{ path: string }>(
    `SELECT e.path
     FROM afs_refs r
     JOIN afs_commits c ON c.id = r.commit_id
     JOIN afs_tree_entries e ON e.tree_id = c.tree_id
     WHERE r.tenant = $1 AND r.name = $2
     ORDER BY e.path`,
    [tenant, first.ref],
  )
  assert.deepEqual(heads.rows, tipTree.rows)
})

test('first fork seeds heads from the captured tip tree, not live mount heads', async () => {
  const fs = createAgentFs({ pool })
  await fs.fork({ tenant, mount, sessionId: 'seed-source-tree', authorUser: actor })
  await fs.write({
    tenant,
    mount,
    ref: `mount/${mount}`,
    path: '/from-tree.txt',
    bytes: Buffer.from('tree'),
    authorUser: actor,
  })
  await pool.query('DELETE FROM afs_heads WHERE tenant = $1 AND ref_name = $2', [tenant, `mount/${mount}`])

  const child = await fs.fork({ tenant, mount, sessionId: 'seed-tree-child', authorUser: actor })
  assert.ok(child)
  const heads = await pool.query<{ path: string }>(
    'SELECT path FROM afs_heads WHERE tenant = $1 AND ref_name = $2 ORDER BY path',
    [tenant, child.ref],
  )
  assert.deepEqual(heads.rows, [{ path: '/from-tree.txt' }])
})

test('large writes use the injected object store before the transaction', async () => {
  const objects = new Map<string, Buffer>()
  const storage = {
    async put(key: string, bytes: Buffer) {
      objects.set(key, Buffer.from(bytes))
    },
    async head(key: string) {
      const bytes = objects.get(key)
      return bytes ? { sizeBytes: bytes.length } : null
    },
    async get(key: string) {
      return Readable.from([objects.get(key) as Buffer])
    },
    async delete() {},
  }
  const fs = createAgentFs({ pool, storage, inlineMaxBytes: 3 })
  const branch = await fs.fork({ tenant, mount, sessionId: 'large-write', authorUser: actor })
  assert.ok(branch)
  const result = await fs.write({
    tenant,
    mount,
    ref: branch.ref,
    path: '/large.bin',
    bytes: Buffer.from('large'),
    authorUser: actor,
  })
  assert.ok(objects.has(`afs/${tenant}/${result.sha256}`))
  assert.equal((await fs.read({ tenant, mount, ref: branch.ref, path: '/large.bin' })).bytes.toString(), 'large')
})

test('write/read enforces preconditions, same-sha no-op, and settled branches', async () => {
  const fs = createAgentFs({ pool })
  const branch = await fs.fork({ tenant, mount, sessionId: 'session-2', authorUser: actor })
  assert.ok(branch)
  const first = await fs.write({
    tenant,
    mount,
    ref: branch.ref,
    path: '/notes.txt',
    bytes: Buffer.from('one'),
    authorUser: actor,
  })
  assert.equal((await fs.read({ tenant, ref: branch.ref, path: '/notes.txt' })).bytes.toString(), 'one')

  const before = await pool.query<{ commits: string }>(
    'SELECT count(*)::text AS commits FROM afs_commits WHERE tenant = $1',
    [tenant],
  )
  const same = await fs.write({
    tenant,
    mount,
    ref: branch.ref,
    path: '/notes.txt',
    bytes: Buffer.from('one'),
    authorUser: actor,
  })
  const after = await pool.query<{ commits: string }>(
    'SELECT count(*)::text AS commits FROM afs_commits WHERE tenant = $1',
    [tenant],
  )
  assert.equal(same.commitSha, first.commitSha)
  assert.equal(after.rows[0]?.commits, before.rows[0]?.commits)

  await assert.rejects(
    fs.write({
      tenant,
      mount,
      ref: branch.ref,
      path: '/notes.txt',
      bytes: Buffer.from('two'),
      ifSha: '0'.repeat(64),
      authorUser: actor,
    }),
    error => error instanceof PreconditionFailedError,
  )

  await pool.query("UPDATE afs_refs SET state = 'merged', settled_at = now() WHERE tenant = $1 AND name = $2", [
    tenant,
    branch.ref,
  ])
  await assert.rejects(
    fs.write({ tenant, mount, ref: branch.ref, path: '/new.txt', bytes: Buffer.from('x'), authorUser: actor }),
    error => error instanceof BranchSettledError,
  )
})

test('CAS retries and reports RefConflictError after three failed compares', async () => {
  const fs = createAgentFs({ pool, maxCasRetries: 3 })
  const branch = await fs.fork({ tenant, mount, sessionId: 'session-3', authorUser: actor })
  assert.ok(branch)
  const realPool = pool
  let forcedConflicts = 0
  const conflictPool = {
    async connect() {
      const client = await realPool.connect()
      const query = client.query.bind(client)
      return {
        query: async (text: string, values?: readonly unknown[]) => {
          if (text.includes('UPDATE afs_refs SET commit_id') && forcedConflicts < 3) {
            forcedConflicts += 1
            return { rows: [], rowCount: 0 }
          }
          return query(text, values as unknown[])
        },
        release: () => client.release(),
      }
    },
  }
  const conflictFs = createAgentFs({ pool: conflictPool })
  await assert.rejects(
    conflictFs.write({ tenant, mount, ref: branch.ref, path: '/conflict', bytes: Buffer.from('x'), authorUser: actor }),
    error => error instanceof RefConflictError,
  )
  assert.equal(forcedConflicts, 3)
})
test('concurrent writers retry and leave heads equal to the resulting tip tree', async () => {
  const fs = createAgentFs({ pool })
  const branch = await fs.fork({ tenant, mount, sessionId: 'cas-recovery', authorUser: actor })
  assert.ok(branch)

  const results = await Promise.all(
    ['/one.txt', '/two.txt'].map(path =>
      fs.write({ tenant, mount, ref: branch.ref, path, bytes: Buffer.from(path), authorUser: actor }),
    ),
  )
  assert.equal(results.length, 2)
  const state = await pool.query<{ path: string; in_tree: boolean }>(
    `SELECT h.path, (e.path IS NOT NULL) AS in_tree
     FROM afs_heads h
     LEFT JOIN afs_refs r ON r.tenant = h.tenant AND r.name = h.ref_name
     LEFT JOIN afs_commits c ON c.id = r.commit_id
     LEFT JOIN afs_tree_entries e ON e.tree_id = c.tree_id AND e.path = h.path
     WHERE h.tenant = $1 AND h.ref_name = $2
     ORDER BY h.path`,
    [tenant, branch.ref],
  )
  assert.deepEqual(state.rows, [
    { path: '/one.txt', in_tree: true },
    { path: '/two.txt', in_tree: true },
  ])
})

test('onCommit starts only after write cleanup and caller settlement', async () => {
  const unlockCalled = deferred<void>()
  const unlockGate = deferred<void>()
  const hookStarted = deferred<void>()
  const hookGate = deferred<void>()
  const logged = deferred<void>()
  const errors: unknown[] = []
  let writeSettled = false
  let hookStartedBeforeWriteSettled = false
  const realPool = pool
  const gatedPool = {
    async connect() {
      const client = await realPool.connect()
      return {
        query: async <Row extends Record<string, unknown>>(text: string, values?: readonly unknown[]) => {
          if (text.includes('pg_advisory_unlock')) {
            unlockCalled.resolve()
            await unlockGate.promise
          }
          return client.query<Row>(text, values as unknown[])
        },
        release: (error?: Error) => client.release(error),
      }
    },
  }
  const storage = {
    async put() {},
    async head() {
      return null
    },
    async get() {
      return Readable.from([])
    },
    async delete() {},
  }
  const fs = createAgentFs({
    pool: gatedPool,
    storage,
    inlineMaxBytes: 1,
    onCommit: async () => {
      hookStartedBeforeWriteSettled = !writeSettled
      hookStarted.resolve()
      await hookGate.promise
      throw new Error('hook failed')
    },
    logger: {
      error: error => {
        errors.push(error)
        logged.resolve()
      },
    },
  })
  const branch = await fs.fork({ tenant, mount, sessionId: 'hook', authorUser: actor })
  assert.ok(branch)
  const writePromise = fs.write({
    tenant,
    mount,
    ref: branch.ref,
    path: '/hook.txt',
    bytes: Buffer.from('hook'),
    authorUser: actor,
  })
  await unlockCalled.promise
  await new Promise<void>(resolve => setImmediate(resolve))
  await new Promise<void>(resolve => setImmediate(resolve))
  const startedTooSoon = hookStartedBeforeWriteSettled
  unlockGate.resolve()
  await writePromise
  writeSettled = true
  await hookStarted.promise
  hookGate.resolve()
  await logged.promise
  assert.equal(errors.length, 1)
  assert.equal(startedTooSoon, false)
  assert.equal(hookStartedBeforeWriteSettled, false)
})

test('unlock failure destroys the client before the tenant can write again', async () => {
  const storage = {
    async put() {},
    async head() {
      return null
    },
    async get() {
      return Readable.from([])
    },
    async delete() {},
  }
  const backendPids: number[] = []
  const releaseErrors: unknown[] = []
  let failUnlock = true
  const realPool = pool
  const guardedPool = {
    async connect() {
      const client = await realPool.connect()
      const pid = await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')
      backendPids.push(pid.rows[0]?.pid as number)
      return {
        query: async <Row extends Record<string, unknown>>(text: string, values?: readonly unknown[]) => {
          if (text.includes('pg_advisory_unlock') && failUnlock) {
            failUnlock = false
            throw new Error('simulated unlock failure')
          }
          return client.query<Row>(text, values as unknown[])
        },
        release: (error?: Error) => {
          releaseErrors.push(error)
          client.release(error)
        },
      }
    },
  }
  const fs = createAgentFs({ pool: guardedPool, storage, inlineMaxBytes: 1 })
  const branch = await fs.fork({ tenant, mount, sessionId: 'unlock-failure', authorUser: actor })
  assert.ok(branch)
  backendPids.length = 0
  releaseErrors.length = 0
  await fs
    .write({
      tenant,
      mount,
      ref: branch.ref,
      path: '/first.txt',
      bytes: Buffer.from('first'),
      authorUser: actor,
    })
    .catch(() => undefined)
  assert.ok(releaseErrors[0] instanceof Error)
  await fs.write({
    tenant,
    mount,
    ref: branch.ref,
    path: '/second.txt',
    bytes: Buffer.from('second'),
    authorUser: actor,
  })
  assert.notEqual(backendPids[0], backendPids[1])
})

test('read validates a supplied mount key before resolving grants', async () => {
  const seen: string[] = []
  const fs = createAgentFs({
    pool,
    grants: {
      async resolve(_actor, mountRef) {
        seen.push(mountRef.key)
        return { read: true, write: 'direct' }
      },
    },
  })
  await assert.rejects(
    fs.read({ tenant, mount: 'INVALID MOUNT', ref: 'missing', path: '/file' }),
    error => error instanceof Error && error.name === 'InvalidMountKeyError',
  )
  assert.deepEqual(seen, [])
})
