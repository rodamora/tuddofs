import assert from 'node:assert/strict'
import { mkdtemp, readFile as fsReadFile, rm, writeFile as fsWriteFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import posix from 'node:path/posix'
import test, { after, before, beforeEach } from 'node:test'

import { Pool } from 'pg'

import {
  createLocalDirectoryTarget,
  createSyncEngine,
  createTuddoFs,
  migrate,
  type SessionFileSystem,
  type SyncEngine,
  type SyncTarget,
} from '../internal.js'

const pool = new Pool({ connectionString: process.env.TUDDOFS_DATABASE_URL })
const tenant = 'sync-batch-integration'
const actor = { id: 'user-batch', tenant }
const roots: string[] = []

before(async () => migrate(pool))
beforeEach(async () => {
  await pool.query(
    'TRUNCATE tuddo_heads, tuddo_refs, tuddo_commits, tuddo_tree_entries, tuddo_trees, tuddo_blobs RESTART IDENTITY CASCADE',
  )
})
after(async () => {
  await pool.end()
  for (const root of roots) await rm(root, { recursive: true, force: true })
})

async function openDocs(sessionId: string): Promise<SessionFileSystem> {
  return createTuddoFs({
    pool,
    inlineMaxBytes: Number.MAX_SAFE_INTEGER,
    grants: { resolve: async () => ({ read: true, write: 'direct' as const }) },
  }).open({
    actor,
    sessionId,
    attribution: { runId: 'run-batch' },
    mounts: [{ key: 'project:docs' }],
  })
}

type BatchProbe = {
  readonly execs: string[]
  readonly perFileReads: string[]
  readonly perFileWrites: string[]
  readonly mkdirs: string[]
  readonly batchReads: { paths: readonly string[]; timeoutMs: number | undefined }[]
  readonly batchWrites: { paths: readonly string[]; bytes: number; timeoutMs: number | undefined }[]
  failNextPerFileWrite: boolean
  swallowNextPerFileWrite: boolean
}

function batchTarget(inner: SyncTarget): { target: SyncTarget; probe: BatchProbe } {
  const probe: BatchProbe = {
    execs: [],
    perFileReads: [],
    perFileWrites: [],
    mkdirs: [],
    batchReads: [],
    batchWrites: [],
    failNextPerFileWrite: false,
    swallowNextPerFileWrite: false,
  }
  return {
    probe,
    target: {
      async exec(command, options) {
        probe.execs.push(command)
        return inner.exec(command, options)
      },
      async readFile(path) {
        probe.perFileReads.push(path)
        return inner.readFile(path)
      },
      async writeFile(path, bytes) {
        probe.perFileWrites.push(path)
        if (probe.swallowNextPerFileWrite) {
          probe.swallowNextPerFileWrite = false
          return
        }
        if (probe.failNextPerFileWrite) {
          probe.failNextPerFileWrite = false
          throw new Error('injected per-file write failure')
        }
        return inner.writeFile(path, bytes)
      },
      async mkdir(path) {
        probe.mkdirs.push(path)
        return inner.mkdir(path)
      },
      async writeFiles(files, options) {
        probe.batchWrites.push({
          paths: files.map(file => file.path),
          bytes: files.reduce((total, file) => total + file.bytes.length, 0),
          timeoutMs: options?.timeoutMs,
        })
        for (const file of files) {
          await inner.mkdir(posix.dirname(file.path))
          await inner.writeFile(file.path, file.bytes)
        }
      },
      async readFiles(paths, options) {
        probe.batchReads.push({ paths, timeoutMs: options?.timeoutMs })
        const result = new Map<string, Buffer>()
        for (const path of paths) result.set(path, await inner.readFile(path))
        return result
      },
    },
  }
}

async function setup(sessionId: string): Promise<{
  session: SessionFileSystem
  engine: SyncEngine
  probe: BatchProbe
  root: string
}> {
  const root = await mkdtemp(posix.join(tmpdir(), 'tuddofs-sync-batch-'))
  roots.push(root)
  const session = await openDocs(sessionId)
  const wrapped = batchTarget(createLocalDirectoryTarget({ root }))
  const engine = createSyncEngine({
    session,
    target: wrapped.target,
    root,
    largeBlobs: { uploadTimeoutMs: 12_345 },
  })
  return { session, engine, probe: wrapped.probe, root }
}

test('hydrates and verifies through bounded batch writes without per-file transfer verbs', async () => {
  const { session, engine, probe } = await setup('session-batch-hydrate')
  const docs = session.mount('project:docs')
  const first = Buffer.alloc(17 * 1024 * 1024, 0x61)
  const second = Buffer.alloc(17 * 1024 * 1024, 0x62)
  await docs.write('/deep/first.bin', first)
  await docs.write('/deep/second.bin', second)

  await engine.materialize()

  assert.equal(probe.batchWrites.length, 2)
  assert.deepEqual(probe.batchWrites.map(batch => batch.bytes), [first.length, second.length])
  assert.ok(probe.batchWrites.every(batch => batch.timeoutMs === 12_345))
  assert.equal(probe.perFileWrites.filter(path => path.includes('deep/')).length, 0)
  assert.equal(probe.perFileReads.length, 0)
  assert.equal(probe.batchReads.length, 1)
  assert.deepEqual(
    new Set(probe.batchReads[0]?.paths),
    new Set([engine.mirrorPath('project:docs', '/deep/first.bin'), engine.mirrorPath('project:docs', '/deep/second.bin')]),
  )
  assert.deepEqual(await fsReadFile(engine.mirrorPath('project:docs', '/deep/first.bin')), first)
})

test('capture fetches changed files in one size-steered batch and keeps the stamp formula', async () => {
  const { session, engine, probe } = await setup('session-batch-capture')
  const docs = session.mount('project:docs')
  await docs.write('/a.txt', 'before-a')
  await docs.write('/b.txt', 'before-b')
  await engine.materialize()
  probe.execs.length = 0
  probe.perFileReads.length = 0
  probe.batchReads.length = 0

  await fsWriteFile(engine.mirrorPath('project:docs', '/a.txt'), 'after-a')
  await fsWriteFile(engine.mirrorPath('project:docs', '/b.txt'), 'after-b')
  engine.captureAfterExec()
  await engine.settle()

  assert.equal(probe.batchReads.length, 1)
  assert.equal(probe.perFileReads.length, 0)
  assert.equal(probe.execs.length, 3)
  assert.match(probe.execs[0] ?? '', /sha256sum --zero/)
  assert.match(probe.execs[1] ?? '', /stat --printf/)
  assert.match(probe.execs[2] ?? '', /touch -d/)
  assert.equal(probe.batchReads[0]?.timeoutMs, 12_345)
  assert.deepEqual(
    new Set(probe.batchReads[0]?.paths),
    new Set([engine.mirrorPath('project:docs', '/a.txt'), engine.mirrorPath('project:docs', '/b.txt')]),
  )
  assert.equal(await docs.read('/a.txt'), 'after-a')
  assert.equal(await docs.read('/b.txt'), 'after-b')
})

test('restages dirty and straggler paths through batch writes', async () => {
  const { session, engine, probe } = await setup('session-batch-restage')
  const docs = session.mount('project:docs')
  await docs.write('/a.txt', 'before')
  await engine.materialize()
  const mirror = engine.mirrorPath('project:docs', '/a.txt')

  probe.failNextPerFileWrite = true
  await engine.write('project:docs', '/a.txt', 'after')
  await engine.settle()
  assert.deepEqual(await fsReadFile(mirror), Buffer.from('before'))

  probe.batchWrites.length = 0
  await engine.exec('true')
  await engine.settle()
  assert.equal(probe.batchWrites.length, 1)
  assert.deepEqual(probe.batchWrites[0]?.paths, [mirror])
  assert.equal(probe.perFileWrites.filter(path => path === mirror).length, 1)
  assert.deepEqual(await fsReadFile(mirror), Buffer.from('after'))
})

test('capture-loop straggler restage uses one batch write after a swallowed mirror write', async () => {
  const { session, engine, probe } = await setup('session-batch-straggler')
  const docs = session.mount('project:docs')
  await docs.write('/a.txt', 'before')
  await engine.materialize()
  const mirror = engine.mirrorPath('project:docs', '/a.txt')

  probe.swallowNextPerFileWrite = true
  await engine.write('project:docs', '/a.txt', 'after')
  await engine.settle()
  assert.deepEqual(await fsReadFile(mirror), Buffer.from('before'))

  probe.batchWrites.length = 0
  await engine.reconcile()
  assert.equal(probe.batchWrites.length, 1)
  assert.deepEqual(probe.batchWrites[0]?.paths, [mirror])
  assert.deepEqual(await fsReadFile(mirror), Buffer.from('after'))
})

