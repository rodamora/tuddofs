import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import test, { after, before, beforeEach } from 'node:test'

import { Pool } from 'pg'

import { createAgentFs, migrate, type BlobStore } from '../index.js'

const pool = new Pool({ connectionString: process.env.AGENT_FS_DATABASE_URL })
const tenant = 'gc-verify-tenant'
const mount = 'project:gc'
const actor = 'gc-user'
const now = new Date('2026-08-10T12:00:00.000Z')

class MemoryStore implements BlobStore {
  readonly objects = new Map<string, { bytes: Buffer; lastModified: Date }>()
  listStarted: (() => void) | undefined
  listGate: Promise<void> | undefined

  async put(key: string, bytes: Buffer): Promise<void> {
    this.objects.set(key, { bytes: Buffer.from(bytes), lastModified: new Date(now) })
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
    'TRUNCATE afs_heads, afs_refs, afs_commits, afs_tree_entries, afs_trees, afs_blobs RESTART IDENTITY CASCADE',
  )
})

after(async () => {
  await pool.end()
})

test('gc keeps every commit reachable from refs and tags while collecting unreachable old history', async () => {
  const fs = createAgentFs({ pool, now: () => now })
  const branch = await fs.fork({ tenant, mount, sessionId: 'gc-reachable', authorUser: actor })
  assert.ok(branch)
  await fs.write({ tenant, mount, ref: branch.ref, path: '/reachable.txt', bytes: 'reachable', authorUser: actor })
  await pool.query(
    `INSERT INTO afs_refs (tenant, name, kind, commit_id, state)
     SELECT tenant, 'tag/project:gc/keep', 'tag', commit_id, 'open'
     FROM afs_refs WHERE tenant = $1 AND name = $2`,
    [tenant, branch.ref],
  )
  const unreachable = await pool.query<{ id: string }>(
    `INSERT INTO afs_commits
       (tenant, commit_sha, tree_id, parents, author_user, op, created_at)
     SELECT tenant, repeat('f', 64), tree_id, '{}', $2, 'write', now() - interval '2 days'
     FROM afs_commits WHERE tenant = $1 ORDER BY id LIMIT 1
     RETURNING id::text AS id`,
    [tenant, actor],
  )
  assert.equal(unreachable.rows.length, 1)
  const result = await fs.gc({ tenant, graceMs: 0 })
  assert.equal(result.skipped, false)
  const rows = await pool.query<{ id: string }>(
    'SELECT id::text AS id FROM afs_commits WHERE tenant = $1 ORDER BY id',
    [tenant],
  )
  assert.ok(rows.rows.some(row => row.id === branch.commitId.toString()))
  assert.ok(!rows.rows.some(row => row.id === unreachable.rows[0]?.id))
})

test('gc deletes old orphan uploads under afs tenant prefix but keeps young and foreign keys', async () => {
  const storage = new MemoryStore()
  storage.objects.set(`afs/${tenant}/old-orphan`, {
    bytes: Buffer.from('old'),
    lastModified: new Date('2026-08-08T00:00:00.000Z'),
  })
  storage.objects.set(`afs/${tenant}/young-orphan`, { bytes: Buffer.from('young'), lastModified: now })
  storage.objects.set(`other/${tenant}/must-stay`, {
    bytes: Buffer.from('foreign'),
    lastModified: new Date('2026-08-01T00:00:00.000Z'),
  })
  const fs = createAgentFs({ pool, storage, now: () => now })

  await fs.gc({ tenant, graceMs: 24 * 60 * 60 * 1000 })

  assert.equal(storage.objects.has(`afs/${tenant}/old-orphan`), false)
  assert.equal(storage.objects.has(`afs/${tenant}/young-orphan`), true)
  assert.equal(storage.objects.has(`other/${tenant}/must-stay`), true)
})
test('property suite runs GC inside every DAG iteration and never collects reachable state', async () => {
  const fs = createAgentFs({ pool, now: () => now })
  const paths = ['/a.txt', '/b.txt', '/c.txt']
  for (let iteration = 0; iteration < 12; iteration += 1) {
    const branch = await fs.fork({
      tenant,
      mount,
      sessionId: `property-${iteration}`,
      authorUser: actor,
    })
    assert.ok(branch)
    const path = paths[iteration % paths.length] as string
    const bytes = `property-${iteration}`
    await fs.write({ tenant, mount, ref: branch.ref, path, bytes, authorUser: actor })
    const gcResult = await fs.gc({ tenant, graceMs: 0 })
    assert.equal(gcResult.skipped, false)
    assert.equal((await fs.read({ tenant, ref: branch.ref, path })).bytes.toString(), bytes)
  }
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
  const fs = createAgentFs({ pool, storage, now: () => now })

  const first = fs.gc({ tenant, graceMs: 0 })
  await startedPromise
  const second = await fs.gc({ tenant, graceMs: 0 })
  assert.equal(second.skipped, true)
  release()
  assert.equal((await first).skipped, false)
})

