import assert from 'node:assert/strict'
import test, { after, before, beforeEach } from 'node:test'

import { Pool } from 'pg'
import {
  BranchSettledError,
  NotFoundError,
  PermissionDeniedError,
  PreconditionFailedError,
  createAgentFs,
  migrate,
} from '../index.js'

const pool = new Pool({ connectionString: process.env.AGENT_FS_DATABASE_URL })
const tenant = 'session-integration'
const actor = { id: 'user-session', tenant }

before(async () => migrate(pool))
beforeEach(async () => {
  await pool.query(
    'TRUNCATE afs_heads, afs_refs, afs_commits, afs_tree_entries, afs_trees, afs_blobs RESTART IDENTITY CASCADE',
  )
})
after(async () => pool.end())

test('session file API writes, edits, lists, globs, stats, deletes, and maps errors', async () => {
  const fs = createAgentFs({ pool, grants: { resolve: async () => ({ read: true, write: 'direct' }) } })
  const session = await fs.open({
    actor,
    sessionId: 'session-api',
    attribution: { runId: 'run-api' },
    mounts: [{ key: 'project:docs' }],
  })

  const created = await session.write('project:docs:/notes.md', 'hello')
  assert.equal(created.sizeBytes, 5n)
  assert.equal(await session.read('project:docs:/notes.md'), 'hello')
  assert.equal((await session.readBytes('project:docs:/notes.md')).toString(), 'hello')
  assert.equal((await session.stat('project:docs:/notes.md')).sha256, created.sha256)
  assert.deepEqual(
    (await session.list('project:docs:/')).map(entry => entry.path),
    ['/notes.md'],
  )
  assert.deepEqual(
    (await session.glob('project:docs:/**/*.md')).map(entry => entry.path),
    ['/notes.md'],
  )

  const edited = await session.edit('project:docs:/notes.md', [{ start: 5, end: 5, text: ' world' }], {
    ifSha: created.sha256,
  })
  assert.equal(await session.read('project:docs:/notes.md'), 'hello world')
  assert.notEqual(edited.commitSha, created.commitSha)
  await assert.rejects(
    session.write('project:docs:/notes.md', 'bad', { ifSha: created.sha256 }),
    PreconditionFailedError,
  )
  assert.ok((await session.history('project:docs:/notes.md')).length >= 2)
  assert.ok((await session.timeline({ runId: 'run-api' })).length >= 2)
  assert.ok((await session.diff(created.commitSha, edited.commitSha)).some(item => item.path === '/notes.md'))

  await session.delete('project:docs:/notes.md')
  await assert.rejects(session.read('project:docs:/notes.md'), NotFoundError)
  await session.write('project:docs:/missing', 'x')
  await session.discard()
  await assert.rejects(session.write('project:docs:/notes.md', 'x'), BranchSettledError)
})

test('session merge skips virtual mounts and is idempotent after completion', async () => {
  const fs = createAgentFs({ pool, grants: { resolve: async () => ({ read: true, write: 'direct' }) } })
  const session = await fs.open({
    actor,
    sessionId: 'session-mixed-merge',
    mounts: [
      { key: 'project:docs' },
      {
        key: 'team:roster',
        virtual: {
          async list() {
            return []
          },
          async read() {
            return null
          },
        },
      },
    ],
  })

  await session.write('project:docs:/notes.md', 'hello')
  const first = await session.merge()
  assert.equal(first['project:docs'], 'merged')
  assert.equal(first['team:roster'], undefined)

  const second = await session.merge()
  assert.deepEqual(second, first)
})
test('ref mount listings use UTF-16 code-unit ordering', async () => {
  const fs = createAgentFs({ pool, grants: { resolve: async () => ({ read: true, write: 'direct' }) } })
  const session = await fs.open({ actor, sessionId: 'session-ref-list-order', mounts: [{ key: 'project:docs' }] })
  await session.write('project:docs:/😀', 'astral')
  await session.write('project:docs:/z', 'letter')

  assert.deepEqual(
    (await session.list('project:docs:/')).map(entry => entry.path),
    ['/z', '/😀'],
  )
})

