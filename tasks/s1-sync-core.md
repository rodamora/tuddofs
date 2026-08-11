# s1-sync-core — sync engine + local-directory target

Status: open
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
