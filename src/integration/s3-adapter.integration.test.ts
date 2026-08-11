import assert from 'node:assert/strict'
import test, { after, before, beforeEach } from 'node:test'

import { Pool } from 'pg'

import { S3BlobStore } from '../../packages/s3/src/index.js'
import { createTuddoFs, migrate } from '../index.js'

const endpoint = process.env.TUDDOFS_S3_ENDPOINT

if (endpoint) {
  const pool = new Pool({ connectionString: process.env.TUDDOFS_DATABASE_URL })
  const storage = new S3BlobStore({
    bucket: process.env.TUDDOFS_S3_BUCKET ?? 'tuddofs',
    endpoint,
    region: process.env.TUDDOFS_S3_REGION ?? 'us-east-1',
    forcePathStyle: process.env.TUDDOFS_S3_FORCE_PATH_STYLE !== 'false',
    credentials: {
      accessKeyId: process.env.TUDDOFS_S3_ACCESS_KEY_ID ?? 'minioadmin',
      secretAccessKey: process.env.TUDDOFS_S3_SECRET_ACCESS_KEY ?? 'minioadmin',
    },
  })

  before(async () => {
    await migrate(pool)
  })

  beforeEach(async () => {
    await pool.query(
      'TRUNCATE tuddo_heads, tuddo_refs, tuddo_commits, tuddo_tree_entries, tuddo_trees, tuddo_blobs RESTART IDENTITY CASCADE',
    )
  })

  after(async () => {
    await pool.end()
  })

  test('core can read a large blob through the injected S3 adapter', async () => {
    const tenant = `s3-wiring-${process.pid}`
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
