/**
 * Architecture §8.2: large changed files leave the target for object storage
 * directly, and the CAS entry is bound to the bytes that actually landed.
 *
 * The store here speaks real HTTP behind a real presigned URL, so every test
 * runs the exec line production runs: real `curl`, a URL full of `&`, and a
 * genuine 4xx when the uploaded bytes do not match the signed checksum. §8.3's
 * 2 GB / flat-RSS acceptance lives in `scripts/minio-capture.test.ts`, against
 * MinIO and real SigV4; what is proven here is the decision logic, the
 * poisoning defences, and the threshold boundary.
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import test, { after, before, beforeEach } from 'node:test'

import { Pool } from 'pg'
import {
  StorageError,
  createTuddoFs,
  type BlobObject,
  type BlobStore,
  type BlobStorePresignedPut,
  type SessionFileSystem,
  type WriteMode,
} from '../index.js'
import { createLocalDirectoryTarget, createSyncEngine, migrate, type SyncEngine, type SyncTarget } from '../internal.js'

const pool = new Pool({ connectionString: process.env.TUDDOFS_DATABASE_URL })
const tenant = 'sync-capture-blobs-integration'
const actor = { id: 'user-blobs', tenant }
/** Small enough that a few KB counts as "large"; the byte counts stay CI-cheap. */
const INLINE_MAX_BYTES = 64
const THRESHOLD_BYTES = 1024

const roots: string[] = []
const grants: Record<string, WriteMode> = { 'project:docs': 'direct' }

type FailureEvent = { mountKey?: string; attempt: number; error: Error }

let failures: FailureEvent[] = []
let captures: { mountKey: string; commitSha: string; paths: readonly string[] }[] = []

/**
 * An S3-shaped store with a real endpoint. `enforcing` selects the §8.2 arm:
 * true makes the store reject bytes whose sha differs from the signed checksum
 * header, false makes it a store that cannot verify anything, which is exactly
 * the case the quarantine-and-re-hash path exists for.
 */
class HttpObjectStore implements BlobStore {
  readonly objects = new Map<string, Buffer>()
  enforcing = true
  /** Set false to model a store with no presign capability at all. */
  canPresign = true
  /** Set false to model a non-enforcing store that also cannot presign a plain PUT. */
  canPresignUnverified = true
  presignedKeys: string[] = []
  rejectedPuts = 0
  private base = ''

  attach(base: string): void {
    this.base = base
  }

  async put(key: string, source: Buffer | Readable): Promise<void> {
    if (Buffer.isBuffer(source)) {
      this.objects.set(key, source)
      return
    }
    const chunks: Buffer[] = []
    for await (const chunk of source) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array))
    this.objects.set(key, Buffer.concat(chunks))
  }

  async head(key: string): Promise<{ sizeBytes: number } | null> {
    const object = this.objects.get(key)
    return object ? { sizeBytes: object.length } : null
  }

  async get(key: string): Promise<Readable> {
    const object = this.objects.get(key)
    if (!object) throw new Error(`missing object ${key}`)
    return Readable.from([object])
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key)
  }

  async list(prefix: string): Promise<readonly BlobObject[]> {
    return [...this.objects.keys()]
      .filter(key => key.startsWith(prefix))
      .map(key => ({ key, lastModified: new Date() }))
  }

  async copy(sourceKey: string, destinationKey: string): Promise<void> {
    const object = this.objects.get(sourceKey)
    if (!object) throw new Error(`missing object ${sourceKey}`)
    this.objects.set(destinationKey, object)
  }

  async presignPut(key: string, opts: { ttlSeconds: number; checksumSha256: string }): Promise<BlobStorePresignedPut> {
    if (!this.canPresign) throw new Error('presign unsupported')
    this.presignedKeys.push(key)
    // Two `&`-joined parameters and a `;` inside one of them: unquoted, this
    // URL ends the shell command early and truncates the upload (§7.4).
    const query =
      `X-Amz-Expires=${opts.ttlSeconds}` +
      `&X-Amz-SignedHeaders=${encodeURIComponent('host;x-amz-checksum-sha256')}` +
      `&X-Amz-Signature=deadbeef`
    if (this.enforcing) {
      return {
        checksumEnforced: true,
        url: `${this.base}/o/${encodeURIComponent(key)}?${query}`,
        headers: { 'x-amz-checksum-sha256': opts.checksumSha256 },
      }
    }
    return {
      checksumEnforced: false,
      reason: 'test store cannot enforce upload checksums',
      ...(this.canPresignUnverified
        ? { url: `${this.base}/o/${encodeURIComponent(key)}?X-Amz-Expires=${opts.ttlSeconds}&X-Amz-Signature=beef` }
        : {}),
    }
  }

  async presignGet(key: string, opts: { ttlSeconds: number }): Promise<string> {
    return `${this.base}/o/${encodeURIComponent(key)}?X-Amz-Expires=${opts.ttlSeconds}&X-Amz-Signature=beef`
  }
}

