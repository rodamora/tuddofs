import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import posix from 'node:path/posix'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { Readable } from 'node:stream'
import test, { after, before } from 'node:test'

import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { Client } from 'minio'
import { Pool } from 'pg'
import { GenericContainer, Network, Wait, type StartedNetwork, type StartedTestContainer } from 'testcontainers'

import {
  createSshTarget,
  createSyncEngine,
  createTuddoFs,
  migrate,
  type BlobObject,
  type BlobStore,
  type SyncTarget,
} from '../src/internal.js'

const run = promisify(execFile)
const databaseUrl = process.env.TUDDOFS_DATABASE_URL
if (!databaseUrl) throw new Error('TUDDOFS_DATABASE_URL is required; MinIO hydration never skips silently')

const accessKey = 'tuddofs'
const secretKey = 'tuddofs-secret'
const bucket = 'tuddofs-hydration'
const tenant = `minio-hydration-${Date.now()}`
const actor = { id: 'minio-hydration-user', tenant }
const pool = new Pool({ connectionString: databaseUrl })
const roots: string[] = []
const keyDir = await mkdtemp(posix.join(tmpdir(), 'tuddofs-hydration-key-'))
const sshImageContext = fileURLToPath(new URL('../fixtures/sshd', import.meta.url))

let network: StartedNetwork | undefined
let minioContainer: StartedTestContainer | undefined
let sshContainer: StartedTestContainer | undefined
let minio: Client | undefined
let storage: HydrationStore | undefined

class HydrationStore implements BlobStore {
  readonly getKeys: string[] = []

  constructor(
    private readonly client: Client,
    private readonly signer: S3Client,
  ) {}

  async put(key: string, bytes: Buffer | Readable): Promise<void> {
    if (!Buffer.isBuffer(bytes)) throw new Error('hydration fixture expects buffered puts')
    await this.client.putObject(bucket, key, bytes, bytes.length)
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

  async get(key: string): Promise<Readable> {
    this.getKeys.push(key)
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
      if (typeof name === 'string' && (lastModified instanceof Date || typeof lastModified === 'string'))
        objects.push({ key: name, lastModified })
    }
    return objects
  }

  async presignGet(key: string, opts: { ttlSeconds: number }): Promise<string> {
    return getSignedUrl(this.signer, new GetObjectCommand({ Bucket: bucket, Key: key }), {
      expiresIn: opts.ttlSeconds,
    })
  }
}

before(async () => {
  network = await new Network().start()
  minioContainer = await new GenericContainer('minio/minio:RELEASE.2024-12-18T13-15-44Z')
    .withEnvironment({ MINIO_ROOT_USER: accessKey, MINIO_ROOT_PASSWORD: secretKey })
    .withCommand(['server', '/data'])
    .withNetwork(network)
    .withNetworkAliases('minio')
    .withExposedPorts(9000)
    .withWaitStrategy(Wait.forHttp('/minio/health/live', 9000).forStatusCode(200))
    .start()
  const host = minioContainer.getHost()
  const port = minioContainer.getMappedPort(9000)
  minio = new Client({ endPoint: host, port, useSSL: false, accessKey, secretKey })
  const signer = new S3Client({
    endpoint: 'http://minio:9000',
    region: 'us-east-1',
    forcePathStyle: true,
    credentials: { accessKeyId: accessKey, secretAccessKey: secretKey },
  })
  storage = new HydrationStore(minio, signer)
  await minio.makeBucket(bucket, 'us-east-1')

  const identity = posix.join(keyDir, 'id_ed25519')
  await run('ssh-keygen', ['-t', 'ed25519', '-N', '', '-C', 'tuddofs-hydration', '-f', identity, '-q'])
  const publicKey = await readFile(`${identity}.pub`, 'utf8')
  const image = await GenericContainer.fromDockerfile(sshImageContext)
    .withBuildArgs({ EXTRA_PACKAGES: 'coreutils findutils tar curl' })
    .build(`tuddofs-sshd-hydration-${Date.now()}`, { deleteOnExit: false })
  sshContainer = await image
    .withNetwork(network)
    .withNetworkAliases('sshd')
    .withExposedPorts(22)
    .withCopyContentToContainer([{ content: publicKey, target: '/etc/ssh/authorized_keys/agent', mode: 0o644 }])
    .withWaitStrategy(Wait.forListeningPorts())
    .start()
  await migrate(pool)
})

