import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { Readable } from 'node:stream'
import test, { after, before } from 'node:test'

import { CreateBucketCommand, S3Client } from '@aws-sdk/client-s3'

import { S3BlobStore } from '../src/index.js'

const endpoint = process.env.TUDDOFS_S3_ENDPOINT
const bucket = process.env.TUDDOFS_S3_BUCKET ?? 'tuddofs'
const region = process.env.TUDDOFS_S3_REGION ?? 'us-east-1'
const accessKeyId = process.env.TUDDOFS_S3_ACCESS_KEY_ID ?? 'minioadmin'
const secretAccessKey = process.env.TUDDOFS_S3_SECRET_ACCESS_KEY ?? 'minioadmin'
const prefix = `tuddo/conformance-${process.pid}-${Date.now()}/`

if (endpoint) {
  const client = new S3Client({
    endpoint,
    region,
    forcePathStyle: process.env.TUDDOFS_S3_FORCE_PATH_STYLE !== 'false',
    credentials: { accessKeyId, secretAccessKey },
  })
  const store = new S3BlobStore({ client, bucket })

  before(async () => {
    try {
      await client.send(new CreateBucketCommand({ Bucket: bucket }))
    } catch (error) {
      const name = error instanceof Error ? error.name : ''
      if (name !== 'BucketAlreadyOwnedByYou' && name !== 'BucketAlreadyExists') throw error
    }
  })

  after(() => {
    client.destroy()
  })

  test('implements put, head, get, list, and delete', async () => {
    const key = `${prefix}round-trip`
    const bytes = Buffer.from('adapter conformance')

    await store.put(key, bytes)
    assert.deepEqual(await store.head(key), { sizeBytes: bytes.length })
    assert.deepEqual(await collect(await store.get(key)), bytes)
    const listed = await store.list(prefix)
    assert.equal(listed.length, 1)
    assert.equal(listed[0]?.key, key)

    await store.delete(key)
    assert.equal(await store.head(key), null)
  })

  test('presigned PUT signs checksum and rejects mismatched bytes', async () => {
    const key = `${prefix}checksum`
    const expected = Buffer.from('expected bytes')
    const checksum = createHash('sha256').update(expected).digest('base64')
    const url = await store.presignPut(key, { ttlSeconds: 300, checksumSha256: checksum })

    assert.match(new URL(url).searchParams.get('X-Amz-SignedHeaders') ?? '', /(?:^|;)x-amz-checksum-sha256(?:;|$)/)

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
    await store.delete(key)
  })

  test('presigned GET returns the stored object', async () => {
    const key = `${prefix}presigned-get`
    const bytes = Buffer.from('presigned response')
    await store.put(key, bytes)

    const response = await fetch(await store.presignGet(key, { ttlSeconds: 300 }))
    assert.equal(response.status, 200)
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes)

    await store.delete(key)
  })
} else {
  test('MinIO conformance requires TUDDOFS_S3_ENDPOINT', () => {
    assert.ok(true)
  })
}

async function collect(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Uint8Array))
  return Buffer.concat(chunks)
}
