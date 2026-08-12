# s3-capture-blobs — presigned large-blob path in exec capture

Status: done — branch `s3/capture-blobs`, PR #10, rebased onto `7e8a6c1`
Stage: S3
Depends on: s1-sync-core (and s3-session-streaming's presign plumbing if it lands first — reuse, don't duplicate)
Spec: `../architecture.md` §8.2, §8.3, §7.3 Phase 3 step 4

## Goal

Large changed files upload direct from the target to object storage — never through server memory — with the CAS entry provably bound to the stored bytes.

## Scope

- Capture step 4 branch: files over threshold upload via `exec(curl …)` against a presigned PUT with the claimed sha pinned as `x-amz-checksum-sha256` (signed header).
- Non-enforcing-store fallback: quarantine key → server-side re-hash via GET stream → server-side copy to CAS key. Existence+size is NOT verification (§8.2).
- Presigned URLs single-quoted in exec lines (they contain `&` — §7.4).
- Server-relay fallback when the blob endpoint is unreachable from the target network (SigV4 embeds the host — §8.3); selection is a config flag, failure is loud.

Non-goals: changing capture phases or the slot machinery; multipart; retry policy beyond the existing capture re-trigger.

## Acceptance

- 2 GB file created inside a target workspace lands in CAS with flat server RSS, via the presigned path (MinIO testcontainer).
- A lying target (claims sha X, uploads bytes Y) cannot poison CAS: enforcing store rejects at PUT; fallback path quarantines and discards. Both cases tested.
- Small files keep using `readFile` — threshold boundary tested.


## Evidence

`largeBlobs.transport` on `createSyncEngine` selects the route; `relay` (default) is the
§8.3 LAN-only downgrade and keeps the pre-existing `readFile` behaviour.

- 2 GiB `dd` file created by the target, captured through the presigned path against a MinIO
  testcontainer with real SigV4: peak server RSS grew **512 KiB** against a 384 MiB ceiling.
  The §8.1 session-streaming path moves the same 2 GiB through the server for 104 MiB of
  growth, which is the contrast the acceptance is about. `scripts/minio-capture.test.ts`.
- Lying target, enforcing store: MinIO refuses the PUT (curl exit 22), capture fails through
  `onCaptureFailed`, and neither the claimed nor the real sha exists in the store or the CAS.
- Lying target, non-enforcing store: the upload SUCCEEDS into quarantine, the server-side
  re-hash catches it, the object is discarded, and nothing reaches a CAS key. The unverified
  CAS presign the store offered is dropped unused and never handed to the target.
- Threshold boundary: `n-1` bytes goes through `readFile`, `n` and `n+1` go direct, all three
  land in one capture commit.
- A size lie is caught too: `captureBatch` re-HEADs the object inside the tenant GC lock and
  takes the length from the store, so it never reaches the tree.
- Gate on the rebased tree: format:check, lint, typecheck, build, 94 unit + 2 adapter unit,
  156 integration (1 skipped without an S3 endpoint), 4 MinIO — all green.

Noted while rebasing, not fixed here: `@tuddo/s3` (merged as `7e8a6c1`) implements no
`copy`, so §8.1 `writeStream` cannot promote a quarantine object with it. The §8.2 capture
path is unaffected — S3 enforces `x-amz-checksum-sha256`, so it takes the enforcing arm and
never needs a copy — but the adapter's own SPI coverage has a hole.