const storage = new HttpObjectStore()
let server: Server | undefined

before(async () => {
  await migrate(pool)
  server = createServer((request, response) => {
    const key = decodeURIComponent((request.url ?? '').split('?')[0]?.replace(/^\/o\//u, '') ?? '')
    if (request.method === 'GET') {
      const object = storage.objects.get(key)
      if (!object) {
        response.writeHead(404).end()
        return
      }
      response.writeHead(200).end(object)
      return
    }
    if (request.method !== 'PUT') {
      response.writeHead(405).end()
      return
    }
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      const body = Buffer.concat(chunks)
      const claimed = request.headers['x-amz-checksum-sha256']
      if (storage.enforcing && claimed !== createHash('sha256').update(body).digest('base64')) {
        storage.rejectedPuts += 1
        response.writeHead(400).end('BadDigest')
        return
      }
      storage.objects.set(key, body)
      response.writeHead(200).end()
    })
  })
  await new Promise<void>(resolve => server?.listen(0, '127.0.0.1', resolve))
  const address = server.address() as AddressInfo
  storage.attach(`http://127.0.0.1:${address.port}`)
})

beforeEach(async () => {
  grants['project:docs'] = 'direct'
  failures = []
  captures = []
  storage.objects.clear()
  storage.enforcing = true
  storage.canPresign = true
  storage.canPresignUnverified = true
  storage.presignedKeys = []
  storage.rejectedPuts = 0
  await pool.query(
    'TRUNCATE tuddo_heads, tuddo_refs, tuddo_commits, tuddo_tree_entries, tuddo_trees, tuddo_blobs RESTART IDENTITY CASCADE',
  )
})

after(async () => {
  await pool.end()
  await new Promise<void>(resolve => {
    if (!server) {
      resolve()
      return
    }
    server.close(() => resolve())
  })
  for (const root of roots) await rm(root, { recursive: true, force: true }).catch(() => undefined)
})

async function openSession(sessionId: string): Promise<SessionFileSystem> {
  return createTuddoFs({
    pool,
    storage,
    inlineMaxBytes: INLINE_MAX_BYTES,
    grants: {
      resolve: async (_actorInput, mount) => ({ read: mount.key in grants, write: grants[mount.key] ?? 'none' }),
    },
  }).open({ actor, sessionId, attribution: { runId: 'run-blobs' }, mounts: [{ key: 'project:docs' }] })
}

/** Records what the engine pulled through server memory and what it lied about. */
type Probe = {
  readFiles: string[]
  execs: string[]
  /** Mirror-relative path → sha the scan will report instead of the real one. */
  scanLies: Record<string, string>
}

