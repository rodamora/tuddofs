import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { Readable } from 'node:stream'
import test, { after, before } from 'node:test'

import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { Client } from 'minio'
import { Pool } from 'pg'
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers'

import {
  createTuddoFs,
  migrate,
  sha256,
  type BlobObject,
  type BlobStore,
  type BlobStorePresignedPut,
} from '../src/index.js'

const databaseUrl = process.env.TUDDOFS_DATABASE_URL
if (!databaseUrl) throw new Error('TUDDOFS_DATABASE_URL is required; the MinIO suite never skips silently')

const accessKey = 'tuddofs'
const secretKey = 'tuddofs-secret'
const bucket = 'tuddofs-streaming'
const totalBytes = positiveIntegerEnv('TUDDOFS_MINIO_STREAM_BYTES', 2 * 1024 ** 3)
const chunkBytes = 1024 ** 2
const rssCeilingBytes = 384 * 1024 ** 2
const tenant = `minio-streaming-${Date.now()}`
const actor = { id: 'minio-streaming-user', tenant }
const pool = new Pool({ connectionString: databaseUrl })

let container: StartedTestContainer | undefined
let minio: Client | undefined
let signingClient: S3Client | undefined
let storage: MinioStore | undefined

class MinioStore implements BlobStore {
  private streamSizeHint: number | undefined

  constructor(
    private readonly client: Client,
    private readonly signer: S3Client,
    streamSizeHint: number,
  ) {
    this.streamSizeHint = streamSizeHint
  }

  async put(key: string, source: Buffer | Readable): Promise<void> {
    const size = Buffer.isBuffer(source) ? source.length : this.streamSizeHint
    this.streamSizeHint = undefined
    await this.client.putObject(bucket, key, source, size)
  }

  async head(key: string): Promise<{ sizeBytes: number } | null> {
    try {
      const stat = await this.client.statObject(bucket, key)
      return { sizeBytes: stat.size }
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'NotFound') return null
      throw error
    }
  }

  async get(key: string): Promise<Readable> {
    return this.client.getObject(bucket, key)
  }

  async delete(key: string): Promise<void> {
    await this.client.removeObject(bucket, key)
  }

  async list(prefix: string): Promise<readonly BlobObject[]> {
    const objects: BlobObject[] = []
    for await (const candidate of this.client.listObjectsV2(bucket, prefix, true) as AsyncIterable<unknown>) {
      if (!candidate || typeof candidate !== 'object') continue
      const { name, lastModified } = candidate as { name?: unknown; lastModified?: unknown }
      if (typeof name === 'string' && (lastModified instanceof Date || typeof lastModified === 'string')) {
        objects.push({ key: name, lastModified })
      }
    }
    return objects
  }

  async copy(sourceKey: string, destinationKey: string): Promise<void> {
    await this.client.copyObject(bucket, destinationKey, `/${bucket}/${sourceKey}`)
  }

  async presignPut(key: string, opts: { ttlSeconds: number; checksumSha256: string }): Promise<BlobStorePresignedPut> {
    const url = await getSignedUrl(
      this.signer,
      new PutObjectCommand({ Bucket: bucket, Key: key, ChecksumSHA256: opts.checksumSha256 }),
      {
        expiresIn: opts.ttlSeconds,
        unhoistableHeaders: new Set(['x-amz-checksum-sha256']),
      },
    )
    return {
      checksumEnforced: true,
      url,
      headers: { 'x-amz-checksum-sha256': opts.checksumSha256 },
    }
  }

  async presignGet(key: string, opts: { ttlSeconds: number }): Promise<string> {
    return this.client.presignedGetObject(bucket, key, opts.ttlSeconds)
  }
}

before(async () => {
  container = await new GenericContainer('minio/minio:RELEASE.2024-12-18T13-15-44Z')
    .withEnvironment({ MINIO_ROOT_USER: accessKey, MINIO_ROOT_PASSWORD: secretKey })
    .withCommand(['server', '/data'])
    .withExposedPorts(9000)
    .withWaitStrategy(Wait.forHttp('/minio/health/live', 9000).forStatusCode(200))
    .start()
  const host = container.getHost()
  const port = container.getMappedPort(9000)
  minio = new Client({
    endPoint: host,
    port,
    useSSL: false,
    accessKey,
    secretKey,
    partSize: 16 * 1024 ** 2,
  })
  signingClient = new S3Client({
    endpoint: `http://${host}:${port}`,
    region: 'us-east-1',
    forcePathStyle: true,
    credentials: { accessKeyId: accessKey, secretAccessKey: secretKey },
  })
  storage = new MinioStore(minio, signingClient, totalBytes)
  await migrate(pool)
  await minio.makeBucket(bucket, 'us-east-1')
})

