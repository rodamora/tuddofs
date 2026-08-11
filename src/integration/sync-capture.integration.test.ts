import assert from 'node:assert/strict'
import test, { after, before, beforeEach } from 'node:test'

import { Pool } from 'pg'
import {
  BranchSettledError,
  InvalidPathError,
  PermissionDeniedError,
  createTuddoFs,
  type CommitEvent,
  type SessionFileSystem,
  type WriteMode,
} from '../index.js'
import { migrate } from '../internal.js'

const pool = new Pool({ connectionString: process.env.TUDDOFS_DATABASE_URL })
const tenant = 'sync-capture-integration'
const actor = { id: 'user-capture', tenant }

let write: WriteMode = 'direct'
const commits: CommitEvent[] = []

before(async () => migrate(pool))
beforeEach(async () => {
  write = 'direct'
  commits.length = 0
  await pool.query(
    'TRUNCATE tuddo_heads, tuddo_refs, tuddo_commits, tuddo_tree_entries, tuddo_trees, tuddo_blobs RESTART IDENTITY CASCADE',
  )
})
after(async () => pool.end())

function createFs() {
  return createTuddoFs({
    pool,
    grants: { resolve: async () => ({ read: true, write }) },
    onCommit: event => {
      commits.push(event)
    },
  })
}

async function openDocs(sessionId: string): Promise<SessionFileSystem> {
  return createFs().open({
    actor,
    sessionId,
    attribution: { runId: 'run-capture' },
    mounts: [{ key: 'project:docs' }],
  })
}

const bytes = (value: string) => ({ bytes: Buffer.from(value) })

/**
 * `onCommit` is queued with `setImmediate`, so assertions have to yield the
 * macrotask queue first. `Promise.withResolvers` is unavailable on Node 20,
 * which this package supports, so the executor form stays.
 */
async function drainCommitEvents(): Promise<void> {
  await new Promise<void>(resolve => setImmediate(resolve))
}

