# s3-s3-adapter — reference BlobStore adapter package

Status: in-progress (red commit: 2c56c71)
Stage: S3 (parallel-safe with everything)
Depends on: —
Spec: `../architecture.md` §8.4, §10 rule 3 (core ships no storage SDK)

## Goal

A separate published package (placeholder name `@tuddofs/s3` — confirm before publish, spec §15.3) implementing the full `BlobStore` SPI — including `list`, `presignPut`, `presignGet` — against S3-compatible stores (AWS, MinIO `forcePathStyle`, R2). The SPI's first complete external implementation is what proves the contract.

## Scope

- Own repo/dir + package.json; depends on the AWS SDK v3 S3 client; peer-depends on nothing from tuddofs core (it implements a structural interface).
- All 5 verbs + the 3 optionals; `presignPut` pins `x-amz-checksum-sha256`.
- Contract test suite runnable against MinIO (testcontainer) — this suite doubles as the SPI conformance kit for anyone writing another adapter.

Non-goals: GCS/Azure adapters; caching; anything in tuddofs core beyond SPI type fixes discovered here (those go through a core PR referencing this task).

## Acceptance

- Conformance suite green against MinIO; presign tests prove checksum enforcement end to end.
- tuddofs integration suite can run with this adapter injected in place of the in-memory test store (one wiring test in core, behind an env flag).
- `npm publish --dry-run` clean; LICENSE + README with the §8.3 SigV4 host-reachability caveat.
