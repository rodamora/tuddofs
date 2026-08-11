/**
 * Architecture §8.3 acceptance for the sync capture half: a multi-gigabyte file
 * created inside a target workspace lands in the CAS with FLAT server RSS,
 * through the §8.2 presigned path, against real MinIO with real SigV4.
 *
 * `scripts/minio-streaming.test.ts` proves the §8.1 session half. What is
 * different here, and why it needs its own container run:
 * - the bytes are moved by `curl` inside the target, not by this process, so
 *   the only thing the server ever holds is a 64-character sha;
 * - the presigned URL is a genuine SigV4 URL with `&`-joined parameters, going
 *   through the shell quoting §7.4 demands;
 * - MinIO's own checksum enforcement is what rejects a lying target, so the
 *   §8.2 poisoning defence is exercised against the real store rather than a
 *   fake that agrees with us.
 *
 * `TUDDOFS_MINIO_CAPTURE_BYTES` sizes the file; CI runs a smaller one, the spec
 * number is 2 GiB, and the run itself reports which it measured.
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Readable } from 'node:stream'
import test, { after, before } from 'node:test'

import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { Client } from 'minio'
import { Pool } from 'pg'
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers'

import { createTuddoFs, type BlobObject, type BlobStore, type BlobStorePresignedPut } from '../src/index.js'
import { createLocalDirectoryTarget, createSyncEngine, migrate, type SyncEngine } from '../src/internal.js'

const databaseUrl = process.env.TUDDOFS_DATABASE_URL
if (!databaseUrl) throw new Error('TUDDOFS_DATABASE_URL is required; the MinIO suite never skips silently')

const accessKey = 'tuddofs'
const secretKey = 'tuddofs-secret'
const bucket = 'tuddofs-capture'
const MEGABYTE = 1024 ** 2
const totalBytes = positiveIntegerEnv('TUDDOFS_MINIO_CAPTURE_BYTES', 2 * 1024 ** 3)
if (totalBytes % MEGABYTE !== 0) throw new Error('TUDDOFS_MINIO_CAPTURE_BYTES must be a whole number of MiB')
/**
 * The server may hold connection buffers and a scan's worth of paths; what it
 * must never hold is the file. Any growth proportional to `totalBytes` blows
 * straight through this.
 */
const rssCeilingBytes = 384 * MEGABYTE
const thresholdBytes = 8 * MEGABYTE
/** An hour: one exec here writes, or uploads, gigabytes. */
const longExecMs = 3_600_000
const tenant = `minio-capture-${Date.now()}`
const actor = { id: 'minio-capture-user', tenant }
const pool = new Pool({ connectionString: databaseUrl })
const roots: string[] = []

let container: StartedTestContainer | undefined
let minio: Client | undefined
let signingClient: S3Client | undefined
let storage: MinioStore | undefined

class MinioStore implements BlobStore {
  constructor(
    private readonly client: Client,
    private readonly signer: S3Client,
  ) {}

  async put(key: string, source: Buffer | Readable): Promise<void> {
    // The capture path never sends bytes through the server; a streamed put
    // here would mean the §8.2 route was silently bypassed.
    if (!Buffer.isBuffer(source)) throw new Error(`capture suite streamed a put to ${key}`)
    await this.client.putObject(bucket, key, source, source.length)
  }

  async head(key: string): Promise<{ sizeBytes: number } | null> {
    try {
      const info = await this.client.statObject(bucket, key)
      return { sizeBytes: info.size }
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'NotFound') return null
      throw error
    }
  }

  async get(key: string) {
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
      { expiresIn: opts.ttlSeconds, unhoistableHeaders: new Set(['x-amz-checksum-sha256']) },
    )
    return { checksumEnforced: true, url, headers: { 'x-amz-checksum-sha256': opts.checksumSha256 } }
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
  minio = new Client({ endPoint: host, port, useSSL: false, accessKey, secretKey, partSize: 16 * MEGABYTE })
  signingClient = new S3Client({
    endpoint: `http://${host}:${port}`,
    region: 'us-east-1',
    forcePathStyle: true,
    credentials: { accessKeyId: accessKey, secretAccessKey: secretKey },
  })
  storage = new MinioStore(minio, signingClient)
  await migrate(pool)
  await minio.makeBucket(bucket, 'us-east-1')
})

after(async () => {
  try {
    const activeStorage = storage
    if (activeStorage) {
      for (const object of await activeStorage.list('tuddo/')) await activeStorage.delete(object.key)
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
      for (const root of roots) await rm(root, { recursive: true, force: true }).catch(() => undefined)
    }
  }
})

/**
 * One engine over a fresh workspace. `lie` swaps a sha in the scan output, which
 * is the only thing a hostile target actually controls at this seam (§7.3 step 2).
 */