test('sessions enumerate their mounts with kind, pin state, and the live write mode', async () => {
  const session = await createFs().open({
    actor,
    sessionId: 'session-mount-list',
    mounts: [
      { key: 'project:docs' },
      {
        key: 'live:data',
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

  assert.deepEqual(await session.mounts(), [
    { key: 'project:docs', virtual: false, pinned: false, write: 'direct' },
    { key: 'live:data', virtual: true, pinned: false, write: 'none' },
  ])

  write = 'staged'
  assert.equal((await session.mounts())[0]?.write, 'staged')
})

test('capture commits every changed path and deletion of one mount in a single commit', async () => {
  const session = await openDocs('session-capture-batch')
  const docs = session.mount('project:docs')
  await docs.write('/keep.md', 'keep')
  await docs.write('/gone.md', 'gone')
  await drainCommitEvents()
  commits.length = 0

  const captured = await docs.capture({
    writes: [
      { path: '/new.md', ...bytes('new') },
      { path: '/deep/nested file.md', ...bytes('nested') },
      { path: '/keep.md', ...bytes('changed') },
    ],
    deletes: ['/gone.md', '/never-existed.md'],
  })

  assert.equal(captured.created, true)
  assert.deepEqual(captured.changedPaths, ['/deep/nested file.md', '/gone.md', '/keep.md', '/new.md'])
  assert.equal(await docs.read('/new.md'), 'new')
  assert.equal(await docs.read('/keep.md'), 'changed')
  await assert.rejects(docs.read('/gone.md'))

  const history = await session.timeline({ runId: 'run-capture' })
  const capture = history.find(record => record.commitSha === captured.commitSha)
  assert.equal(capture?.op, 'capture')
  await drainCommitEvents()
  assert.deepEqual(
    commits.map(event => event.commitSha),
    [captured.commitSha],
  )
  assert.deepEqual(commits[0]?.changedPaths, captured.changedPaths)
})

test('a capture that changes nothing produces no commit', async () => {
  const session = await openDocs('session-capture-noop')
  const docs = session.mount('project:docs')
  const created = await docs.write('/a.md', 'same')

  const captured = await docs.capture({ writes: [{ path: '/a.md', ...bytes('same') }], deletes: ['/absent.md'] })

  assert.equal(captured.created, false)
  assert.deepEqual(captured.changedPaths, [])
  assert.equal(captured.commitSha, created.commitSha)
  assert.deepEqual(await docs.capture({ writes: [], deletes: [] }), {
    commitSha: created.commitSha,
    changedPaths: [],
    created: false,
  })
})

test('a captured path implying a directory deletes the head file in the same commit', async () => {
  const session = await openDocs('session-capture-coherence')
  const docs = session.mount('project:docs')
  await docs.write('/a', 'file first')
  await docs.write('/other.md', 'untouched')

  const captured = await docs.capture({ writes: [{ path: '/a/x.md', ...bytes('directory now') }], deletes: [] })

  assert.equal(captured.created, true)
  assert.deepEqual(captured.changedPaths, ['/a', '/a/x.md'])
  assert.equal(await docs.read('/a/x.md'), 'directory now')
  await assert.rejects(docs.read('/a'))
  assert.equal(await docs.read('/other.md'), 'untouched')
})

test('a captured file over a head directory deletes every masked descendant in the same commit', async () => {
  const session = await openDocs('session-capture-coherence-reverse')
  const docs = session.mount('project:docs')
  await docs.write('/a/x.md', 'nested')
  await docs.write('/a/y.md', 'nested too')

  const captured = await docs.capture({ writes: [{ path: '/a', ...bytes('file now') }], deletes: [] })

  assert.deepEqual(captured.changedPaths, ['/a', '/a/x.md', '/a/y.md'])
  assert.equal(await docs.read('/a'), 'file now')
  await assert.rejects(docs.read('/a/x.md'))
})

test('a capture batch that is internally incoherent is rejected, never committed', async () => {
  const session = await openDocs('session-capture-hostile')
  const docs = session.mount('project:docs')
  const created = await docs.write('/keep.md', 'keep')

  await assert.rejects(
    docs.capture({
      writes: [
        { path: '/a', ...bytes('file') },
        { path: '/a/x.md', ...bytes('directory') },
      ],
      deletes: [],
    }),
    InvalidPathError,
  )
  assert.equal((await docs.stat('/keep.md')).sha256, created.sha256)
  await assert.rejects(
    docs.capture({ writes: [{ path: 'relative.md', ...bytes('x') }], deletes: [] }),
    InvalidPathError,
  )
  await assert.rejects(docs.capture({ writes: [], deletes: ['../escape'] }), InvalidPathError)
})

test('capture is refused without a live write grant, on pins, on virtual mounts, and after settling', async () => {
  const session = await openDocs('session-capture-grants')
  const docs = session.mount('project:docs')
  await docs.write('/a.md', 'a')

  write = 'none'
  await assert.rejects(docs.capture({ writes: [{ path: '/b.md', ...bytes('b') }], deletes: [] }), PermissionDeniedError)
  write = 'direct'
  assert.deepEqual(
    (await docs.list('/')).map(entry => entry.path),
    ['/a.md'],
  )

  const mixed = await createFs().open({
    actor,
    sessionId: 'session-capture-mixed',
    mounts: [
      { key: 'project:docs', mode: { pin: 'mount/project:docs' } },
      {
        key: 'live:data',
        virtual: {
          async list() {
            return []
          },
          async read() {
            return null
          },
          async write() {},
        },
      },
    ],
  })
  await assert.rejects(
    mixed.mount('project:docs').capture({ writes: [{ path: '/c.md', ...bytes('c') }], deletes: [] }),
    PermissionDeniedError,
  )
  await assert.rejects(
    mixed.mount('live:data').capture({ writes: [{ path: '/c.md', ...bytes('c') }], deletes: [] }),
    PermissionDeniedError,
  )

  await session.discard()
  await assert.rejects(docs.capture({ writes: [{ path: '/d.md', ...bytes('d') }], deletes: [] }), BranchSettledError)
})

test('capture round-trips filenames with spaces, newlines, and astral-plane characters', async () => {
  const session = await openDocs('session-capture-names')
  const docs = session.mount('project:docs')
  const names = ['/two  spaces.md', '/line\nbreak.md', '/astral \u{1F600}.md', '/quote\'and"quote.md']

  const captured = await docs.capture({
    writes: names.map((path, index) => ({ path, ...bytes(`content ${index}`) })),
    deletes: [],
  })

  assert.deepEqual([...captured.changedPaths].sort(), [...names].sort())
  for (const [index, name] of names.entries()) assert.equal(await docs.read(name), `content ${index}`)
})
