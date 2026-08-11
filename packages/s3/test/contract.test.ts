import test from 'node:test'

import { CreateBucketCommand, S3Client } from '@aws-sdk/client-s3'

import { S3BlobStore } from '../src/index.js'
import { defineBlobStoreConformanceSuite } from './blob-store-conformance.js'

const endpoint = process.env.TUDDOFS_S3_ENDPOINT
const bucket = process.env.TUDDOFS_S3_BUCKET ?? 'tuddofs'
const region = process.env.TUDDOFS_S3_REGION ?? 'us-east-1'
const accessKeyId = process.env.TUDDOFS_S3_ACCESS_KEY_ID ?? 'minioadmin'
const secretAccessKey = process.env.TUDDOFS_S3_SECRET_ACCESS_KEY ?? 'minioadmin'

if (!endpoint) {
  test.skip('S3 BlobStore conformance requires TUDDOFS_S3_ENDPOINT', {
    skip: 'set TUDDOFS_S3_ENDPOINT to a reachable S3-compatible test service',
  })
} else {
  defineBlobStoreConformanceSuite({
    name: 'S3 BlobStore SPI',
    prefix: `tuddo/conformance-${process.pid}-${Date.now()}/`,
    createStore: async () => {
      const admin = new S3Client({
        endpoint,
        region,
        forcePathStyle: process.env.TUDDOFS_S3_FORCE_PATH_STYLE !== 'false',
        credentials: { accessKeyId, secretAccessKey },
      })
      try {
        try {
          await admin.send(new CreateBucketCommand({ Bucket: bucket }))
        } catch (error) {
          const name = error instanceof Error ? error.name : ''
          if (name !== 'BucketAlreadyOwnedByYou' && name !== 'BucketAlreadyExists') throw error
        }
      } finally {
        admin.destroy()
      }

      const store = new S3BlobStore({
        bucket,
        endpoint,
        region,
        forcePathStyle: process.env.TUDDOFS_S3_FORCE_PATH_STYLE !== 'false',
        credentials: { accessKeyId, secretAccessKey },
      })
      return { store, close: () => store.destroy() }
    },
  })
}