test('gc removes settled branch refs and heads atomically after retention', async () => {
  const fs = createAgentFs({ pool, now: () => now })
  const branch = await fs.fork({ tenant, mount, sessionId: 'gc-settled', authorUser: actor })
  assert.ok(branch)
  await fs.write({ tenant, mount, ref: branch.ref, path: '/settled.txt', bytes: 'settled', authorUser: actor })
  await pool.query(
    `UPDATE afs_refs
     SET state = 'merged', settled_at = now() - interval '8 days'
     WHERE tenant = $1 AND name = $2`,
    [tenant, branch.ref],
  )

  const result = await fs.gc({ tenant, graceMs: 0, settledBranchRetentionMs: 0 })

  assert.equal(result.settledBranches, 1)
  assert.equal(
    (await pool.query('SELECT 1 FROM afs_refs WHERE tenant = $1 AND name = $2', [tenant, branch.ref])).rowCount,
    0,
  )
  assert.equal(
    (await pool.query('SELECT 1 FROM afs_heads WHERE tenant = $1 AND ref_name = $2', [tenant, branch.ref])).rowCount,
    0,
  )
})

test('verify reports tree hash drift as a finding without throwing', async () => {
  const fs = createAgentFs({ pool, now: () => now })
  const branch = await fs.fork({ tenant, mount, sessionId: 'verify-tree', authorUser: actor })
  assert.ok(branch)
  const tree = await pool.query<{ id: string }>(`SELECT c.tree_id::text AS id FROM afs_commits c WHERE c.id = $1`, [
    branch.commitId.toString(),
  ])
  await pool.query("UPDATE afs_trees SET tree_sha = repeat('0', 64) WHERE id = $1", [tree.rows[0]?.id])

  const report = await fs.verify({ tenant })
  assert.ok(report.findings.some(finding => finding.kind === 'tree-hash-drift'))
})

test('verify reports heads drift as a finding without throwing', async () => {
  const fs = createAgentFs({ pool, now: () => now })
  const branch = await fs.fork({ tenant, mount, sessionId: 'verify-heads', authorUser: actor })
  assert.ok(branch)
  await fs.write({ tenant, mount, ref: branch.ref, path: '/heads.txt', bytes: 'heads', authorUser: actor })
  await pool.query('DELETE FROM afs_heads WHERE tenant = $1 AND ref_name = $2 AND path = $3', [
    tenant,
    branch.ref,
    '/heads.txt',
  ])

  const report = await fs.verify({ tenant })
  assert.ok(report.findings.some(finding => finding.kind === 'heads-drift'))
})

test('verify reports missing CAS storage as a finding without throwing', async () => {
  const storage = new MemoryStore()
  const fs = createAgentFs({ pool, storage, inlineMaxBytes: 1, now: () => now })
  const branch = await fs.fork({ tenant, mount, sessionId: 'verify-storage', authorUser: actor })
  assert.ok(branch)
  const write = await fs.write({
    tenant,
    mount,
    ref: branch.ref,
    path: '/storage.bin',
    bytes: 'large',
    authorUser: actor,
  })
  storage.objects.delete(`afs/${tenant}/${write.sha256}`)

  const report = await fs.verify({ tenant })
  assert.ok(report.findings.some(finding => finding.kind === 'storage-missing'))
})

test('verify reports dangling parent ids as a finding without throwing', async () => {
  const fs = createAgentFs({ pool, now: () => now })
  const branch = await fs.fork({ tenant, mount, sessionId: 'verify-parent', authorUser: actor })
  assert.ok(branch)
  await pool.query('UPDATE afs_commits SET parents = ARRAY[987654321::bigint] WHERE id = $1', [
    branch.commitId.toString(),
  ])

  const report = await fs.verify({ tenant })
  assert.ok(report.findings.some(finding => finding.kind === 'dangling-parent'))
})

test('verify reports orphaned heads rows as a finding', async () => {
  const fs = createAgentFs({ pool, now: () => now })
  await pool.query(
    `INSERT INTO afs_heads (tenant, ref_name, path, blob_id, sha256, size_bytes)
     VALUES ($1, 'missing-ref', '/orphan', 1, repeat('0', 64), 1)`,
    [tenant],
  )
  const report = await fs.verify({ tenant })
  assert.ok(report.findings.some(finding => finding.kind === 'orphaned-head'))
})
