# s3-capture-blobs — presigned large-blob path in exec capture

Status: open
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