async function openEngine(
  sessionId: string,
  lie?: { readonly from: string; readonly to: string },
): Promise<{ engine: SyncEngine; root: string; failures: Error[] }> {
  assert.ok(storage)
  const root = await mkdtemp(join(tmpdir(), 'tuddofs-minio-capture-'))
  roots.push(root)
  const failures: Error[] = []
  const session = await createTuddoFs({
    pool,
    storage,
    grants: { resolve: () => Promise.resolve({ read: true, write: 'direct' as const }) },
  }).open({ actor, sessionId, attribution: { runId: 'run-minio-capture' }, mounts: [{ key: 'project:media' }] })
  const target = createLocalDirectoryTarget({ root, execTimeoutMs: longExecMs })
  const engine = createSyncEngine({
    session,
    target: lie
      ? {
          async exec(cmd, opts) {
            const result = await target.exec(cmd, opts)
            if (!cmd.includes('sha256sum --zero')) return result
            return { exitCode: result.exitCode, output: result.output.replaceAll(lie.from, lie.to) }
          },
          readFile: path => target.readFile(path),
          writeFile: (path, bytes) => target.writeFile(path, bytes),
          mkdir: path => target.mkdir(path),
        }
      : target,
    root,
    largeBlobs: { transport: 'presigned', thresholdBytes, ttlSeconds: 3_600, uploadTimeoutMs: longExecMs },
    events: { onCaptureFailed: event => failures.push(event.error) },
  })
  await engine.materialize()
  return { engine, root, failures }
}

void test('a multi-gigabyte target file reaches the CAS with flat server RSS', async t => {
  assert.ok(storage)
  // Hashed a mebibyte at a time; materializing `totalBytes` in this process to
  // check the answer would defeat the measurement it is here to support.
  const zeros = Buffer.alloc(MEGABYTE)
  const digest = createHash('sha256')
  for (let written = 0; written < totalBytes; written += MEGABYTE) digest.update(zeros)
  const expected = digest.digest('hex')

  const { engine, root, failures } = await openEngine('minio-capture')
  // Written by the target, entirely outside this process. The scan hashes it
  // there too; the server only ever sees the 64-character claim.
  const created = await engine.exec(
    `dd if=/dev/zero of='project%3Amedia/huge.bin' bs=${MEGABYTE} count=${totalBytes / MEGABYTE} status=none`,
    { timeoutMs: longExecMs },
  )
  assert.equal(created.exitCode, 0, created.output)
  assert.equal((await stat(join(root, 'project%3Amedia', 'huge.bin'))).size, totalBytes)

  const baseline = process.memoryUsage().rss
  let peak = baseline
  // Intentional real-clock sampler: an RSS peak during a transfer this process
  // is not performing cannot be observed by advancing a fake clock.
  const sampler = setInterval(() => {
    peak = Math.max(peak, process.memoryUsage().rss)
  }, 10)
  sampler.unref()
  try {
    await engine.settle()
  } finally {
    clearInterval(sampler)
    peak = Math.max(peak, process.memoryUsage().rss)
  }
  assert.deepEqual(failures, [])

  const blobs = await pool.query<{ sha256: string; size_bytes: string; object_key: string | null }>(
    'SELECT sha256, size_bytes::text, object_key FROM tuddo_blobs WHERE tenant = $1',
    [tenant],
  )
  assert.deepEqual(blobs.rows, [
    { sha256: expected, size_bytes: String(totalBytes), object_key: `tuddo/${tenant}/${expected}` },
  ])
  // The object is in MinIO at the CAS key, whole, and MinIO is what bound those
  // bytes to that sha when it validated the signed checksum header. The
  // enforcing arm uses no quarantine, so that is the only object in the tenant.
  assert.deepEqual(await storage.head(`tuddo/${tenant}/${expected}`), { sizeBytes: totalBytes })
  assert.deepEqual(
    (await storage.list(`tuddo/${tenant}/`)).map(object => object.key),
    [`tuddo/${tenant}/${expected}`],
  )

  const rssGrowthBytes = peak - baseline
  t.diagnostic(
    JSON.stringify({ totalBytes, baselineRssBytes: baseline, peakRssBytes: peak, rssGrowthBytes, rssCeilingBytes }),
  )
  assert.ok(rssGrowthBytes < rssCeilingBytes, `RSS grew by ${rssGrowthBytes} bytes; ceiling is ${rssCeilingBytes}`)
})

void test('MinIO rejects a lying target at the PUT and nothing reaches the CAS', async t => {
  assert.ok(storage)
  const size = thresholdBytes + 4096
  const honest = createHash('sha256').update(Buffer.alloc(size, 'Z')).digest('hex')
  const poisoned = createHash('sha256').update(Buffer.from('bytes MinIO will never see')).digest('hex')

  // Real SigV4 signs the claimed sha into the URL; MinIO is what refuses the
  // body that does not match it (§8.2).
  const { engine, failures } = await openEngine('minio-capture-lying', { from: honest, to: poisoned })
  const created = await engine.exec(`head -c ${size} /dev/zero | tr '\\0' 'Z' > 'project%3Amedia/liar.bin'`)
  assert.equal(created.exitCode, 0, created.output)
  await engine.settle()

  assert.equal(failures.length > 0, true)
  assert.equal(await storage.head(`tuddo/${tenant}/${poisoned}`), null)
  assert.equal(await storage.head(`tuddo/${tenant}/${honest}`), null)
  const rows = await pool.query('SELECT 1 FROM tuddo_blobs WHERE tenant = $1 AND sha256 = ANY($2::text[])', [
    tenant,
    [poisoned, honest],
  ])
  assert.equal(rows.rowCount, 0)
  t.diagnostic(JSON.stringify({ claimedSha: poisoned, actualSha: honest, failure: failures[0]?.message }))
})

function positiveIntegerEnv(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined) return fallback
  const parsed = Number(raw)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive safe integer`)
  return parsed
}
