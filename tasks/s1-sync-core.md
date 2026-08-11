# s1-sync-core — sync engine + local-directory target

Status: done
Stage: S1
Depends on: s1-surface-diet, s1-tree-coherence (both merged first; build on the narrow surface)
Spec: `../architecture.md` §7 ENTIRE (7.1 SyncTarget, 7.2 events, 7.3 four phases, 7.4 gotchas, 7.5 kill matrix), §4.3 point 2 (capture coherence rule), §12 budgets

## Goal

The disk-level runtime: materialize governed mounts into a real directory, write-through for file tools, exec capture, turn-end reconcile — with the local machine as the first `SyncTarget`.

## Scope

- `SyncTarget` interface exactly as §7.1; engine never imports a provider SDK.
- Local-directory target: child-process exec + `node:fs`. Document loudly: grant confinement protects the FS, NOT the host.
- All four phases per §7.3 verbatim, including the stamp protocol, one-in-flight capture slot with coalescing and failure-release, straggler guard, and the §4.3 capture rule (captured path implying a directory over a head file includes that file's deletion in the same commit).
- Event surface per §7.2 (`onCapture`, `onCaptureFailed`, `onReadOnlySkipped`); a failed scan is an error event, never an empty diff.
- Every §7.4 gotcha becomes a test (NUL-safe names, symlink non-following, mount-escape rejection, root-guard on destructive execs, mirror-dir `:` encoding).
- Virtual mounts skipped at materialize, rejected in mirror-path mapping (§6.1).

Non-goals: SSH/provider targets (s2), presigned large-blob capture (s3-capture-blobs — engine calls `readFile` for everything in this task), Phase-3 deferral (REFUSED, §6.2 — it is the R4 durability mechanism).

## Acceptance

Kill matrix (§7.5) green in CI with zero external infrastructure:
- Tool write survives instant target kill.
- Killed exec loses at most itself; reconcile recovers everything on disk.
- Capture failure re-triggers, surfaces via `onCaptureFailed`, never wedges the slot.
- Hostile-input suite: path escapes in scan output, quoting collapse, symlink exfiltration attempt.
- Filenames with spaces/newlines/astral-plane chars round-trip.

## Evidence

- Engine: `src/sync/` (`paths.ts` mirror/quoting/scan rules, `slot.ts` capture slot, `target.ts` the §7.1 seam, `local.ts` local-directory target, `engine.ts` the four phases). Exported from `tuddofs/internal`; §6.2 enumerates the Tier-1 entry exhaustively, so promoting `createSyncEngine` needs a spec amendment.
- Batch capture commit: `kernel.captureBatch` + `session.mount(key).capture()` + `session.mounts()`, applying the §4.3 point-2 capture rule inside the commit transaction. Both mount-handle verbs are reachable from the Tier-1 `open()` result, so §6.2 point 3 was amended to name them and mark them non-tool verbs.
- Kill matrix and hostile-input suite: `src/integration/sync-engine.integration.test.ts` (21 tests, zero external infrastructure beyond the package's existing PostgreSQL container). Batch-commit semantics: `src/integration/sync-capture.integration.test.ts` (8). §12 budgets: `src/integration/sync-budgets.integration.test.ts` (5). Pure rules: `src/__tests__/sync-paths.test.ts` (10), `src/__tests__/sync-slot.test.ts` (7), `src/__tests__/sync-local-target.test.ts` (7). Whole package: 88 unit, 134 integration.
- Straggler-guard scope, fixed in review and amended into §7.3 phase 4: the guard is WINDOWED. A scan that observes the committed bytes on disk retires it, or every later revert to the pre-write content is misread as a lost mirror write and silently overwritten. It is also rebuilt from durable history on a warm re-acquire, because heads carry no straggler state and §7.5 line 1 has to hold across a crash-resume.
- Host callbacks are isolated (§7.2): a throwing `onCapture`/`onCaptureFailed`/`onReadOnlySkipped` is logged through the new optional `logger` and dropped. Without it the throw rejected the fire-and-forget capture chain, which Node turns into an unhandled rejection and a process exit.
- Spec correction found by the suite: the §7.3 stamp must trail the scan start by a granularity margin. Filesystem timestamps come from a coarse clock, so a stamp set to the exact scan instant can be newer than a write that follows it, and `find -newer` then silently under-captures — which §7.4 forbids. `stampCommand` subtracts 1s; over-capture stays a sha no-op. Measured: stamping the acquire watermark from the hydration marker instead removes the first-scan re-hash but silences three kill-matrix cases, so the margin stays (§7.3 phase 1 step 2).
- Spec deviation, same reason: the scan runs `find … -print0 > .tuddofs/scan && xargs -0 -r sha256sum --zero < .tuddofs/scan` instead of the illustrative pipeline, because a pipe reports `xargs`' exit status and would turn a failed `find` into an empty diff (§7.2).
- Spec additions, all amended in-branch (§13.7 — docs are contract): §7.3 phase 1 step 2, phase 3 steps 1 and 6, phase 4; §6.2 point 3; §9 gains `SyncTargetError`; §12 gains measured figures and names the asserting suite; §11 and §14 risk 4 follow.
