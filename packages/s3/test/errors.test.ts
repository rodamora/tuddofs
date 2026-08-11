import assert from 'node:assert/strict'
import test from 'node:test'

import type { S3Client } from '@aws-sdk/client-s3'

import { S3BlobStore, StorageError } from '../src/index.js'

function failingClient(error: unknown): S3Client {
  return {
    send: async () => {
      throw error
    },
  } as unknown as S3Client
}

test('put maps backend failures to StorageError and preserves the cause', async () => {
  const cause = new Error('backend unavailable')
  const store = new S3BlobStore({ bucket: 'tuddofs', client: failingClient(cause) })

  await assert.rejects(
    () => store.put('tuddo/error', Buffer.from('bytes')),
    (error: unknown) => {
      assert.ok(error instanceof StorageError)
      assert.equal(error.operation, 'put')
      assert.equal(error.key, 'tuddo/error')
      assert.equal(error.cause, cause)
      return true
    },
  )
})

test('head rejects a successful response without ContentLength', async () => {
  const client = {
    send: async () => ({}),
  } as unknown as S3Client
  const store = new S3BlobStore({ bucket: 'tuddofs', client })

  await assert.rejects(
    () => store.head('tuddo/missing-size'),
    (error: unknown) => {
      assert.ok(error instanceof StorageError)
      assert.equal(error.operation, 'head')
      assert.equal(error.key, 'tuddo/missing-size')
      return true
    },
  )
})