after(async () => {
  try {
    const activeStorage = storage
    if (activeStorage) {
      const objects = await activeStorage.list('tuddo/')
      await Promise.all(objects.map(object => activeStorage.delete(object.key)))
    }
    await pool.query('DELETE FROM tuddo_heads WHERE tenant = $1', [tenant])
    await pool.query('DELETE FROM tuddo_refs WHERE tenant = $1', [tenant])
    await pool.query('DELETE FROM tuddo_tree_entries WHERE tree_id IN (SELECT id FROM tuddo_trees WHERE tenant = $1)', [
      tenant,
    ])
    await pool.query('DELETE FROM tuddo_commits WHERE tenant = $1', [tenant])
    await pool.query('DELETE FROM tuddo_trees WHERE tenant = $1', [tenant])
    await pool.query('DELETE FROM tuddo_blobs WHERE tenant = $1', [tenant])
  } finally {
    try {
      await pool.end()
    } finally {
      signingClient?.destroy()
      await container?.stop()
    }
  }
})

void test('configured MinIO round-trip keeps server RSS below the fixed ceiling', async t => {
  assert.ok(storage)
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
  // Intentional real-clock sampler: fake time cannot observe native SDK/container RSS peaks during transfer.
  const sampler = setInterval(sampleRss, 10)
  sampler.unref()
  try {
    const written = await session.writeStream('project:media:/configured-size.bin', source)
    const downloaded = createHash('sha256')
    let received = 0
    const stream = await session.readStream('project:media:/configured-size.bin')
    for await (const chunk of stream) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array)
      downloaded.update(bytes)
      received += bytes.length
      sampleRss()
    }
    assert.equal(received, totalBytes)
    assert.equal(written.sha256, expected.digest('hex'))
    assert.equal(downloaded.digest('hex'), written.sha256)
  } finally {
    clearInterval(sampler)
    sampleRss()
  }
  const rssGrowthBytes = peak - baseline
  t.diagnostic(
    JSON.stringify({ totalBytes, baselineRssBytes: baseline, peakRssBytes: peak, rssGrowthBytes, rssCeilingBytes }),
  )
  assert.ok(rssGrowthBytes < rssCeilingBytes, `RSS grew by ${rssGrowthBytes} bytes; ceiling is ${rssCeilingBytes}`)
})

void test('MinIO rejects wrong bytes for the signed checksum header and serves presigned GET', async t => {
  assert.ok(storage)
  const fs = createTuddoFs({
    pool,
    storage,
    inlineMaxBytes: 4,
    grants: { resolve: () => Promise.resolve({ read: true, write: 'direct' }) },
  })
  const session = await fs.open({ actor, sessionId: 'minio-presign', mounts: [{ key: 'project:media' }] })
  const expected = Buffer.from('checksum-bound bytes')
  const put = await session.presign('project:media:/checksum.bin', {
    method: 'PUT',
    sha256: sha256(expected),
    ttlSeconds: 300,
  })
  assert.notEqual(typeof put, 'string')
  if (typeof put === 'string') return

  const wrongResponse = await fetch(put.url, {
    method: 'PUT',
    headers: put.headers,
    body: Buffer.from('wrong bytes'),
  })
  const wrongStatus = wrongResponse.status
  await wrongResponse.arrayBuffer()
  assert.notEqual(wrongStatus, 200)

  const rightResponse = await fetch(put.url, { method: 'PUT', headers: put.headers, body: expected })
  const rightStatus = rightResponse.status
  await rightResponse.arrayBuffer()
  assert.equal(rightStatus, 200)

  await session.writeStream('project:media:/checksum.bin', Readable.from([expected]))
  const get = await session.presign('project:media:/checksum.bin', { method: 'GET', ttlSeconds: 300 })
  assert.equal(typeof get, 'string')
  if (typeof get !== 'string') return
  const getResponse = await fetch(get)
  assert.equal(getResponse.status, 200)
  assert.deepEqual(Buffer.from(await getResponse.arrayBuffer()), expected)
  t.diagnostic(
    JSON.stringify({ wrongPutStatus: wrongStatus, rightPutStatus: rightStatus, getStatus: getResponse.status }),
  )
})

function positiveIntegerEnv(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined) return fallback
  const parsed = Number(raw)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive safe integer`)
  return parsed
}
