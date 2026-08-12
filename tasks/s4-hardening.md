# s4-hardening — standalone product hardening

Status: done — PR https://github.com/rodamora/tuddofs/pull/11 (branch `s4/hardening`); evidence below
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
- **Release pipeline** — `.github/workflows/release.yml`: tag-driven (`v*` for core, `s3-v*` for the adapter) plus a `workflow_dispatch` that defaults to dry-run, tag/version agreement check, then format, lint, typecheck, build, `gate:surface`, `gate:docs`, and every suite the project has under `TUDDOFS_NO_SKIPS=1` — units and the adapter against MinIO, the PostgreSQL integration suite, the MinIO streaming acceptance test, and the SSH target suite — followed by the clean-container quickstart proof, an `--ignore-scripts` publish dry run, `npm publish --provenance`, and only then service teardown. Both packages carry a `prepublishOnly` (build + gates + tests for core, build + typecheck + conformance for the adapter), so a laptop publish cannot skip them.
- **README↔`.d.ts` drift gate** — `src/__tests__/docs.test.ts` discovers and compiles EVERY ` ```ts ` block in `README.md`, `docs/host-guide.md`, and `packages/s3/README.md` against the BUILT declarations, resolved through each package's `exports` map with no `paths` shim, so a broken exports map or a drifted `.d.ts` fails the gate; it also asserts every published subpath resolves to a real declaration and that the host guide's error table names every exported error class. `src/integration/docs.integration.test.ts` executes the two programs the documents hand out verbatim against real PostgreSQL. Both replace the narrower `readme.test.ts` / `readme.integration.test.ts`.
- **Skip-free gate** — every suite now runs through `scripts/run-tests.mjs`, which tees a TAP stream, reports SKIP/TODO directives apart from the pass tail, and fails the run under `TUDDOFS_NO_SKIPS=1`. CI sets it on the checks, integration, and SSH jobs; the checks job starts MinIO before `npm test` so the S3 contract cases run instead of skipping.
- **§12 budgets measured** — local rows re-measured by the existing integration suite; the network rows measured by the new `src/integration/sync-budgets-ssh.ssh.test.ts` (remote exec round trip, visible write, capture trigger, warm re-acquire) and asserted. `architecture.md` §12 now carries both columns with the machine and method named; §14 risk 4 is CLOSED.
- **§15 closed** — all four decisions recorded with reasoning in `architecture.md` §15 (mirror root `<root>/<mirrorDir>` with `%3A`; conflicts as data, permanently; `@tuddofs/s3`; engine in core on `tuddofs/internal`, with Tier-1 promotion left as a separate additive question). The forward references in §6.2 and §9 that promised automatic Tier-1 promotion were corrected.

Acceptance evidence (local gate, 2026-08-11):

- `npm run format:check`, `npm run lint`, `npm run typecheck`, `npm run build` — clean.
- `TUDDOFS_NO_SKIPS=1 npm test` with MinIO up — 115 core + 10 adapter tests, 0 failures, 0 skips.
- `TUDDOFS_NO_SKIPS=1 npm run test:integration` against disposable PostgreSQL 16 — 160 tests, 0 failures, 0 skips; §12 local rows printed.
- `TUDDOFS_NO_SKIPS=1 npm run test:ssh` — 38 tests, 0 failures, 0 skips; kill matrix plus the §12 network rows printed.
- Fixed en route: `packages/s3/test/s3-specific.test.ts` depended on `contract.test.ts` having created the bucket, which Node's parallel file execution does not order. It now creates its own (`packages/s3/test/bucket.ts`). Reproduced against a fresh MinIO — three 404s before, green after — and it is what turned the Node 20 CI leg red on the first run of this branch.
- CI (run 31543027690, all six jobs green): checks on Node 20 and 22, PostgreSQL integration, SSH acceptance with the network budgets, packed-package smoke, and the docs gate — whose log shows the container printing `Ship safely.` and `{"collectedBlobs":0,...,"verifyOk":true,"findings":0}`. The §12 budgets hold on the hosted runner too; the numbers are recorded in `architecture.md` §12.
- `npm run gate:quickstart` — packed tarball installed into an empty project inside a scratch `node:22-alpine` container on a private network with a scratch PostgreSQL; the README quickstart printed `Ship safely.` and the host-guide maintenance job printed `{"collectedBlobs":0,"collectedObjects":0,"settledBranches":0,"skippedTenants":[],"verifyOk":true,"findings":0}`.

Review round (PR #11, 2026-08-11) — eight findings closed, each with local proof:

- **Release pipeline was broken and had never run.** Teardown ran `if: always()` before the publish steps, so `prepublishOnly` met a dead MinIO. Reproduced: with MinIO removed and `TUDDOFS_S3_ENDPOINT` still set, `npm publish --dry-run` fails with `connect ECONNREFUSED 127.0.0.1:9000`; the same command with `--ignore-scripts` prints `+ tuddofs@0.1.0`. Fixed by moving teardown below publish in both jobs and adding `--ignore-scripts` to both dry runs. The workflow still cannot run until it is on the default branch — the first post-merge `workflow_dispatch` (dry-run defaults to true) must be watched.
- **Docs gate bypassed the built declarations.** It mapped `tuddofs` → `./src/index.ts`, so deleting `"./internal"` from `exports` left it green. The `paths` shim is gone; examples now resolve through the real exports maps into `dist/*.d.ts`. Proof: deleting `"./internal"` from `exports` now fails three README blocks with `Cannot find module 'tuddofs/internal'`; removing `dist/internal.d.ts` fails the new precondition test with "run `npm run build` before the docs gate". CI's docs job and core `prepublishOnly` build first.
- **Warm re-acquire was asserted only in wall clock.** `sync-budgets-ssh.ssh.test.ts` now counts the §7.1 verbs: warm re-acquire measures `{"exec":2,"readFile":0,"writeFile":0,"mkdir":0}` and asserts ≤ 2 execs with zero transfers, against a cold hydrate of the same workspace measured at 26 writes. The wall clock stays as the coarse backstop.
- **README overstated the release gate.** Release now actually runs the integration, MinIO-streaming, and SSH suites, and README "Versioning and releases" names exactly what runs.
- **Error table was incomplete.** `InvalidCommitTimestampError` added, and the docs gate now asserts the table's first column equals the exported `*Error` classes from both entry points.
- **Board drift.** `tasks/README.md` shows s4-hardening `done`.
- **`packages/s3` had no publish gate.** It now has a `prepublishOnly` running build + typecheck + the conformance suite; verified by `npm publish --workspace @tuddofs/s3 --dry-run` with MinIO up.
- **`npm test` ran up to three times per release.** Down to one on a dry run and two on a real publish, the second being the deliberate `prepublishOnly` in the uploading process.

Re-verified after the fixes: `format:check`, `lint`, `typecheck`, `build` clean · `npm test` 115 core + 10 adapter, 0 skips · `test:integration` 160 · `test:minio` 4 · `test:ssh` 38 · `gate:surface` 9 · `gate:docs` 17 · `gate:quickstart` printed `Ship safely.` and `verifyOk: true`.