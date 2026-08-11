import assert from 'node:assert/strict'
import test, { after, before, beforeEach } from 'node:test'

import { CreateBucketCommand, S3Client } from '@aws-sdk/client-s3'
import { Pool } from 'pg'

import { S3BlobStore } from '../../packages/s3/src/index.js'
import { createTuddoFs, migrate } from '../index.js'

const endpoint = process.env.TUDDOFS_S3_ENDPOINT
const databaseUrl = process.env.TUDDOFS_DATABASE_URL
const missingEnvironment = [!endpoint && 'TUDDOFS_S3_ENDPOINT', !databaseUrl && 'TUDDOFS_DATABASE_URL'].filter(
  (name): name is string => Boolean(name),
)

if (missingEnvironment.length > 0) {
  test.skip(`S3 core wiring requires ${missingEnvironment.join(' and ')}`, {
    skip: `set ${missingEnvironment.join(' and ')} to run the S3 integration test`,
  })
} else {
  const bucket = process.env.TUDDOFS_S3_BUCKET ?? 'tuddofs'
  const region = process.env.TUDDOFS_S3_REGION ?? 'us-east-1'
  const accessKeyId = process.env.TUDDOFS_S3_ACCESS_KEY_ID ?? 'minioadmin'
  const secretAccessKey = process.env.TUDDOFS_S3_SECRET_ACCESS_KEY ?? 'minioadmin'
  const forcePathStyle = process.env.TUDDOFS_S3_FORCE_PATH_STYLE !== 'false'
  const pool = new Pool({ connectionString: databaseUrl })
  const admin = new S3Client({
    endpoint,
    region,
    forcePathStyle,
    credentials: { accessKeyId, secretAccessKey },
  })
  const storage = new S3BlobStore({
    bucket,
    endpoint,
    region,
    forcePathStyle,
    credentials: { accessKeyId, secretAccessKey },
  })
  const tenant = `s3-wiring-${process.pid}`
  const objectPrefix = `tuddo/${tenant}/`

  before(async () => {
    await migrate(pool)
    try {
      await admin.send(new CreateBucketCommand({ Bucket: bucket }))
    } catch (error) {
      const name = error instanceof Error ? error.name : ''
      if (name !== 'BucketAlreadyOwnedByYou' && name !== 'BucketAlreadyExists') throw error
    }
  })

  beforeEach(async () => {
    await pool.query(
      'TRUNCATE tuddo_heads, tuddo_refs, tuddo_commits, tuddo_tree_entries, tuddo_trees, tuddo_blobs RESTART IDENTITY CASCADE',
    )
  })

  after(async () => {
    try {
      const objects = await storage.list(objectPrefix)
      await Promise.all(objects.map(object => storage.delete(object.key)))
    } finally {
      storage.destroy()
      admin.destroy()
      await pool.end()
    }
  })

  test('core can read a large blob through the injected S3 adapter', async () => {
    const mount = 'project:s3-wiring'
    const fs = createTuddoFs({
      pool,
      storage,
      inlineMaxBytes: 0,
      grants: { resolve: async () => ({ read: true, write: 'direct' as const }) },
    })
    const branch = await fs.fork({
      tenant,
      mount,
      sessionId: `s3-wiring-${Date.now()}`,
      authorUser: 's3-wiring-test',
    })
    assert.ok(branch)

    await fs.write({
      tenant,
      mount,
      ref: branch.ref,
      path: '/adapter.txt',
      bytes: 'S3 wiring works',
      authorUser: 's3-wiring-test',
    })

    const result = await fs.read({
      tenant,
      mount,
      ref: branch.ref,
      path: '/adapter.txt',
      authorUser: 's3-wiring-test',
    })
    assert.equal(result.bytes.toString(), 'S3 wiring works')
  })
}
