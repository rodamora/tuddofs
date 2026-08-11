# s3-session-streaming — streaming reads/writes + presign issuance

Status: done (review fixes: `1c26ea3`, `a99a9e3`; observed acceptance evidence below)
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

## Verification evidence

Observed 2026-08-11 from this branch with disposable PostgreSQL and the pinned `minio/minio:RELEASE.2024-12-18T13-15-44Z` testcontainer:

- `TUDDOFS_DATABASE_URL=postgresql://tuddofs:tuddofs@127.0.0.1:55435/tuddofs_it npm run test:minio` — 2 tests passed with the default `totalBytes` of 2,147,483,648.
- RSS diagnostic — baseline 177,127,424 bytes; peak 284,024,832; growth 106,897,408; asserted ceiling 402,653,184.
- Real MinIO presign diagnostic — wrong bytes with the signed checksum header returned HTTP 400; correct bytes returned 200; presigned GET returned 200 and the expected bytes.
- `TUDDOFS_DATABASE_URL=postgresql://tuddofs:tuddofs@127.0.0.1:55435/tuddofs_it npm run test:integration` — all 96 tests passed, including all 9 focused streaming regressions.

CI runs the same self-starting testcontainer suite at 268,435,456 bytes as a non-vacuous smoke test; the exact 2 GiB acceptance observation is recorded above.
