import assert from 'node:assert/strict'
import { EventEmitter, once } from 'node:events'
import { Readable } from 'node:stream'
import { setTimeout as delay } from 'node:timers/promises'
import test, { after, before, beforeEach } from 'node:test'
import { Pool } from 'pg'
import { createTuddoFs, migrate, sha256, StorageError, type BlobStore } from '../index.js'

const pool = new Pool({ connectionString: process.env.TUDDOFS_DATABASE_URL })
const tenant = 'session-streaming'
const actor = { id: 'user-streaming', tenant }

class StreamingStore implements BlobStore {
  readonly objects = new Map<string, Buffer>()
  readonly presigns: string[] = []
  activeUpload: Readable | undefined

  async put(key: string, source: Buffer | Readable): Promise<void> {
    const chunks: Buffer[] = []
    if (Buffer.isBuffer(source)) chunks.push(source)
    else {
      this.activeUpload = source
      try {
        for await (const chunk of source) chunks.push(Buffer.from(chunk as Uint8Array))
      } finally {
        this.activeUpload = undefined
      }
    }
    this.objects.set(key, Buffer.concat(chunks))
  }

  async head(key: string): Promise<{ sizeBytes: number } | null> {
    const bytes = this.objects.get(key)
    return bytes ? { sizeBytes: bytes.length } : null
  }

  async get(key: string): Promise<Readable> {
    const bytes = this.objects.get(key)
    if (!bytes) throw new Error(`missing ${key}`)
    return Readable.from([bytes])
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key)
  }

  async copy(sourceKey: string, destinationKey: string): Promise<void> {
    const bytes = this.objects.get(sourceKey)
    if (!bytes) throw new Error(`missing ${sourceKey}`)
    this.objects.set(destinationKey, Buffer.from(bytes))
  }

  async presignPut(
    key: string,
    opts: { ttlSeconds: number; checksumSha256: string },
  ): Promise<
    | {
        checksumEnforced: true
        url: string
        headers: Readonly<Record<'x-amz-checksum-sha256', string>>
      }
    | { checksumEnforced: false; reason: string }
  > {
    const result = {
      checksumEnforced: true as const,
      url: `put://${key}?ttl=${opts.ttlSeconds}&X-Amz-SignedHeaders=host%3Bx-amz-checksum-sha256`,
      headers: { 'x-amz-checksum-sha256': opts.checksumSha256 },
    }
    this.presigns.push(result.url)
    return result
  }

  async presignGet(key: string, opts: { ttlSeconds: number }): Promise<string> {
    const url = `get://${key}?ttl=${opts.ttlSeconds}`
    this.presigns.push(url)
    return url
  }

  async getPresigned(url: string): Promise<Readable> {
    const key = url.slice('get://'.length).split('?')[0]
    return this.get(key)
  }
}

class NonEnforcingStore extends StreamingStore {
  override async presignPut(): Promise<{ checksumEnforced: false; reason: string }> {
    return { checksumEnforced: false, reason: 'backend does not validate uploaded bytes' }
  }
}

class BlockingPromotionStore extends StreamingStore {
  private readonly promotionEvents = new EventEmitter()
  readonly promoted = once(this.promotionEvents, 'promoted').then(() => undefined)

  override async copy(sourceKey: string, destinationKey: string): Promise<void> {
    await super.copy(sourceKey, destinationKey)
    this.promotionEvents.emit('promoted')
    await once(this.promotionEvents, 'release')
  }

  releasePromotion(): void {
    this.promotionEvents.emit('release')
  }

  async list(prefix: string): Promise<readonly { key: string; lastModified: Date }[]> {
    return [...this.objects.keys()]
      .filter(key => key.startsWith(prefix))
      .map(key => ({ key, lastModified: new Date(0) }))
  }
}

before(async () => migrate(pool))
beforeEach(async () => {
  await pool.query(
    'TRUNCATE tuddo_heads, tuddo_refs, tuddo_commits, tuddo_tree_entries, tuddo_trees, tuddo_blobs RESTART IDENTITY CASCADE',
  )
})

after(async () => pool.end())

test('writeStream hashes and promotes without buffering the read path', async () => {
  const storage = new StreamingStore()
  const fs = createTuddoFs({
    pool,
    storage,
    inlineMaxBytes: 4,
    grants: { resolve: async () => ({ read: true, write: 'direct' }) },
  })
  const session = await fs.open({ actor, sessionId: 'stream-roundtrip', mounts: [{ key: 'project:media' }] })
  const bytes = Buffer.from('streamed media')
  const result = await session.writeStream('project:media:/clip.bin', Readable.from([bytes]))

  assert.equal(result.sha256, sha256(bytes))
  assert.deepEqual([...storage.objects.keys()], [`tuddo/${tenant}/${result.sha256}`])
  const stream = await session.readStream('project:media:/clip.bin')
  assert.deepEqual(
    Buffer.concat(
      await (async () => {
        const chunks: Buffer[] = []
        for await (const chunk of stream) chunks.push(Buffer.from(chunk as Uint8Array))
        return chunks
      })(),
    ),
    bytes,
  )
})

