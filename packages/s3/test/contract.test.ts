import test from 'node:test'

import { S3BlobStore } from '../src/index.js'
import { defineBlobStoreConformanceSuite } from '../src/conformance.js'
import { ensureBucket } from './bucket.js'

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
      await ensureBucket({
        bucket,
        endpoint,
        region,
        forcePathStyle: process.env.TUDDOFS_S3_FORCE_PATH_STYLE !== 'false',
        credentials: { accessKeyId, secretAccessKey },
      })

      const store = new S3BlobStore({
        bucket,
        endpoint,
        region,
        forcePathStyle: process.env.TUDDOFS_S3_FORCE_PATH_STYLE !== 'false',
        credentials: { accessKeyId, secretAccessKey },
      })
      return {
        store,
        request: (url, init, checksumSha256) => {
          const headers = new Headers(init?.headers)
          headers.set('x-amz-checksum-sha256', checksumSha256)
          return fetch(url, { ...init, headers })
        },
        close: () => store.destroy(),
      }
    },
  })
}