function probed(inner: SyncTarget): { target: SyncTarget; probe: Probe } {
  const probe: Probe = { readFiles: [], execs: [], scanLies: {} }
  return {
    probe,
    target: {
      async exec(cmd, opts) {
        probe.execs.push(cmd)
        const result = await inner.exec(cmd, opts)
        if (!cmd.includes('sha256sum --zero') || Object.keys(probe.scanLies).length === 0) return result
        const output = result.output
          .split('\0')
          .map(entry => {
            if (entry.length < 67) return entry
            const lie = probe.scanLies[entry.slice(66)]
            return lie === undefined ? entry : `${lie}  ${entry.slice(66)}`
          })
          .join('\0')
        return { exitCode: result.exitCode, output }
      },
      readFile(path) {
        probe.readFiles.push(path)
        return inner.readFile(path)
      },
      writeFile: (path, bytes) => inner.writeFile(path, bytes),
      mkdir: path => inner.mkdir(path),
    },
  }
}

async function setup(
  sessionId: string,
  transport: 'relay' | 'presigned' = 'presigned',
): Promise<{ session: SessionFileSystem; engine: SyncEngine; probe: Probe; root: string }> {
  const root = await mkdtemp(join(tmpdir(), 'tuddofs-blobs-'))
  roots.push(root)
  const session = await openSession(sessionId)
  const { target, probe } = probed(createLocalDirectoryTarget({ root }))
  const engine = createSyncEngine({
    session,
    target,
    root,
    largeBlobs: { transport, thresholdBytes: THRESHOLD_BYTES, ttlSeconds: 600 },
    events: {
      onCapture: event => captures.push(event),
      onCaptureFailed: event => failures.push(event),
    },
  })
  await engine.materialize()
  return { session, engine, probe, root }
}

/** Deterministic filler so the sha is stable across runs and lies are easy to spot. */
const fill = (bytes: number, character: string) =>
  `head -c ${bytes} /dev/zero | tr '\\0' '${character}' > 'project%3Adocs/`

