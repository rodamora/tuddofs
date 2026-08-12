# Sync transfer batching and presigned hydration

Status: accepted — implemented
Date: 2026-08-12
Spec owner: sync engine (`src/sync/`)
Amends: `architecture.md` §7.1, §7.3 phase 1, §8, §12

## Problem

Every bulk transfer in the sync engine pays one target round trip per file, sequentially:

- **Cold hydration** (`engine.ts` `hydrate()`): per file, `target.mkdir(dirname)` + `target.writeFile()` — 2N round trips. Over SSH (one spawn per verb, 115 ms loopback / 150–500 ms WAN), 100 files cost 23–100 s of pure round-trip time.
- **Capture fetch** (`engine.ts` `capture()`): each changed small file is one sequential `target.readFile()`, inside the capture slot, delaying the next cycle and reconcile.
- **Restage** (`materializePath` loops): same shape, smaller N.

Additionally, every hydration byte relays store → server → target even when the target could fetch from the object store directly — the download mirror of the problem §8.2 already solved for capture uploads.

The per-file _format_ is already optimal (raw `cat` over stdin/stdout, no encoding overhead). The waste is channel shape: round trips proportional to file count, and bytes routed through the server unnecessarily.

## Goals

1. Bulk transfers cost O(1) target execs per batch, never O(files) — hydrate, restage, and capture fetch.
2. When the host declares the target can reach the blob store, hydration bytes flow store → target directly; the server ships URLs plus inline blobs only.
3. The §7.1 seam stays sufficient for sandbox-provider targets (E2B, Blaxel): batch verbs are implementation-free at the seam; tar is an SSH-target detail.
4. Zero new hard runtime dependencies (R9); no protocol implementation in core (§10 rule 3).

## Non-goals

- A sandbox-provider target package (E2B/Blaxel). This spec makes the seam sufficient for one; the target itself is a follow-up spec.
- Compression of the tar stream. Round trips, not bandwidth, are the measured bottleneck. Revisit with evidence.
- Presigned PUTs for small captured files. `beginCaptureUpload` per tiny file costs more than relay; the §8.2 threshold split stays.
- Connection pooling / persistent mux inside the SSH target (explicit non-goal; a shared-channel protocol is what §10 rule 3 forbids, and per-request timeouts in one channel wreck the kill-matrix story). `ControlMaster` passthrough remains the documented host-side baseline.
- Weakening the authoritative full scan (mtime/size prefilters for reconcile hashing). §7.4: mtime is a prefilter, never identity.
- Folding `mkdir -p` into per-file `writeFile` (halves Phase-2 mirror-write round trips). Coherent but independent; listed as a follow-up decision.

## Constraints (unchanged invariants)

- The engine imports `SyncTarget`, never a target implementation, never a provider SDK (§7.1).
- The target is untrusted: fetched bytes are re-hashed server-side (capture) or spot-verified (hydrate); target-reported shas/sizes are prefilters, never commit identity (§7.4).
- A failed scan or transfer is an error event, never an empty diff (§7.2).
- No agent-controlled string is interpolated into an exec line; lists travel NUL-terminated on stdin (scan-list rule, §7.4).
- Symlinks are never followed on the write or read path.
- Kill matrix (§7.5) semantics unchanged: batch failures abort loudly, markers/stamps advance only after success.

## Design

### 1. Seam additions (`src/sync/target.ts`)

```ts
interface SyncTarget {
  // existing: root, exec, readFile, writeFile, mkdir

  /** Binaries this implementation needs on the target; the engine folds them
   *  into the acquire probe so a missing one fails at materialize, never
   *  silently at capture. */
  readonly requiredBinaries?: readonly string[]

  /** Write many files in one round trip. Parent directories are created.
   *  All-or-error: any member failure rejects the whole call. */
  writeFiles?(files: readonly { path: string; bytes: Buffer }[], options?: { timeoutMs?: number }): Promise<void>

  /** Read many regular files in one round trip, keyed by the requested path.
   *  A missing or non-regular member rejects the whole call. */
  readFiles?(paths: readonly string[], options?: { timeoutMs?: number }): Promise<ReadonlyMap<string, Buffer>>
}
```

- Paths are absolute under the workspace root, same validation and error taxonomy as the per-file verbs.
- `timeoutMs` caps one batch exec. The engine passes the transfer timeout (`largeBlobs.uploadTimeoutMs`, default 1 h), not the 2-minute exec default: a 32 MiB chunk on a slow WAN legitimately outlives the default, and a timeout mid-hydration would otherwise hard-fail every retry.
- Both verbs are optional. The engine falls back to the existing per-file loops when absent. The local-directory target does **not** implement them (in-process fs calls have no round-trip cost; the fallback path stays exercised by the local CI suite).
- Semantics mirror the per-file verbs so a target may implement them natively (sandbox SDK batch APIs) or via its own exec. Nothing at the seam names tar.

