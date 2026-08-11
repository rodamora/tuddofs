# s3-session-streaming — streaming reads/writes + presign issuance

Status: done (review-fix evidence: `1c26ea3`; 2 GiB/RSS + real-checksum evidence: `../scripts/minio-streaming.test.ts`)
Stage: S3 (independent of the sync engine)
Depends on: — (coordinate surface shape with s1-surface-diet if concurrent)
Spec: `../architecture.md` §8.1, §8.3 (acceptance + SigV4 caveat), §4.5 write invariants

## Goal

Big media moves through the session without transiting server memory: `readStream`, `writeStream` (hash-on-the-fly, quarantine-then-promote), and a `presign(address)` issuance API for client-direct I/O.

## Scope

- `readStream(address)` → `Readable` from `BlobStore.get` for CAS blobs; inline blobs wrap a buffer. Grant check identical to `readBytes`.
- `writeStream(address, source)` → sha256 transform stream while uploading to a quarantine key; on end, server-side copy to `tuddo/<tenant>/<sha>` then the §4.5 tx (upload BEFORE tx, as always). Identity binds to bytes actually stored.
- `presign(address)` → GET presigns for reads; PUT presigns pin `x-amz-checksum-sha256` as a signed header. Requires the store's optional `presignPut`/`presignGet`; absent → typed `StorageError`, never silent fallback.
- These are the FIRST callers of the presign SPI — treat mismatches as SPI design feedback, fix in kernel.ts types.

Non-goals: sync-engine capture path (s3-capture-blobs); multipart upload; changing `inlineMaxBytes` semantics.

## Acceptance

- 2 GB round-trip against MinIO (testcontainer, `forcePathStyle`) through readStream/writeStream with flat server RSS (assert an RSS ceiling in the test).
- Quarantine promotion: a stream whose bytes hash differently than any caller claim never lands on a CAS key.
- Presign contract tests: PUT with wrong bytes rejected by the store; GET streams the object.
- Tier-1 surface additions (§6.2) kept minimal: `readStream`/`writeStream`/`presign` on the session/mount handle, nothing else.