test('merge with no branch changes does not create an empty commit', async () => {
  const fs = createAgentFs({ pool, grants: { resolve: async () => ({ read: true, write: 'direct' }) } })
  const session = await fs.open({
    actor,
    sessionId: 'session-noop-merge',
    mounts: [{ key: 'project:docs' }],
  })
  const before = await pool.query<{ count: string }>(
    'SELECT count(*)::text AS count FROM afs_commits WHERE tenant = $1',
    [tenant],
  )

  assert.deepEqual(await session.merge(), { 'project:docs': 'merged' })

  const after = await pool.query<{ count: string }>(
    'SELECT count(*)::text AS count FROM afs_commits WHERE tenant = $1',
    [tenant],
  )
  assert.equal(after.rows[0]?.count, before.rows[0]?.count)
})

test('virtual delete is rejected without fabricating an empty file', async () => {
  let writes = 0
  const fs = createAgentFs({ pool, grants: { resolve: async () => ({ read: true, write: 'direct' }) } })
  const session = await fs.open({
    actor,
    sessionId: 'session-virtual-delete',
    mounts: [
      {
        key: 'team:roster',
        virtual: {
          async list() {
            return [{ path: '/alice.md', type: 'file' }]
          },
          async read() {
            return Buffer.from('alice')
          },
          async write() {
            writes += 1
          },
        },
      },
    ],
  })

  await assert.rejects(session.delete('team:roster:/alice.md'), PermissionDeniedError)
  assert.equal(writes, 0)
  assert.equal(await session.read('team:roster:/alice.md'), 'alice')
})

test('timeline exposes commit-sha parents and path deltas including deletes', async () => {
  const fs = createAgentFs({ pool, grants: { resolve: async () => ({ read: true, write: 'direct' }) } })
  const session = await fs.open({
    actor,
    sessionId: 'session-timeline-delta',
    mounts: [{ key: 'project:docs' }],
  })
  await session.write('project:docs:/a.md', 'a')
  const bWrite = await session.write('project:docs:/b.md', 'b')
  await session.delete('project:docs:/a.md')

  const records = await session.timeline()
  const deletion = records.find(record => record.op === 'delete')
  assert.ok(deletion)
  assert.deepEqual(deletion.changedPaths, ['/a.md'])
  assert.equal(deletion.parentShas[0], bWrite.commitSha)
  assert.ok(deletion.parentShas.every(parent => /^[0-9a-f]{64}$/u.test(parent)))
})
test('restore returns a dedicated tree result for created and unchanged restores', async () => {
  const fs = createAgentFs({ pool, grants: { resolve: async () => ({ read: true, write: 'direct' }) } })
  const session = await fs.open({
    actor,
    sessionId: 'session-restore-result',
    mounts: [{ key: 'project:docs' }],
  })
  const created = await session.write('project:docs:/notes.md', 'hello')
  const initial = (await session.timeline()).find(record => record.commitSha !== created.commitSha)
  assert.ok(initial)

  const restored = await session.restore('project:docs', initial.commitSha)
  assert.equal(restored.created, true)
  assert.equal(restored.commitSha.length, 64)
  assert.equal(restored.treeSha.length, 64)
  assert.equal('sha256' in restored, false)

  const unchanged = await session.restore('project:docs', initial.commitSha)
  assert.equal(unchanged.created, false)
  assert.equal(unchanged.treeSha, restored.treeSha)
})

test('virtual glob walks nested handler directories', async () => {
  const fs = createAgentFs({ pool, grants: { resolve: async () => ({ read: true, write: 'direct' }) } })
  const session = await fs.open({
    actor,
    sessionId: 'session-virtual-glob',
    mounts: [
      {
        key: 'team:roster',
        virtual: {
          async list(dir) {
            if (dir === '/') return [{ path: '/nested', type: 'directory' }]
            if (dir === '/nested') return [{ path: '/nested/alice.md', type: 'file', sizeBytes: 5, mode: 420 }]
            return []
          },
          async read() {
            return Buffer.from('alice')
          },
        },
      },
    ],
  })

  assert.deepEqual(
    (await session.glob('team:roster:/**/*.md')).map(entry => entry.path),
    ['/nested/alice.md'],
  )
})
