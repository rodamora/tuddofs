import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'

import { S3BlobStore } from '../src/index.js'

const endpoint = process.env.TUDDOFS_S3_ENDPOINT
const bucket = process.env.TUDDOFS_S3_BUCKET ?? 'tuddofs'
const region = process.env.TUDDOFS_S3_REGION ?? 'us-east-1'
const accessKeyId = process.env.TUDDOFS_S3_ACCESS_KEY_ID ?? 'minioadmin'
const secretAccessKey = process.env.TUDDOFS_S3_SECRET_ACCESS_KEY ?? 'minioadmin'

if (!endpoint) {
  test.skip('S3-specific presigning checks require TUDDOFS_S3_ENDPOINT', {
    skip: 'set TUDDOFS_S3_ENDPOINT to a reachable S3-compatible test service',
  })
} else {
  test('S3 presigned PUT signs x-amz-checksum-sha256', async () => {
    const store = new S3BlobStore({
      bucket,
      endpoint,
      region,
      forcePathStyle: process.env.TUDDOFS_S3_FORCE_PATH_STYLE !== 'false',
      credentials: { accessKeyId, secretAccessKey },
    })

    try {
      const bytes = Buffer.from('signed checksum')
      const checksum = createHash('sha256').update(bytes).digest('base64')
      const url = await store.presignPut(`tuddo/specific-${process.pid}`, {
        ttlSeconds: 300,
        checksumSha256: checksum,
      })

      assert.match(new URL(url).searchParams.get('X-Amz-SignedHeaders') ?? '', /(?:^|;)x-amz-checksum-sha256(?:;|$)/)
    } finally {
      store.destroy()
    }
  })
}
