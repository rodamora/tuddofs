import assert from 'node:assert/strict'
import test, { after, before, beforeEach } from 'node:test'

import { Pool } from 'pg'
import { BranchSettledError, NotFoundError, PreconditionFailedError, createAgentFs, migrate } from '../index.js'

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
