import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { Readable } from 'node:stream'
import test, { after, before } from 'node:test'
import { Client } from 'minio'
import { Pool } from 'pg'

import { createTuddoFs, migrate, type BlobStore } from '../src/index.js'

const endpoint = process.env.TUDDOFS_MINIO_ENDPOINT ?? '127.0.0.1'
const port = Number(process.env.TUDDOFS_MINIO_PORT ?? 55774)
const accessKey = process.env.TUDDOFS_MINIO_ACCESS_KEY ?? 'tuddofs'
const secretKey = process.env.TUDDOFS_MINIO_SECRET_KEY ?? 'tuddofs-secret'
const bucket = process.env.TUDDOFS_MINIO_BUCKET ?? 'tuddofs-streaming'
const totalBytes = 2 * 1024 ** 3
const chunkBytes = 1024 ** 2
const tenant = `minio-streaming-${Date.now()}`
const actor = { id: 'minio-streaming-user', tenant }
const pool = new Pool({ connectionString: process.env.TUDDOFS_DATABASE_URL })
const minio = new Client({ endPoint: endpoint, port, useSSL: false, accessKey, secretKey })

class MinioStore implements BlobStore {
  async put(key: string, source: Buffer | Readable): Promise<void> {
    await minio.putObject(bucket, key, source, totalBytes)
  }

  async head(key: string): Promise<{ sizeBytes: number } | null> {
    try {
      const stat = await minio.statObject(bucket, key)
      return { sizeBytes: stat.size }
    } catch {
      return null
    }
  }

  async get(key: string): Promise<Readable> {
    return minio.getObject(bucket, key)
  }

  async delete(key: string): Promise<void> {
    await minio.removeObject(bucket, key)
  }

  async copy(sourceKey: string, destinationKey: string): Promise<void> {
    await minio.copyObject(bucket, destinationKey, `${bucket}/${sourceKey}`)
  }

  async presignPut(key: string, opts: { ttlSeconds: number; checksumSha256: string }): Promise<string> {
    return minio.presignedPutObject(bucket, key, opts.ttlSeconds)
  }

  async presignGet(key: string, opts: { ttlSeconds: number }): Promise<string> {
    return minio.presignedGetObject(bucket, key, opts.ttlSeconds)
  }
}

before(async () => {
  await migrate(pool)
  if (!(await minio.bucketExists(bucket))) await minio.makeBucket(bucket, 'us-east-1')
})
after(async () => {
  await pool.query('DELETE FROM tuddo_refs WHERE tenant = $1', [tenant])
  await pool.query('DELETE FROM tuddo_heads WHERE tenant = $1', [tenant])
  await pool.query('DELETE FROM tuddo_tree_entries WHERE tree_id IN (SELECT id FROM tuddo_trees WHERE tenant = $1)', [
    tenant,
  ])
  await pool.query('DELETE FROM tuddo_commits WHERE tenant = $1', [tenant])
  await pool.query('DELETE FROM tuddo_trees WHERE tenant = $1', [tenant])
  await pool.query('DELETE FROM tuddo_blobs WHERE tenant = $1', [tenant])
  await pool.end()
})

void test('2 GB MinIO round-trip keeps server RSS flat', async () => {
  const storage = new MinioStore()
  const fs = createTuddoFs({
    pool,
    storage,
    grants: { resolve: () => Promise.resolve({ read: true, write: 'direct' }) },
  })
  const session = await fs.open({ actor, sessionId: 'minio-streaming', mounts: [{ key: 'project:media' }] })
  const expected = createHash('sha256')
  let generated = 0
  const source = new Readable({
    read() {
      if (generated >= totalBytes) {
        this.push(null)
        return
      }
      const size = Math.min(chunkBytes, totalBytes - generated)
      const chunk = Buffer.alloc(size, (generated / chunkBytes) % 251)
      expected.update(chunk)
      generated += size
      this.push(chunk)
    },
  })
  const baseline = process.memoryUsage().rss
  let peak = baseline
  const sampleRss = () => {
    peak = Math.max(peak, process.memoryUsage().rss)
  }
  const written = await session.writeStream('project:media:/two-gib.bin', source)
  const downloaded = createHash('sha256')
  let received = 0
  const stream = await session.readStream('project:media:/two-gib.bin')
  for await (const chunk of stream) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array)
    downloaded.update(bytes)
    received += bytes.length
    sampleRss()
  }
  assert.equal(received, totalBytes)
  assert.equal(written.sha256, expected.digest('hex'))
  assert.equal(downloaded.digest('hex'), written.sha256)
  assert.ok(peak - baseline < 384 * 1024 * 1024, `RSS grew by ${peak - baseline} bytes`)
})
