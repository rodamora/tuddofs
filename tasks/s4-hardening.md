# s4-hardening — standalone product hardening

Status: open
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
