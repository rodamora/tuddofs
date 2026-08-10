import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import test, { after, before, beforeEach } from 'node:test'

import { Pool } from 'pg'

import { BranchSettledError, PreconditionFailedError, RefConflictError, createAgentFs, migrate } from '../index.js'

const pool = new Pool({ connectionString: process.env.AGENT_FS_DATABASE_URL })
const tenant = 'integration-tenant'
const mount = 'project:kernel'
const actor = 'user-1'

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

test('migrate is idempotent and creates exactly the frozen afs tables', async () => {
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
    ['afs_blobs', 'afs_commits', 'afs_heads', 'afs_refs', 'afs_tree_entries', 'afs_trees'],
  )
  const columns = await pool.query<{ table_name: string; column_name: string }>(
    `SELECT table_name, column_name
     FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name LIKE 'afs_%'
     ORDER BY table_name, ordinal_position`,
  )
  assert.equal(columns.rows.length, 41)
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
