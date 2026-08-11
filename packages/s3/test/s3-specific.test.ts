import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { Readable } from 'node:stream'
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

  test('S3 presigned PUT rejects wrong bytes and accepts the signed checksum', async () => {
    const store = new S3BlobStore({
      bucket,
      endpoint,
      region,
      forcePathStyle: process.env.TUDDOFS_S3_FORCE_PATH_STYLE !== 'false',
      credentials: { accessKeyId, secretAccessKey },
    })

    try {
      const key = `tuddo/specific-checksum-${process.pid}-${Date.now()}`
      const expected = Buffer.from('signed checksum body')
      const checksum = createHash('sha256').update(expected).digest('base64')
      const url = await store.presignPut(key, {
        ttlSeconds: 300,
        checksumSha256: checksum,
      })

      const wrongResponse = await fetch(url, {
        method: 'PUT',
        headers: { 'x-amz-checksum-sha256': checksum },
        body: 'wrong bytes',
      })
      assert.notEqual(wrongResponse.status, 200)

      const rightResponse = await fetch(url, {
        method: 'PUT',
        headers: { 'x-amz-checksum-sha256': checksum },
        body: expected,
      })
      assert.equal(rightResponse.status, 200)
      assert.deepEqual(await collect(await store.get(key)), expected)
    } finally {
      store.destroy()
    }
  })
  test('S3 presigned GET returns the stored object', async () => {
    const store = new S3BlobStore({
      bucket,
      endpoint,
      region,
      forcePathStyle: process.env.TUDDOFS_S3_FORCE_PATH_STYLE !== 'false',
      credentials: { accessKeyId, secretAccessKey },
    })

    try {
      const key = `tuddo/specific-get-${process.pid}-${Date.now()}`
      const bytes = Buffer.from('presigned response')
      await store.put(key, bytes)

      const response = await fetch(await store.presignGet(key, { ttlSeconds: 300 }))

      assert.equal(response.status, 200)
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes)
    } finally {
      store.destroy()
    }
  })
}

async function collect(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Uint8Array))
  return Buffer.concat(chunks)
}
