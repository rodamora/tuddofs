# s1-tree-coherence — enforce the no-prefix-collision invariant

Status: open
Stage: S1 pre-work (ships with s1-surface-diet as one breaking release)
Depends on: —
Spec: `../architecture.md` §4.3 (invariant + three enforcement points), §4.5 (TO ADD markers on Write/Merge/verify), §11 S1 proof column

## Goal

No tree may contain a path that is a directory-prefix of another (`/a` file + `/a/x.md`). Enforced at write (reject), merge (conflict), and audited by `verify()`.

## Scope

- Kernel write/delete path: inside the tx, against current heads, reject a write whose path collides with an existing file-as-directory or directory-as-file; `InvalidPathError` naming the colliding entry.
- Merge: after the per-path §9 classification builds a conflict-free tree, validate coherence of the merged tree; a collision is returned as a conflict on both paths, never committed.
- `verify()`: coherence audit over ref-tip trees (flags any pre-enforcement incoherent tree as a finding).
- Property test (§11 S1 proof): no generated op sequence yields an incoherent tree; merging two individually-coherent trees that collide yields a conflict result.

Non-goals: no directory objects, no `mkdir`, no change to the §4.2 hash preimage (the invariant constrains valid trees; it does not change the format). The capture-side rule (§4.3 point 2) belongs to s1-sync-core, not here.

## Acceptance

- Unit + integration tests for: write `/a` then `/a/x.md` rejected (and the reverse), delete-then-write allowed, merge collision → conflict (ours adds `/a`, theirs adds `/a/x.md`), verify flags a hand-seeded incoherent tree.
- Property test wired into the existing seeded-randomized suite conventions (see `gc-verify.integration.test.ts` for the pattern).
- Existing suites green; no golden-hash fixture changes (if one fails, the change is wrong — §13.1).
