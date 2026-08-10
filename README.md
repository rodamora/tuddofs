# @cowork/agent-fs

> **Status: docs-first contract.** This README is written ahead of the implementation and is normative for it (spec §15.7). The governing design is [`docs/specs/2026-08-10-agent-fs-architecture.md`](../../docs/specs/2026-08-10-agent-fs-architecture.md); section references below (`§`) point there. The **Milestone availability** table marks what exists at each stage. Package name is a placeholder pending spec §16.1.

A **multi-tenant, permission-confined, branchable filesystem for AI agents.** Postgres + object storage. Embeddable TypeScript library.

One sentence: _git's object model with your application's permissions, built for agents that run anywhere._

Files here are not agent scratch — they are **governed user data**: scoped to org/workspace/project/team/user, access-controlled by your app's live permission logic, with agent changes flowing through branches and honest merges.

---

## Table of contents

1. [Concepts](#concepts)
2. [Requirements & install](#requirements--install)
3. [Host setup (every consumer starts here)](#host-setup)
4. [Sessions & the file API](#sessions--the-file-api)
5. [Branching: merge, conflicts, discard](#branching-merge-conflicts-discard)
6. [History, restore, tags](#history-restore-tags)
7. [Authorization (GrantResolver SPI)](#authorization-grantresolver-spi)
8. [Virtual mounts (live app data as files)](#virtual-mounts)
9. [Consumer recipes](#consumer-recipes)
   - [A. In-process SDK agent (direct)](#a-in-process-sdk-agent-direct)
   - [B. Mastra agent](#b-mastra-agent)
   - [C. Sandboxed agent (shell tools on real files)](#c-sandboxed-agent-shell-tools-on-real-files)
   - [D. Staged writers & approvals](#d-staged-writers--approvals)
10. [Storage backends (S3, MinIO, R2)](#storage-backends)
11. [Maintenance: migrate, gc, verify](#maintenance-migrate-gc-verify)
12. [Events](#events)
13. [Error taxonomy](#error-taxonomy)
14. [Rules & guarantees](#rules--guarantees)
15. [Milestone availability](#milestone-availability)

---

## Concepts

| Term        | Meaning                                                                                                                                                                                   |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Tenant**  | Hard isolation boundary (your customer org). On every row; nothing crosses it.                                                                                                            |
| **Mount**   | One scope of files an agent can see (e.g. `project:crm`, `user:settings`). A session assembles several mounts into one view. Ref-backed (versioned) or **virtual** (live app data, §6.1). |
| **Session** | An agent's window onto its mounts. First write to a mount lazily **forks** a private branch from the mount tip (§4.6); the agent works isolated until merge.                              |
| **Commit**  | Immutable snapshot of one mount's tree, attributed to _user + agent kind + thread + run_ (§4.1). Content-addressed (sha256); history is append-only — no force-push exists anywhere (§6). |
| **Merge**   | Per-mount, all-or-nothing, honest: concurrent edits to the same path surface as **conflicts** (data, not exceptions), classified by the 14-row decision table (§8).                       |
| **Heads**   | Derived per-ref `path → blob` index making reads O(1). Rebuildable; never a source of truth (§4.1).                                                                                       |

Identity is never collapsed (§5.1): _attribution_ (whose behalf), _execution_ (session actor), _provenance_ (which agent/run), _authorization_ (whose grant, may differ under staged approval), and _tenant_ are separate fields by design.

## Requirements & install

- **Hard dependency:** `pg` only (§10b). Everything else — object storage, logger, permission logic — is injected.
- PostgreSQL with advisory locks and `ON CONFLICT` (any currently supported major).
- Object storage: anything S3-compatible ([details](#storage-backends)). Only needed once blobs exceed the inline threshold (default 128 KiB).

```bash
pnpm add @cowork/agent-fs pg
```

Inside this monorepo: `"@cowork/agent-fs": "workspace:*"`.

## Host setup

Wire it once at boot. The package owns its tables (`afs_*`) via its own migrations — they never enter your ORM schema (§10b.2).

```ts
import { Pool } from 'pg'
import { createAgentFs } from '@cowork/agent-fs'
import type { GrantResolver, BlobStore } from '@cowork/agent-fs'

const grants: GrantResolver = {
  // YOUR live permission logic. Called per operation (cached ≤30s). See §5.
  async resolve(actor, mount) {
    const role = await lookupRole(actor.id, mount.key) // your app's ACL
    if (!role) return { read: false, write: 'none' }
    return { read: true, write: role.canWrite ? 'direct' : 'staged' }
  },
}

export const agentFs = createAgentFs({
  pool: new Pool({ connectionString: process.env.DATABASE_URL }),
  storage: myBlobStore, // see "Storage backends"
  grants,
  logger, // your structured logger
  config: { inlineMaxBytes: 131072 },
})

await agentFs.migrate() // idempotent; run alongside your app migrations
```

## Sessions & the file API

```ts
const fs = await agentFs.open({
  actor: { id: user.id, tenant: org.id }, // the EXECUTING user — never a system actor (§5.6)
  sessionId: thread.id, // scopes branch refs: agent/<sessionId>/<mountKey>
  attribution: { agentKind: 'file-agent', threadId: thread.id, runId: run.id },
  mounts: [
    { key: 'project:crm' }, // follow (default): forks from the live tip
    { key: 'org:handbook', mode: { pin: 'tag/org:handbook/v3' } }, // read-only snapshot (§5)
    { key: 'team:roster', virtual: rosterHandler }, // live data, no history (§6.1)
  ],
})
```

Paths are `mountKey:/relative/path`. Nothing outside the mount table is reachable. Path rules (§4.3): NFC-normalized then validated, no `..`/`.` segments, no `\0`, ≤1024 UTF-8 bytes, **case-sensitive**, no symlinks. Invalid paths are rejected, never "fixed". Mount keys match `^[a-z0-9][a-z0-9:._-]{0,63}$` (§4.4).

```ts
// Reads
const text = await fs.read('project:crm:/notes/plan.md') // string (utf-8)
const bytes = await fs.readBytes('project:crm:/assets/logo.png') // Buffer
const stat = await fs.stat('project:crm:/notes/plan.md') // { path, sha256, sizeBytes, mode }
const files = await fs.list('project:crm:/notes') // direct children
const hits = await fs.glob('project:crm:/**/*.md')

// Writes — every write is a commit on the session's private branch
const w = await fs.write('project:crm:/notes/plan.md', 'v2', {
  ifSha: stat.sha256, // optimistic concurrency: mismatch → PreconditionFailedError, re-read and retry
})
// w: { path, sha256, sizeBytes, commitSha }

// edit = read head → apply structured edits → write with ifSha of what was read (§6)
await fs.edit('project:crm:/notes/plan.md', edits)

await fs.delete('project:crm:/old.md')
```

Semantics you can rely on:

- **Writing the same content is a no-op** — no empty commits, same state returned (§4.5).
- Writes to a **pinned** mount → `PermissionDeniedError` regardless of grant (§5.5).
- Writes refused by the grant fail **before** any I/O (§4.5 step 0).
- A branch that was merged/abandoned refuses writes with `BranchSettledError` — open a new session (§9).

## Branching: merge, conflicts, discard

Your agent worked on private branches; land them per mount:

```ts
const results = await fs.merge()
// per mount: 'merged' | 'unauthorized' | 'pendingApproval' | { conflicts: Conflict[] }

for (const [mountKey, r] of Object.entries(results)) {
  if (r === 'merged') continue
  if (r === 'pendingApproval') await queueForApprover(mountKey) // see recipe D
  if (typeof r === 'object') showConflicts(r.conflicts)
  // Conflict: { path, baseSha?, oursSha?, theirsSha? } — computed, never stored (§4.7)
}
```

- Merges are **per mount, all-or-nothing per mount**; a conflict in mount P never blocks mount Q (§4.7).
- Conflict resolution: an authorized actor writes the resolved content to the mount, then `fs.resolveMerge(mountKey)` — which literally re-runs the merge; converged rows classify clean (§4.7).
- Merge is idempotent: re-running a completed merge produces no new commit.
- `fs.discard()` abandons all of the session's branches — nothing touches the mounts, GC reclaims later.
- Classification follows the **14-row decision table** (§8), including delete/edit races (`they edited, we deleted` → conflict) and files created on the mount after your fork (kept).

## History, restore, tags

Everything is a commit; nothing is ever rewritten (§6):

```ts
await fs.history('project:crm:/notes/plan.md') // commits touching this path
await fs.timeline({ runId: 'r_8842' }) // everything one run did — audit view
await fs.diff(commitA, commitB) // per-path changes

await fs.tag('project:crm', 'before-cleanup') // durable label; never auto-GC'd
await fs.restore('project:crm', 'before-cleanup') // NEW commit with the old tree — undo without rewriting
```

"Restore the project to before the run" = `timeline({ runId })` → first commit → `restore(mountKey, thatCommit.parent)`.

## Authorization (GrantResolver SPI)

```ts
type WriteMode = 'direct' | 'staged' | 'none'
interface GrantResolver {
  resolve(actor: Actor, mount: MountRef): Promise<{ read: boolean; write: WriteMode }>
}
```

The kernel passes `mount.key === ''` for a read without a mounted key. Treat
that as an unmounted read only when supported; unknown keys (including `''`)
must deny access (fail closed). A supplied mount key is validated before the
resolver runs.

The contract (§5, each rule is a test in the package):

1. **Fail closed.** Resolver throws or times out (5s) → treated as no access, surfaced as `GrantResolverError`. Never fail open.
2. **Live resolution.** Cached ≤30s per `(actorId, mountKey)`; call `agentFs.invalidate(actorId, mountKey?)` on permission changes. Merge and fork always bypass the cache.
3. **Permission never travels through time.** Fork checks read at fork time; writes check write at write time; merge re-resolves _inside_ the merge transaction — mid-run revocation takes effect immediately.
4. **`staged` never escalates.** A staged writer's merge returns `'pendingApproval'`; landing it requires an approver whose live grant is `'direct'`.
5. **Multi-worker:** `invalidate()` is per-process. Unless you transport invalidation (pub/sub), correctness rests on the 30s TTL — never lengthen it to reduce resolver load.

Anything expressible as `resolve(actor, mount)` works — role tables, policy engines, Zanzibar tuples (§12).

## Virtual mounts

Serve live app data (rosters, tasks, profiles) through the same file surface — one cognitive model for the agent (§6.1):

```ts
const rosterHandler: VirtualMountHandler = {
  async list(dir, actor) {
    return teamMembersAsEntries(actor)
  },
  async read(path, actor) {
    return renderMemberMarkdown(path, actor)
  },
  async write(path, bytes, actor) {
    await applyRosterEdit(path, bytes, actor)
  }, // omit → read-only
}
```

Virtual mounts have **no history, no branches, no merge** — those calls throw `NotFoundError`-family, never silently return empty. They are tool-level only: never materialized into sandboxes (§6.1.2). Authorization is the handler's job, invoked with the executing actor; fail closed.

## Consumer recipes

### A. In-process SDK agent (direct)

No machinery — your tool functions call the session (§7.3):

```ts
const tools = {
  read_file: ({ path }) => fs.read(path),
  write_file: ({ path, content }) => fs.write(path, content),
  list_files: ({ dir }) => fs.list(dir),
}
// run agent loop … then:
await fs.merge()
```

### B. Mastra agent

The adapter implements Mastra's `WorkspaceFilesystem` over a session (§7.3). Error mapping: `ifSha` failure → `StaleFileError`, `overwrite:false` on existing → `FileExistsError`, missing → `FileNotFoundError`.

```ts
import { createMastraWorkspaceFs } from '@cowork/agent-fs/mastra'
const workspace = createMastraWorkspaceFs(fs)
```

### C. Sandboxed agent (shell tools on real files)

For agents whose tools touch a real OS (bash, grep, any binary). Implement `SyncTarget` for your sandbox — Blaxel, E2B, SSH, or the local machine (§7.1):

```ts
interface SyncTarget {
  exec(cmd: string, opts?: ExecOptions): Promise<{ exitCode: number; output: string }>
  readFile(path: string): Promise<Buffer>
  writeFile(path: string, bytes: Buffer): Promise<void>
  mkdir(path: string): Promise<void>
}
```

```ts
import { createSyncEngine } from '@cowork/agent-fs/sync'

const engine = createSyncEngine({ session: fs, target: myBlaxelTarget, root: '/work' })

await engine.materialize() // Phase 1: real files under /work/<mountKey>/…; warm re-acquire ≈0.1s
// point the agent's cwd at /work — its default file tools now just work

await engine.captureAfterExec() // Phase 3: after every shell-capable tool call (fire-and-forget)
await engine.reconcile() // Phase 4: at turn end (authoritative; picks up deletes)
```

What the engine guarantees (§7.2):

- File-tool writes go **kernel-first** — durable before the mirror; sandbox death loses at most the exec in flight (R4).
- Exec capture is sha-diffed and **server-verified** — a lying sandbox can only corrupt its own branch content, never CAS identity.
- Read-only mounts are materialized read-only; captured changes to them are skipped and reported.
- Branch views are immutable mid-run: parent changes arrive at merge, never as a live refresh.
- Renames appear as delete+create. Deletes are detected at reconcile, not incrementally.
- Sandbox needs GNU coreutils (`sha256sum`, `find`) — probed loudly at materialize, not silently at capture.

### D. Staged writers & approvals

When the executing user's grant is `write: 'staged'`, their work lands only via an approver (§5.4):

```ts
const results = await fs.merge() // → 'pendingApproval'
// later, in your approval UI/flow:
await fs.merge({ approver: { id: admin.id, tenant: org.id } }) // approver's LIVE grant must be 'direct'
```

## Storage backends

The package ships no storage SDK. You inject the `BlobStore` SPI (§10b.3):

```ts
interface BlobStore {
  put(key: string, bytes: Buffer): Promise<void> // idempotent
  head(key: string): Promise<{ sizeBytes: number } | null>
  get(key: string): Promise<Readable>
  delete(key: string): Promise<void> // best-effort (GC)
  list?(prefix: string): Promise<readonly { key: string; lastModified: Date | string }[]> // orphan sweep
  presignPut(key: string, opts: { ttlSeconds: number; checksumSha256: string }): Promise<string>
  presignGet(key: string, opts: { ttlSeconds: number }): Promise<string>
}
```

Any S3-compatible store satisfies it — AWS S3, **MinIO** (`endpoint` + `forcePathStyle: true`), Cloudflare R2, Garage. Notes:

- Keys live under `afs/<tenant>/<sha256>`; the package never touches anything outside `afs/`.
- `presignPut` **must** pin `x-amz-checksum-sha256` as a signed header — the store itself rejects non-matching bytes (S3 and MinIO enforce this). It is part of the trust model (§7.2 step 4), not an optimization.
- Presigned URLs embed the endpoint host (SigV4 signs `Host`). Sandbox direct upload therefore requires the blob endpoint to be **reachable from the sandbox network** — a LAN-only MinIO downgrades large-blob capture to the server-relay path automatically.
- Large media streams via presigned I/O end to end; blob bytes never buffer through server memory (R11).

## Maintenance: migrate, gc, verify

```ts
await agentFs.migrate() // package-owned, numbered, idempotent (§10b.2)

await agentFs.gc() // reachability GC (§4.8): five sweeps incl. orphaned
// object-storage uploads; single-flight per tenant;
// settled branches reclaimed after 7 days; tags never

const report = await agentFs.verify() // fsck (§4.9): recompute tree/commit hashes, diff heads
// vs tips, spot-check object storage, check parents[]
// integrity. Schedule it — receipts nobody audits are
// not receipts.
```

Run `gc` on a schedule from **one** worker role; concurrent invocations skip safely. `verify()` accepts `{ tenant, sample }` for targeted checks.

## Events

```ts
agentFs.onCommit((commit, changedPaths) => {
  // search indexing, UI refresh, render gates, memory extraction …
})
```

Hooks run **after** commit, queued; a hook failure is sent to the injected
`logger.error` (or process diagnostics when no logger is provided) and never
fails the write (§10). The package never knows its listeners.

## Error taxonomy

All errors are typed, exported, and carry `{ tenant, mount?, path?, ref? }` context (§9). Conflicts are a merge _result_, not an exception.

| Error                         | Meaning                                            | Retryable?                    |
| ----------------------------- | -------------------------------------------------- | ----------------------------- |
| `InvalidPathError`            | path rule violation (§4.3)                         | no                            |
| `InvalidMountKeyError`        | mount key rule violation (§4.4)                    | no                            |
| `InvalidCommitTimestampError` | timestamp is not canonical UTC milliseconds (§4.2) | no                            |
| `PermissionDeniedError`       | grant refused (read, write mode, or pinned mount)  | no — re-auth is a user action |
| `PreconditionFailedError`     | `ifSha` mismatch                                   | after re-read                 |
| `RefConflictError`            | ref CAS exhausted retries                          | yes (rare)                    |
| `NotFoundError`               | path/ref/commit absent                             | no                            |
| `BranchSettledError`          | write to a merged/abandoned branch                 | no — open a new session       |
| `MergePendingApprovalError`   | staged writer attempted self-merge                 | no — needs an approver        |
| `GrantResolverError`          | your resolver threw/timed out (failed **closed**)  | host-side issue               |
| `StorageError`                | object storage failure                             | yes, with backoff             |
| `SchemaDriftError`            | frozen package schema differs from live Postgres   | no — repair schema            |
| `InvariantError`              | internal content-addressed state is impossible     | no — investigate              |

## Rules & guarantees

- **Durable per operation.** A resolved write is committed in Postgres. Mirrors, heads, and indexes are rebuildable caches.
- **Append-only history.** No force-push, no commit mutation; restore/undo are new commits.
- **Fail closed everywhere** — grants, path validation, sandbox input.
- **Case-sensitive paths**, no symlinks in the model; heads-up for hosts developing on case-insensitive filesystems.
- **Small working sets by design** (dozens of files per mount; R8) — correctness over throughput. Large binaries go through presigned streaming, not through trees of thousands of entries.
- **One-way dependency**: your app imports this package; the package imports nothing of yours — everything crosses as injected interfaces.

## Milestone availability

| API surface                                                                         | Available from |
| ----------------------------------------------------------------------------------- | -------------- |
| Kernel (schema, hashing, write, fork, GC)                                           | M0             |
| `open()`, file API, `discard`, history/timeline/diff, direct adapter, GrantResolver | M1             |
| Sync engine + `SyncTarget` (sandboxed agents)                                       | M2             |
| Multi-mount follow/pin, `merge`/`resolveMerge`, staged approvals, `restore`/`tag`   | M3             |
| Large-blob presigned streaming                                                      | M4             |
| Standalone npm publish                                                              | M5             |

## Development

- Docs discipline is binding (spec §15.7): exported symbols carry TSDoc citing their spec section; README updates ship in the same PR as API changes; README examples are compiled in a test.
- Tests: golden-value tests pin the hash byte formats forever; property tests cover the DAG; the §8 decision table and §9 taxonomy get one test per row/error; integration tests run against real Postgres (and MinIO) containers.
- Iterate with the package suite only: `pnpm --filter @cowork/agent-fs test`.
- The hermetic `test` script never connects to Postgres. For integration checks, start a disposable database (`docker run --rm --name agent-fs-it -e POSTGRES_USER=agentfs -e POSTGRES_PASSWORD=agentfs -e POSTGRES_DB=agentfs_it -p 55434:5432 postgres:16-alpine`), then run `AGENT_FS_DATABASE_URL=postgresql://agentfs:agentfs@127.0.0.1:55434/agentfs_it pnpm test:integration` from this package. Do not point it at Cowork development or production databases.
- Run the focused GC/verify integration tests against a disposable database:
  `AGENT_FS_DATABASE_URL=postgresql://agentfs:agentfs@127.0.0.1:55434/agentfs_it pnpm test:integration -- --test-concurrency=1`.
- `gc({ tenant })` acquires a non-blocking per-tenant advisory lock; a busy scoped invocation returns `{ skipped: true, skippedTenants: [tenant] }`. An unscoped run reports busy tenants in `skippedTenants` and sets `skipped` only when no tenant ran.
- `verify({ tenant, sample })` returns typed findings as data and does not abort when one record is corrupt; `sample` randomizes tree, commit, and CAS checks while ref/head drift remains full-scope.
- Run the real-database smoke demo with `AGENT_FS_DATABASE_URL=postgresql://agentfs:agentfs@127.0.0.1:55434/agentfs_it pnpm demo`.
