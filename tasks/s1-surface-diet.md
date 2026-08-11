# s1-surface-diet — cut the consumer API to the §6.2 tiers

Status: done
Evidence: `da09e9f` (red contract tests), `src/__tests__/surface.test.ts`, `src/__tests__/readme.test.ts`, and `src/integration/{readme,session}.integration.test.ts`.
Stage: S1 pre-work (ships with s1-tree-coherence as one breaking release)
Depends on: —
Spec: `../architecture.md` §6.2 (all four items), §9 (EditMatchError), §13.7 (README same-PR rule)

## Goal

The main `tuddofs` entry exports exactly the Tier-1 set; everything else moves to `tuddofs/internal`; session gains `mount(key)` handles; the three contract fixes land (str-replace `edit`, unified `merge`, `mounts` string shorthand).

## Scope

- `src/index.ts` → Tier-1 only: `createTuddoFs` (returning `{ migrate, open, gc, verify, invalidate }`), `createDirectAdapter`, typed errors (§9), public types.
- New `tuddofs/internal` subpath export (package.json `exports` map): kernel ref-level ops, hashing helpers, `GrantController`, validation functions. Same code — this is an export move, not a rewrite.
- `session.mount(key)` returning the file ops bound to one mount with plain `/paths`. Compound `mountKey:/path` addressing remains only in the adapter layer (`direct.ts`).
- `edit()`: replace offset `TextEdit` with `{oldText, newText, replaceAll?}`; zero or multiple matches without `replaceAll` → new `EditMatchError` carrying the match count; `ifSha` behavior unchanged. Update `direct.ts` `edit_file` accordingly.
- `merge({mounts?, approver?})` returns per mount `{status: 'merged'|'unauthorized'|'pendingApproval'|'conflicts', conflicts?}`; delete `resolveMerge` (its callers pass `mounts: [key]`).
- `open()` accepts `mounts: ['key']` shorthand for `[{key}]`.

Non-goals: no behavior changes inside the kernel; no sync-engine code; no README quickstart rewrite beyond what the surface change forces.

## Acceptance

- A unit test asserts the main entry's export names equal the Tier-1 set exactly (fails on any future leak).
- README quickstart compiles and runs against the new surface (README updated in the same PR, §13.7).
- All existing suites green after mechanical migration; `resolveMerge` and offset-`TextEdit` are gone from the public surface (no deprecated aliases — clean cutover).
- `EditMatchError` added to `src/errors.ts` and exercised by tests (0-match and multi-match cases).