/** The object key the target's `curl` actually PUT to, read back off the exec line. */
function uploadedKey(probe: Probe): string | undefined {
  const curl = probe.execs.find(cmd => cmd.startsWith('curl '))
  const url = curl?.match(/'(https?:\/\/[^']+)'/u)?.[1]
  return url === undefined ? undefined : decodeURIComponent(new URL(url).pathname.replace(/^\/o\//u, ''))
}

test('a large captured file uploads direct from the target and never through server memory', async () => {
  const { session, engine, probe } = await setup('blobs-direct')

  await engine.exec(`${fill(4096, 'A')}big.bin'`)
  await engine.settle()

  const expected = Buffer.alloc(4096, 'A')
  const sha = createHash('sha256').update(expected).digest('hex')
  assert.deepEqual(await session.mount('project:docs').readBytes('/big.bin'), expected)
  assert.equal(captures.length, 1)
  assert.deepEqual(failures, [])
  // The whole point: the bytes went target → store, so the engine never called
  // readFile for this path (§8.2, §8.3).
  assert.deepEqual(probe.readFiles, [])
  // Enforcing store: the presign named the CAS key itself, no quarantine hop.
  assert.deepEqual(storage.presignedKeys, [`tuddo/${tenant}/${sha}`])
  assert.equal(uploadedKey(probe), `tuddo/${tenant}/${sha}`)
  assert.deepEqual([...storage.objects.keys()], [`tuddo/${tenant}/${sha}`])

  const row = await pool.query<{
    sha256: string
    size_bytes: string
    object_key: string | null
    inline: Buffer | null
  }>('SELECT sha256, size_bytes::text, object_key, inline FROM tuddo_blobs WHERE tenant = $1', [tenant])
  assert.deepEqual(row.rows, [{ sha256: sha, size_bytes: '4096', object_key: `tuddo/${tenant}/${sha}`, inline: null }])
})

test('a lying target cannot poison the CAS: the enforcing store rejects the PUT', async () => {
  const { session, engine, probe } = await setup('blobs-lying-enforced')
  const poisoned = createHash('sha256')
    .update(Buffer.from('the bytes another branch will dedupe against'))
    .digest('hex')
  probe.scanLies['project%3Adocs/big.bin'] = poisoned

  await engine.exec(`${fill(4096, 'B')}big.bin'`)
  await engine.settle()

  assert.equal(captures.length, 0)
  assert.equal(failures.length > 0, true)
  assert.equal(failures[0]?.mountKey, 'project:docs')
  // The store refused the bytes, so no object exists under the claimed sha and
  // no commit references it.
  assert.equal(storage.rejectedPuts > 0, true)
  assert.deepEqual([...storage.objects.keys()], [])
  await assert.rejects(session.mount('project:docs').readBytes('/big.bin'))
})

test('a lying target cannot poison the CAS: the fallback quarantines and discards', async () => {
  storage.enforcing = false
  const { session, engine, probe } = await setup('blobs-lying-quarantine')
  const poisoned = createHash('sha256').update(Buffer.from('bytes that were never uploaded')).digest('hex')
  probe.scanLies['project%3Adocs/big.bin'] = poisoned

  await engine.exec(`${fill(4096, 'C')}big.bin'`)
  await engine.settle()

  assert.equal(captures.length, 0)
  assert.equal(failures.length > 0, true)
  // Existence and size are not verification (§8.2): the upload SUCCEEDED, and
  // the server-side re-hash is what caught it.
  assert.equal(storage.rejectedPuts, 0)
  // The store was asked for the CAS key first and answered "I cannot enforce",
  // so that URL was dropped unused and the target was handed a quarantine key.
  assert.deepEqual(storage.presignedKeys[0], `tuddo/${tenant}/${poisoned}`)
  assert.equal(storage.presignedKeys[1]?.includes('/quarantine/'), true)
  assert.equal(uploadedKey(probe), storage.presignedKeys[1])
  assert.deepEqual([...storage.objects.keys()], [])
  await assert.rejects(session.mount('project:docs').readBytes('/big.bin'))
})

test('a store that cannot enforce checksums promotes honest bytes through quarantine', async () => {
  storage.enforcing = false
  const { session, engine, probe } = await setup('blobs-quarantine-promote')

  await engine.exec(`${fill(4096, 'D')}big.bin'`)
  await engine.settle()

  const expected = Buffer.alloc(4096, 'D')
  const sha = createHash('sha256').update(expected).digest('hex')
  assert.deepEqual(failures, [])
  assert.deepEqual(await session.mount('project:docs').readBytes('/big.bin'), expected)
  assert.deepEqual(probe.readFiles, [])
  assert.deepEqual(storage.presignedKeys[0], `tuddo/${tenant}/${sha}`)
  assert.equal(storage.presignedKeys[1]?.includes('/quarantine/'), true)
  // An unverified PUT URL is never pointed at a CAS key: the target uploads to
  // quarantine and a server-side re-hash is what lets the bytes out (§8.2).
  assert.equal(uploadedKey(probe), storage.presignedKeys[1])
  // Promotion is a server-side copy to the CAS key and the quarantine object is
  // dropped; nothing is left behind for GC to find (§8.1, §8.2).
  assert.deepEqual([...storage.objects.keys()], [`tuddo/${tenant}/${sha}`])
})

test('the threshold boundary decides readFile against the presigned path, in one commit', async () => {
  const { session, engine, probe, root } = await setup('blobs-threshold')

  await engine.exec(
    `${fill(THRESHOLD_BYTES - 1, 'E')}under.bin' && ${fill(THRESHOLD_BYTES, 'F')}at.bin' && ` +
      `${fill(THRESHOLD_BYTES + 1, 'G')}over.bin'`,
  )
  await engine.settle()

  assert.deepEqual(failures, [])
  assert.equal(captures.length, 1)
  assert.deepEqual(captures[0]?.paths, ['/at.bin', '/over.bin', '/under.bin'])
  // Below the threshold the bytes still come back through readFile; at and
  // above it they never touch server memory.
  assert.deepEqual(probe.readFiles, [join(root, 'project%3Adocs', 'under.bin')])
  assert.deepEqual(
    storage.presignedKeys.sort(),
    [Buffer.alloc(THRESHOLD_BYTES, 'F'), Buffer.alloc(THRESHOLD_BYTES + 1, 'G')]
      .map(bytes => `tuddo/${tenant}/${createHash('sha256').update(bytes).digest('hex')}`)
      .sort(),
  )
  const docs = session.mount('project:docs')
  assert.equal((await docs.readBytes('/under.bin')).length, THRESHOLD_BYTES - 1)
  assert.equal((await docs.readBytes('/at.bin')).length, THRESHOLD_BYTES)
  assert.equal((await docs.readBytes('/over.bin')).length, THRESHOLD_BYTES + 1)
  assert.equal((await stat(join(root, 'project%3Adocs', 'at.bin'))).size, THRESHOLD_BYTES)
})

test('the relay transport is the LAN-only downgrade and never presigns', async () => {
  const { session, engine, probe } = await setup('blobs-relay', 'relay')

  await engine.exec(`${fill(4096, 'H')}big.bin'`)
  await engine.settle()

  assert.deepEqual(failures, [])
  assert.equal((await session.mount('project:docs').readBytes('/big.bin')).length, 4096)
  // §8.3: presigned URLs embed the endpoint host, so a target that cannot reach
  // the blob endpoint pulls the bytes through the server instead.
  assert.deepEqual(storage.presignedKeys, [])
  assert.equal(probe.readFiles.length, 1)
})

test('the presigned transport fails loudly instead of relaying behind the host', async () => {
  storage.canPresign = false
  const { session, engine } = await setup('blobs-presign-unavailable')

  await engine.exec(`${fill(4096, 'I')}big.bin'`)
  await engine.settle()

  assert.equal(captures.length, 0)
  assert.equal(failures.length > 0, true)
  await assert.rejects(session.mount('project:docs').readBytes('/big.bin'))
})

test('a non-enforcing store with no unverified presign is refused, not trusted', async () => {
  storage.enforcing = false
  storage.canPresignUnverified = false
  const { engine } = await setup('blobs-no-fallback-url')

  await engine.exec(`${fill(4096, 'J')}big.bin'`)
  await engine.settle()

  assert.equal(captures.length, 0)
  assert.equal(failures[0]?.error instanceof StorageError, true)
})

test('acquire probes the binaries the direct-upload path needs', async () => {
  const { probe } = await setup('blobs-probe')

  assert.equal(probe.execs[0], 'sha256sum --version && find --version && stat --version && curl --version')
})

test('a sha already in the CAS skips the upload entirely', async () => {
  const { session, engine, probe } = await setup('blobs-dedupe')
  const bytes = Buffer.alloc(4096, 'K')
  const sha = createHash('sha256').update(bytes).digest('hex')
  storage.objects.set(`tuddo/${tenant}/${sha}`, bytes)

  await engine.exec(`${fill(4096, 'K')}big.bin'`)
  await engine.settle()

  assert.deepEqual(failures, [])
  assert.deepEqual(await session.mount('project:docs').readBytes('/big.bin'), bytes)
  assert.deepEqual(probe.readFiles, [])
  // HEAD-first idempotency, exactly as the §4.5 write path does: the object is
  // already there, so nothing is presigned and nothing is transferred.
  assert.deepEqual(storage.presignedKeys, [])
  assert.equal(
    probe.execs.some(cmd => cmd.startsWith('curl ')),
    false,
  )
})

test('reconcile takes the same direct path and still commits deletes', async () => {
  const { session, engine, probe } = await setup('blobs-reconcile')

  await engine.exec(`${fill(4096, 'L')}big.bin' && ${fill(4096, 'M')}gone.bin'`)
  await engine.settle()
  await engine.exec("rm 'project%3Adocs/gone.bin'")
  await engine.reconcile()

  assert.deepEqual(failures, [])
  assert.deepEqual(probe.readFiles, [])
  assert.equal((await session.mount('project:docs').readBytes('/big.bin')).length, 4096)
  await assert.rejects(session.mount('project:docs').readBytes('/gone.bin'))
})

test('capture rejects an uploaded write whose object never landed', async () => {
  const session = await openSession('blobs-missing-object')
  const bytes = Buffer.alloc(4096, 'N')

  await assert.rejects(
    session.mount('project:docs').capture({
      writes: [{ path: '/ghost.bin', sha256: createHash('sha256').update(bytes).digest('hex'), sizeBytes: 4096n }],
      deletes: [],
    }),
    StorageError,
  )
  const commits = await pool.query('SELECT id FROM tuddo_commits WHERE tenant = $1 AND op = $2', [tenant, 'capture'])
  assert.equal(commits.rowCount, 0)
})

test('capture rejects an uploaded write whose stored size contradicts the claim', async () => {
  const session = await openSession('blobs-size-lie')
  const bytes = Buffer.alloc(4096, 'O')
  const sha = createHash('sha256').update(bytes).digest('hex')
  storage.objects.set(`tuddo/${tenant}/${sha}`, bytes)

  await assert.rejects(
    session.mount('project:docs').capture({ writes: [{ path: '/x.bin', sha256: sha, sizeBytes: 12n }], deletes: [] }),
    StorageError,
  )
})

test('capture rejects an uploaded write small enough to belong inline', async () => {
  const session = await openSession('blobs-too-small')
  const bytes = Buffer.from('tiny')
  const sha = createHash('sha256').update(bytes).digest('hex')
  storage.objects.set(`tuddo/${tenant}/${sha}`, bytes)

  await assert.rejects(
    session.mount('project:docs').capture({ writes: [{ path: '/x.bin', sha256: sha, sizeBytes: 4n }], deletes: [] }),
    StorageError,
  )
})

test('one capture commit mixes inline bytes with a direct-uploaded blob', async () => {
  const session = await openSession('blobs-mixed')
  const docs = session.mount('project:docs')
  const large = Buffer.alloc(4096, 'P')
  const sha = createHash('sha256').update(large).digest('hex')
  storage.objects.set(`tuddo/${tenant}/${sha}`, large)

  const result = await docs.capture({
    writes: [
      { path: '/small.md', bytes: Buffer.from('small') },
      { path: '/large.bin', sha256: sha, sizeBytes: 4096n },
    ],
    deletes: [],
  })

  assert.equal(result.created, true)
  assert.deepEqual(result.changedPaths, ['/large.bin', '/small.md'])
  assert.equal(await docs.read('/small.md'), 'small')
  assert.deepEqual(await docs.readBytes('/large.bin'), large)
})

test('beginCaptureUpload refuses a mount the actor cannot write', async () => {
  const session = await openSession('blobs-grant')
  grants['project:docs'] = 'none'

  await assert.rejects(
    session.mount('project:docs').beginCaptureUpload({ sha256: 'a'.repeat(64), sizeBytes: 4096n }),
    /Write permission denied/u,
  )
})

test('beginCaptureUpload refuses a sha that is not a lowercase CAS digest', async () => {
  const session = await openSession('blobs-bad-sha')
  const docs = session.mount('project:docs')

  await assert.rejects(docs.beginCaptureUpload({ sha256: 'A'.repeat(64), sizeBytes: 4096n }), StorageError)
  await assert.rejects(docs.beginCaptureUpload({ sha256: 'abc', sizeBytes: 4096n }), StorageError)
  await assert.rejects(docs.beginCaptureUpload({ sha256: 'a'.repeat(64), sizeBytes: 4n }), StorageError)
})