### 2. SSH implementation (`src/sync/ssh.ts`, `ssh-shell.ts`)

- `requiredBinaries: ['tar']` (GNU tar; the probe already excludes busybox hosts).
- `writeFiles`: one exec — `cd <root> && tar -x --unlink-first -f -` with a PAX archive on **stdin**. `--unlink-first` preserves the no-symlink-follow invariant: an existing symlink at a member path is removed and replaced, never written through.
- `readFiles`: one exec — `cd <root> && tar -c --format=posix --null --files-from=- -f -` with the NUL-terminated path list on **stdin** (never argv: no `ARG_MAX` ceiling, no interpolation) and the archive on **stdout**. The parser rejects any requested path whose member is not a regular file (a symlink that appeared since the scan is refused, matching `find -type f`).
- Both reuse the existing root guard: member paths are engine-generated, validated with `resolveUnderRoot` before emission, and the exec `cd`s into the guarded root.

### 3. Tar format (`src/sync/tar.ts`, new, pure)

- In-process PAX (POSIX.1-2001) writer and parser, zero dependencies (~150 lines each). Tar here is a file _format_, not a protocol — §10 rule 3 holds.
- Writer: every entry gets a PAX extended header carrying `path=` (length-prefixed record; arbitrary bytes including newlines and quotes) plus the ustar entry (mode 0644, regular file). Uniform always-PAX avoids ustar name-split edge cases entirely.
- Parser: handles PAX `path`/`size` records and ustar fields; refuses non-regular entry types for requested paths; refuses members that do not resolve under the expected mirror directories (same re-validation stance as `parseScanRecords`).
- Golden vectors cross-checked against GNU tar output in the SSH suite.

### 4. Engine integration (`src/sync/engine.ts`)

Batching is engine-side so chunk bounds apply to every target:

- **Chunking:** `writeFiles` calls are chunked at 32 MiB cumulative payload (constant, not an option until evidence demands one), bounding RSS regardless of mount size — the §8.3 flat-RSS stance. `readFiles` chunks by claimed size from the size probe; the size probe now runs whenever the engine will batch-fetch (previously only under `directUpload`). Claimed sizes remain untrusted prefilters — they steer chunking, never identity; a lying size risks memory exactly as a giant `readFile` does today.
- **Hydrate:** stream chunk-wise — read `session.readBytes` for files until the 32 MiB chunk budget is reached, issue one `writeFiles`, release the buffers, continue. Peak RSS is one chunk, never one mount. Per-file `mkdir` disappears (tar creates leading directories). The verify sample uses one `readFiles` call when available. Marker/freeze/stamp ordering unchanged.
- **Restage:** `restageDirty()` and the capture-loop restage collect paths and batch through the same helper.
- **Capture fetch:** changed small files below the threshold go through `readFiles` chunks; each returned buffer is re-hashed server-side exactly as now (`sha256(bytes)` before `capture()` commits). Large files keep the §8.2 presigned-PUT path.
- **Fallback:** every call site keeps the per-file loop when the verb is absent; behavior is byte-identical.

### 5. Presigned hydration (Level 2)

Enabled by the existing declaration `largeBlobs.transport: 'presigned'` — reachability target ↔ store is one property, so one flag governs both directions. `ttlSeconds` and `uploadTimeoutMs` govern the download exec too.

Per mount, cold path:

1. For each branch-view entry, `session.mount(key).presign(path, { method: 'GET' })`. SigV4 signing is local computation plus one PG row lookup (~0.3–1 ms each; accepted). An inline blob throws the documented `StorageError` and falls into the **relay set**.
2. Relay set (inline blobs, typically < 128 KiB each) rides the Level-1 tar path.
3. Presigned set: one exec — `cd <root> && curl --parallel --fail --create-dirs --config -` with a curl config on **stdin**: one `url = "…"` / `output = "…"` pair per file, values quoted per curl config escaping rules (`\"`, `\\`, `\n`). URLs (which carry `&`) and paths (which may carry quotes/newlines) never meet a shell. Output paths are `resolveUnderRoot`-checked before the config is built.
4. Any failed transfer fails the exec (`--fail`), which fails `materialize()` loudly; the mount's hydration marker is not yet written, so the retry re-hydrates it — existing crash semantics.
5. The verify sample runs unchanged: re-read from the target, re-hash, compare against branch-view shas. Trust model identical to relay hydration.
6. For a read-only mount, both the tar exec and the curl exec run inside the existing unfreeze → freeze bracket (`chmodWritableCommand` before, `chmodReadOnlyCommand` after), exactly where per-file writes run today.

`probeCommand` already requires `curl` under the presigned transport; unreachable-store failures surface as a failed acquire with curl's error, not a hung capture.

### 6. Probe (`src/sync/paths.ts`)

