import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import test, { after, before, beforeEach } from 'node:test'
import { Pool } from 'pg'

import { createTuddoFs, migrate, sha256, type BlobStore } from '../index.js'

const pool = new Pool({ connectionString: process.env.TUDDOFS_DATABASE_URL })
const tenant = 'session-streaming'
const actor = { id: 'user-streaming', tenant }

class StreamingStore implements BlobStore {
  readonly objects = new Map<string, Buffer>()
  readonly presigns: string[] = []

  async put(key: string, source: Buffer | Readable): Promise<void> {
    const chunks: Buffer[] = []
    if (Buffer.isBuffer(source)) chunks.push(source)
    else for await (const chunk of source) chunks.push(Buffer.from(chunk as Uint8Array))
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

  async presignPut(key: string, opts: { ttlSeconds: number; checksumSha256: string }): Promise<string> {
    const url = `put://${key}?ttl=${opts.ttlSeconds}&sha256=${opts.checksumSha256}`
    this.presigns.push(url)
    return url
  }

  async presignGet(key: string, opts: { ttlSeconds: number }): Promise<string> {
    const url = `get://${key}?ttl=${opts.ttlSeconds}`
    this.presigns.push(url)
    return url
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
  assert.deepEqual(Buffer.concat(await (async () => {
    const chunks: Buffer[] = []
    for await (const chunk of stream) chunks.push(Buffer.from(chunk as Uint8Array))
    return chunks
  })()), bytes)
})

test('presign pins the requested checksum and serves CAS reads', async () => {
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

  assert.equal(
    await session.presign('project:media:/clip.bin', { method: 'PUT', sha256: result.sha256, ttlSeconds: 30 }),
    `put://tuddo/${tenant}/${result.sha256}?ttl=30&sha256=${result.sha256}`,
  )
  assert.equal(
    await session.presign('project:media:/clip.bin', { method: 'GET', ttlSeconds: 31 }),
    `get://tuddo/${tenant}/${result.sha256}?ttl=31`,
  )
})