test('presign returns the signed checksum header and serves CAS reads', async () => {
  const storage = new StreamingStore()
  const fs = createTuddoFs({
    pool,
    storage,
    inlineMaxBytes: 4,
    grants: { resolve: async () => ({ read: true, write: 'direct' }) },
  })
  const session = await fs.open({ actor, sessionId: 'stream-presign', mounts: [{ key: 'project:media' }] })
  const bytes = Buffer.from('presigned media')
  const result = await session.writeStream('project:media:/clip.bin', Readable.from([bytes]))
  const checksumHeader = Buffer.from(result.sha256, 'hex').toString('base64')

  const put = await session.presign('project:media:/clip.bin', {
    method: 'PUT',
    sha256: result.sha256,
    ttlSeconds: 30,
  })
  assert.deepEqual(put, {
    checksumEnforced: true,
    url: `put://tuddo/${tenant}/${result.sha256}?ttl=30&X-Amz-SignedHeaders=host%3Bx-amz-checksum-sha256`,
    headers: { 'x-amz-checksum-sha256': checksumHeader },
  })

  const getUrl = await session.presign('project:media:/clip.bin', { method: 'GET', ttlSeconds: 31 })
  assert.equal(getUrl, `get://tuddo/${tenant}/${result.sha256}?ttl=31`)
  const downloaded: Buffer[] = []
  for await (const chunk of await storage.getPresigned(getUrl)) downloaded.push(Buffer.from(chunk as Uint8Array))
  assert.deepEqual(Buffer.concat(downloaded), bytes)
})

test('PUT presign fails loudly when the store cannot enforce checksums', async () => {
  const fs = createTuddoFs({
    pool,
    storage: new NonEnforcingStore(),
    grants: { resolve: async () => ({ read: true, write: 'direct' }) },
  })
  const session = await fs.open({ actor, sessionId: 'stream-no-enforcement', mounts: [{ key: 'project:media' }] })

  await assert.rejects(
    session.presign('project:media:/clip.bin', { method: 'PUT', sha256: sha256('expected') }),
    (error: unknown) => error instanceof StorageError && /does not enforce/i.test(error.message),
  )
})

test('PUT presign rejects malformed CAS hashes before calling storage', async () => {
  const storage = new StreamingStore()
  const fs = createTuddoFs({
    pool,
    storage,
    grants: { resolve: async () => ({ read: true, write: 'direct' }) },
  })
  const session = await fs.open({ actor, sessionId: 'stream-invalid-sha', mounts: [{ key: 'project:media' }] })

  await assert.rejects(
    session.presign('project:media:/clip.bin', { method: 'PUT', sha256: '../../not-a-cas-hash' }),
    StorageError,
  )
  assert.deepEqual(storage.presigns, [])
})

test('writeStream propagates source errors instead of hanging', async () => {
  const storage = new StreamingStore()
  const fs = createTuddoFs({
    pool,
    storage,
    grants: { resolve: async () => ({ read: true, write: 'direct' }) },
  })
  const session = await fs.open({ actor, sessionId: 'stream-source-error', mounts: [{ key: 'project:media' }] })
  const sourceError = new Error('source exploded')
  let started = false
  const source = new Readable({
    read() {
      if (started) return
      started = true
      this.push(Buffer.from('partial'))
      queueMicrotask(() => this.destroy(sourceError))
    },
  })
  const settled = session.writeStream('project:media:/clip.bin', source).then(
    () => ({ status: 'fulfilled' as const }),
    (error: unknown) => ({ status: 'rejected' as const, error }),
  )

  // Intentional real timeout: the regression is a promise that never settles, which fake time cannot expose.
  const first = await Promise.race([settled, delay(200).then(() => ({ status: 'timeout' as const }))])
  if (first.status === 'timeout') {
    storage.activeUpload?.destroy(new Error('test cleanup after hung upload'))
    await settled
  }
  assert.equal(first.status, 'rejected')
  if (first.status === 'rejected') {
    assert.ok(first.error instanceof StorageError)
    assert.match(first.error.message, /source exploded/)
  }
  assert.deepEqual([...storage.objects.keys()], [])
})

test('writeStream holds the tenant GC lease through promotion and commit', async () => {
  const storage = new BlockingPromotionStore()
  const fs = createTuddoFs({
    pool,
    storage,
    inlineMaxBytes: 4,
    grants: { resolve: async () => ({ read: true, write: 'direct' }) },
  })
  const session = await fs.open({ actor, sessionId: 'stream-gc-race', mounts: [{ key: 'project:media' }] })
  const bytes = Buffer.from('large streamed media')
  const write = session.writeStream('project:media:/clip.bin', Readable.from([bytes]))

  await storage.promoted
  const gc = await fs.gc({ tenant, graceMs: 0 })
  storage.releasePromotion()
  const result = await write

  assert.equal(gc.skipped, true)
  assert.deepEqual(storage.objects.get(`tuddo/${tenant}/${result.sha256}`), bytes)
})

test('stream capabilities fail with typed storage errors', async () => {
  const storage = new StreamingStore()
  Object.assign(storage, { copy: undefined })
  const fs = createTuddoFs({
    pool,
    storage,
    inlineMaxBytes: 4,
    grants: { resolve: async () => ({ read: true, write: 'direct' }) },
  })
  const session = await fs.open({ actor, sessionId: 'stream-capabilities', mounts: [{ key: 'project:media' }] })

  await assert.rejects(
    session.writeStream('project:media:/clip.bin', Readable.from([Buffer.from('large media')])),
    StorageError,
  )
})

test('small stream writes retain inline storage semantics', async () => {
  const storage = new StreamingStore()
  Object.assign(storage, { copy: undefined })
  const fs = createTuddoFs({
    pool,
    storage,
    inlineMaxBytes: 100,
    grants: { resolve: async () => ({ read: true, write: 'direct' }) },
  })
  const session = await fs.open({ actor, sessionId: 'stream-inline', mounts: [{ key: 'project:media' }] })

  const result = await session.writeStream('project:media:/tiny.txt', Readable.from([Buffer.from('tiny')]))
  assert.equal(result.sizeBytes, 4n)
  assert.deepEqual([...storage.objects.keys()], [])
  assert.equal(await session.read('project:media:/tiny.txt'), 'tiny')
})