`probeCommand` gains a `requiredBinaries` input, folded in alongside the coreutils checks. The engine passes `target.requiredBinaries ?? []`. The engine's own list stays exactly what the engine itself execs (`find`, `sha256sum`, `xargs`, `touch`, `stat`, and `curl` under presigned transport).

## Data flow (cold acquire, presigned, N files)

```
server                    target                    store
  |-- probe/manifest ------->|                        |
  |   (2 execs)              |                        |
  |-- presign xN (local CPU + PG row each)            |
  |-- tar: inline blobs ----->|  (1 exec / 32 MiB)    |
  |-- curl config ----------->|== parallel GETs ======|
  |   (1 exec)               |                        |
  |-- verify sample <---------|  (1 readFiles exec)   |
  |-- marker + stamp -------->|  (2 writes/execs)     |
```

Relay mode differs only in step 4: all files ride the tar path.

## Error handling

| Failure                                       | Behavior                                                                                                                         |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Missing `tar`/`curl` binary                   | Probe fails at acquire (`SyncTargetError`), never silently at capture                                                            |
| `writeFiles` exec non-zero / stream truncated | Hydrate/restage aborts; marker/stamp untouched; retry re-hydrates (§7.5)                                                         |
| `readFiles` member missing or non-regular     | Whole call rejects → capture cycle fails, slot releases, `onCaptureFailed`, stamp untouched — same as today's `readFile` failure |
| Any presigned GET fails                       | `curl --fail` → exec non-zero → `materialize()` rejects                                                                          |
| Presign refused (inline)                      | Routed to relay set (expected path, not an error)                                                                                |
| Presign refused (no storage / unsupported)    | `materialize()` rejects — host misconfiguration surfaced at acquire                                                              |
| Tar parse error on `readFiles` output         | Malformed transfer = error, never an empty result (§7.2)                                                                         |

## Architecture amendments to land with the change

- §7.1: two optional seam verbs + `requiredBinaries`; note that batch verbs are implementation-free and tar is the SSH target's detail.
- §7.3 phase 1: hydration via batch writes and, under the declared transport, presigned GETs; verify sample unchanged.
- §8: gains the download direction (§8.2 symmetry); one transport declaration governs both.
- §12: new asserted rows, as exec **counts** at the seam (the warm re-acquire precedent): cold acquire = O(1) + ⌈bytes/32 MiB⌉ execs, never O(files); capture cycle = 3 + ⌈changed bytes/32 MiB⌉ execs (scan, size, fetch chunks, stamp) regardless of changed-file count.

## Acceptance criteria

1. Cold acquire of a mount with 200 files over the SSH fixture completes in O(1)+chunks execs (asserted by exec count at the seam) and produces byte-identical mirrors and index state to the per-file path.
2. A capture cycle with 50 changed small files (< 32 MiB total) over SSH performs ≤ 4 target execs (scan, size, one fetch chunk, stamp) and commits the same tree as the per-file path.
3. Hostile names — newline, single/double quote, `%`, non-ASCII, 300-char path — survive tar round trip and curl config quoting; golden-vector unit tests plus one SSH integration case.
4. A symlink planted at a member path before `writeFiles` is replaced, not followed; a symlink swapped in before `readFiles` is refused; asserted on the SSH fixture.
5. With `transport: 'presigned'` against MinIO + SSH fixture: object-backed files arrive via direct GETs (server relays zero object-backed bytes), inline blobs arrive via tar, verify sample passes, and an unreachable store fails `materialize()` with a `SyncTargetError`.
6. Local target (no batch verbs) exercises the fallback loops: full existing integration suite green unchanged.
7. Kill matrix re-run green on both targets: a kill mid-batch leaves marker/stamp behind, and re-acquire converges.
8. §12 budget suites assert and print the new rows; existing budgets hold.

## Testing approach

- **Unit (pure):** tar writer/parser golden vectors incl. hostile names and >255-char paths; parser refusal of non-regular members and out-of-root paths; curl config quoting; `probeCommand` with `requiredBinaries`; chunking arithmetic.
- **Integration (PG + local target):** fallback loops, capture semantics unchanged.
- **SSH suite:** exec-count assertions (criteria 1–2), symlink cases (4), hostile names end-to-end (3), kill matrix (7).
- **MinIO + SSH:** presigned hydration (5), building on the existing `scripts/minio-*.test.ts` fixtures.
- **Budgets:** new rows in both `sync-budgets.integration.test.ts` and `sync-budgets-ssh.ssh.test.ts` (exec counts at the seam, not latencies).

## Open decisions (not blocking)

1. Rename `largeBlobs` to `transfer` in a future breaking release (the option group now governs both directions; name is historical).
2. Fold `mkdir -p` into per-file `writeFile` scripts to halve Phase-2 mirror-write round trips — independent seam-contract change, own small spec or task.
3. Batch presign API on the session (N PG lookups → 1 query) — only if presign cost ever shows up in a measured acquire; YAGNI today.
