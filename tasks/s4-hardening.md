# s4-hardening — standalone product hardening

Status: in-progress — branch `s4/hardening`; evidence recorded below
Stage: S4 (final gate)
Depends on: all other tasks
Spec: `../architecture.md` §10 (host obligations), §12 (budgets), §13.7 (docs contract), §15 (close remaining decisions)

## Goal

Everything a host application needs that no consumer app provides anymore: integration guide, operational docs, release pipeline, and measured performance budgets.

## Scope

- **Host integration guide** (`docs/host-guide.md`): grant-resolver patterns (fail closed, close to the authz system), multi-worker `invalidate()` limits and the 30s TTL bound, GC/`verify` scheduling (cron/worker examples), `onCommit` wiring, virtual-mount handler rules, SigV4 host-reachability caveat.
- **Release pipeline:** semver policy in the README (surface change table: what is patch/minor/major), publish workflow with the Tier-1 export-set test and README-example compilation as gates.
- **README↔`.d.ts` drift check** in CI (compile README examples — §13.7).
- **Measure §12 budgets** on the local and SSH targets; replace estimates with measurements and keep them as regression assertions where stable.
- Close the §15 open decisions (mirror-root naming, adapter package name) or record why they stay open.

Non-goals: new features; provider targets; UI of any kind.

## Acceptance

- A fresh `npm install tuddofs` consumer can go from zero to governed writes + scheduled GC/verify using only the README and host guide — verified by running the quickstart verbatim on a clean machine/container.
- CI gates: export-set test, README compilation, skip-free suite (§13.6).
- §12 table updated with measured numbers; regressions asserted.

## Status / evidence

Delivered:

- **Host integration guide** — `docs/host-guide.md`: obligations table, construction, grant-resolver patterns (fail closed, empty-key denial, resolver availability), revocation with the process-local `invalidate()` limit and the 30 s cap, scheduled `gc()`/`verify()` with a runnable maintenance job and a cron line, `onCommit` delivery semantics, virtual-mount handler rules, object storage and the SigV4 host-reachability caveat, sync-engine hosting and the `exec` trust boundary, an error-to-recovery table, and a production checklist.
- **Semver policy** — README "Versioning and releases": per-change release table, the three load-bearing rows (hash formats never change, migrations immutable, `tuddofs/internal` carries a weaker promise), and the pre-1.0 mapping.
- **Release pipeline** — `.github/workflows/release.yml`: tag-driven (`v*` for core, `s3-v*` for the adapter), tag/version agreement check, then format, lint, typecheck, build, `gate:surface`, `gate:docs`, a skip-free `npm test` against MinIO, the clean-container quickstart proof, a publish dry run, and finally `npm publish --provenance`. `prepublishOnly` re-runs build + both gates + tests, so a laptop publish cannot skip them.
- **README↔`.d.ts` drift gate** — `src/__tests__/docs.test.ts` discovers and compiles EVERY ` ```ts ` block in `README.md`, `docs/host-guide.md`, and `packages/s3/README.md` against the shipped entry points; `src/integration/docs.integration.test.ts` executes the two programs the documents hand out verbatim against real PostgreSQL. Both replace the narrower `readme.test.ts` / `readme.integration.test.ts`.
- **Skip-free gate** — every suite now runs through `scripts/run-tests.mjs`, which tees a TAP stream, reports SKIP/TODO directives apart from the pass tail, and fails the run under `TUDDOFS_NO_SKIPS=1`. CI sets it on the checks, integration, and SSH jobs; the checks job starts MinIO before `npm test` so the S3 contract cases run instead of skipping.
- **§12 budgets measured** — local rows re-measured by the existing integration suite; the network rows measured by the new `src/integration/sync-budgets-ssh.ssh.test.ts` (remote exec round trip, visible write, capture trigger, warm re-acquire) and asserted. `architecture.md` §12 now carries both columns with the machine and method named; §14 risk 4 is CLOSED.
- **§15 closed** — all four decisions recorded with reasoning in `architecture.md` §15 (mirror root `<root>/<mirrorDir>` with `%3A`; conflicts as data, permanently; `@tuddofs/s3`; engine in core on `tuddofs/internal`, with Tier-1 promotion left as a separate additive question). The forward references in §6.2 and §9 that promised automatic Tier-1 promotion were corrected.

Acceptance evidence (local gate, 2026-08-11):

- `npm run format:check`, `npm run lint`, `npm run typecheck`, `npm run build` — clean.
- `TUDDOFS_NO_SKIPS=1 npm test` with MinIO up — 113 core + 10 adapter tests, 0 failures, 0 skips.
- `TUDDOFS_NO_SKIPS=1 npm run test:integration` against disposable PostgreSQL 16 — 160 tests, 0 failures, 0 skips; §12 local rows printed.
- `TUDDOFS_NO_SKIPS=1 npm run test:ssh` — 38 tests, 0 failures, 0 skips; kill matrix plus the §12 network rows printed.
- `npm run gate:quickstart` — packed tarball installed into an empty project inside a scratch `node:22-alpine` container on a private network with a scratch PostgreSQL; the README quickstart printed `Ship safely.` and the host-guide maintenance job printed `{"collectedBlobs":0,"collectedObjects":0,"settledBranches":0,"skippedTenants":[],"verifyOk":true,"findings":0}`.
