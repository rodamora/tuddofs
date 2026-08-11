# @tuddofs/s3

`@tuddofs/s3` is the reference implementation of the structural `BlobStore` SPI from `tuddofs` architecture §8.4. It implements `put`, `head`, `get`, `delete`, `list`, `presignPut`, and `presignGet` against AWS S3-compatible stores, including AWS S3, MinIO, and Cloudflare R2.

The package has no dependency on, and no peer dependency on, `tuddofs` core. Pass the adapter to `createTuddoFs({ storage })` or use it with any structurally compatible BlobStore consumer.

## Install

```bash
npm install @tuddofs/s3
```

## Configure

```ts
import { S3BlobStore } from '@tuddofs/s3'

const storage = new S3BlobStore({
  bucket: process.env.TUDDOFS_S3_BUCKET!,
  region: process.env.TUDDOFS_S3_REGION ?? 'us-east-1',
  endpoint: process.env.TUDDOFS_S3_ENDPOINT,
  forcePathStyle: process.env.TUDDOFS_S3_FORCE_PATH_STYLE === 'true',
  credentials: {
    accessKeyId: process.env.TUDDOFS_S3_ACCESS_KEY_ID!,
    secretAccessKey: process.env.TUDDOFS_S3_SECRET_ACCESS_KEY!,
  },
})
```

Set `forcePathStyle: true` for MinIO and other endpoints that do not expose virtual-hosted bucket DNS. Omit `endpoint` and `forcePathStyle` for AWS S3. R2 uses its account-specific S3 endpoint and credentials.

`presignPut(key, { ttlSeconds, checksumSha256 })` signs `x-amz-checksum-sha256` and requires the caller to send that header with the PUT. The store rejects a body whose SHA-256 does not match the signed checksum.

## Public API

- `StorageError` is thrown when an S3 operation cannot satisfy the `BlobStore` SPI. It exposes `operation`, `key`, and the original backend failure as `cause`.
- `StorageOperation` is the union of operation names carried by `StorageError`: `put`, `head`, `get`, `delete`, `list`, `presignPut`, and `presignGet`.
- `S3BlobStore.destroy()` releases the AWS SDK client created by the adapter. Call it when the store owns its client; it is a no-op for an injected client.

## SigV4 host reachability

Presigned URLs embed the configured endpoint host. Target-direct I/O therefore requires the blob endpoint to be reachable from the target network. A LAN-only MinIO endpoint cannot be used directly by an external target; downgrade large-blob capture to the server-relay path in that case (architecture §8.3).

## BlobStore conformance kit

The `@tuddofs/s3/conformance` export provides `defineBlobStoreConformanceSuite` and its fixture types for any adapter implementing the same BlobStore SPI. The suite checks SPI behavior, including checksum enforcement through a presigned PUT. Adapters whose presigned transport needs request metadata may provide the fixture's generic `request` callback; protocol-specific details stay outside the kit. Set `presignPutChecksumEnforced: false` only when the adapter's declared SPI capability cannot enforce checksums.

## MinIO contract tests

The S3 adapter tests use the reusable kit. Start a disposable MinIO instance, then set the endpoint and run:

```bash
TUDDOFS_S3_ENDPOINT=http://127.0.0.1:59000 \
TUDDOFS_S3_ACCESS_KEY_ID=minioadmin \
TUDDOFS_S3_SECRET_ACCESS_KEY=minioadmin \
npm run test:contract --workspace @tuddofs/s3
```

The suite exercises all seven methods and verifies a presigned PUT with the right checksum succeeds while the same URL rejects mismatched bytes.

## License

MIT. See [LICENSE](./LICENSE).