after(async () => {
  try {
    if (storage) {
      for (const object of await storage.list('tuddo/')) await storage.delete(object.key)
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
    await pool.end()
    await sshContainer?.stop().catch(() => undefined)
    await minioContainer?.stop().catch(() => undefined)
    await network?.stop().catch(() => undefined)
    await rm(keyDir, { recursive: true, force: true })
    for (const root of roots) await rm(root, { recursive: true, force: true })
  }
})

void test('MinIO object hydration uses target-direct GET while inline bytes use the SSH tar relay', async () => {
  assert.ok(minio)
  assert.ok(storage)
  assert.ok(network)
  assert.ok(sshContainer)

  const root = posix.join('/workspace', `hydration-${Date.now()}`)
  roots.push(root)
  const hydratedStorage = storage
  const session = await createTuddoFs({
    pool,
    storage: hydratedStorage,
    inlineMaxBytes: 128,
    grants: { resolve: () => Promise.resolve({ read: true, write: 'direct' as const }) },
  }).open({
    actor,
    sessionId: 'minio-hydration',
    attribution: { runId: 'run-minio-hydration' },
    mounts: [{ key: 'project:docs' }],
  })
  const docs = session.mount('project:docs')
  const inlineBytes = Buffer.from('inline fixture bytes')
  const objectBytes = Buffer.alloc(256 * 1024, 0x5a)
  await docs.write('/inline.txt', inlineBytes)
  await docs.write('/object.bin', objectBytes)
  const objectBatch = Array.from({ length: 200 }, (_, index) => ({
    path: `/object-${String(index).padStart(3, '0')}-${'x'.repeat(128)}.bin`,
    bytes: Buffer.alloc(256, index % 251),
  }))
  for (const object of objectBatch) await docs.write(object.path, object.bytes)
  hydratedStorage.getKeys.length = 0

  const identity = posix.join(keyDir, 'id_ed25519')
  const options = {
    root,
    host: sshContainer.getHost(),
    port: sshContainer.getMappedPort(22),
    user: 'agent',
    identityFile: identity,
    knownHostsFile: posix.join(keyDir, 'known_hosts'),
    strictHostKeyChecking: 'accept-new' as const,
    execTimeoutMs: 120_000,
  }
  const rawTarget = createSshTarget(options)
  const execs: { command: string; stdin?: Buffer }[] = []
  const relayed: string[] = []
  const target: SyncTarget = {
    ...rawTarget,
    async exec(command, execOptions) {
      execs.push({ command, stdin: execOptions?.stdin })
      return rawTarget.exec(command, execOptions)
    },
    async writeFiles(files, writeOptions) {
      relayed.push(...files.map(file => file.path))
      return rawTarget.writeFiles?.(files, writeOptions)
    },
  }

  const engine = createSyncEngine({
    session,
    target,
    root,
    largeBlobs: { transport: 'presigned', ttlSeconds: 600, uploadTimeoutMs: 120_000 },
  })

  await engine.materialize()

  assert.deepEqual(hydratedStorage.getKeys, [])
  assert.deepEqual(relayed, [engine.mirrorPath('project:docs', '/inline.txt')])
  assert.ok(!relayed.includes(engine.mirrorPath('project:docs', '/object.bin')))
  const curl = execs.find(entry => entry.command.includes('curl --parallel'))
  assert.ok(curl)
  assert.match(curl.command, /curl --parallel --fail --create-dirs --config -/)
  assert.ok(!curl.command.includes('http://minio:9000'))
  assert.ok(curl.stdin)
  assert.ok(curl.stdin.byteLength > 128 * 1024)
  assert.ok(curl.stdin.toString('utf8').includes('http://minio:9000'))
})
