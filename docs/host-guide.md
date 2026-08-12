# Host integration guide

Everything `tuddofs` expects the embedding application to own. The [README](../README.md) is the API contract; this guide is the operational one. Both are gated in CI: every TypeScript block below is compiled against the shipped declarations, so an example that drifts from the API fails the build.

Architecture references are to [`architecture.md`](../architecture.md).

## The obligations, in one list

| Obligation                            | Why it cannot be the package's job                                                               | Section                                           |
| ------------------------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------- |
| Supply a grant resolver               | The package has no idea what your permissions mean; it only knows how to fail closed             | [Grant resolver](#grant-resolver)                 |
| Call `invalidate()` on revocation     | Revocations happen in your authorization system, not in a filesystem call                        | [Revocation](#revocation-and-the-30-second-bound) |
| Schedule `gc()`                       | Nothing in the package runs on a timer; an unscheduled GC means storage grows forever            | [Maintenance](#scheduled-maintenance)             |
| Schedule `verify()`                   | Content addressing is a commitment only if something recomputes it                               | [Maintenance](#scheduled-maintenance)             |
| Wire `onCommit`                       | The package never knows its listeners (§10 rule 4)                                               | [onCommit](#oncommit)                             |
| Authorize virtual-mount handlers      | Virtual data is yours; the kernel stores none of it and can check nothing about it               | [Virtual mounts](#virtual-mounts)                 |
| Choose the large-blob transport       | SigV4 presigned URLs embed the endpoint host; only you know your network topology                | [Object storage](#object-storage-and-presigning)  |
| Decide what a sync target may execute | `exec` runs a real shell as the target's user; confinement is the sandbox's job, not the mount's | [Sync engine](#sync-engine-hosting)               |

## Construction

One `createTuddoFs` per process is the intended shape: it owns the grant cache, and a second instance means a second cache with its own TTL.

```ts
import { Pool } from 'pg'
import { createTuddoFs, type BlobStore, type CommitEvent, type GrantResolver } from 'tuddofs'

declare const grants: GrantResolver
declare const storage: BlobStore
declare function publishCommit(event: CommitEvent): void

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 10 })

export const fs = createTuddoFs({
  pool,
  grants,
  // Optional. Without it, blobs over `inlineMaxBytes` are refused rather than
  // silently inlined, and the streaming and presign methods are unavailable.
  storage,
  // Receives post-commit hook failures and other non-fatal errors. Without it
  // they go to `console.error`.
  logger: { error: (error, context) => console.error(error, context) },
  // Post-commit, queued, never able to fail a write.
  onCommit: publishCommit,
  // The package-owned `tuddo_*` tables live here. Defaults to `public`.
  schema: 'public',
})

await fs.migrate()
```

`migrate()` is idempotent, safe to call on every boot, and it is where a schema that has drifted from the pinned DDL surfaces as `SchemaDriftError` (§4.1). Run it at startup or from a deploy step — never lazily on the request path.

The `tuddo_*` namespace inside the configured schema belongs to the package. Do not point `schema` at a namespace that also holds your own tables.

## Grant resolver

The resolver is the whole security model (§5). It is called at the filesystem boundary for every protected operation, with the executing actor and the mount being addressed.

```ts
import { type Actor, type GrantResolver, type WriteMode } from 'tuddofs'

declare function loadMembership(
  actor: Actor,
  mountKey: string,
): Promise<{ role: 'viewer' | 'editor' | 'contributor' } | null>

export const grants: GrantResolver = {
  async resolve(actor, mount) {
    // An unmounted read arrives as the empty key. Deny it unless you genuinely
    // support reads outside the session's mount table.
    if (mount.key === '') return { read: false, write: 'none' }

    const membership = await loadMembership(actor, mount.key)
    if (membership === null) return { read: false, write: 'none' }

    const write: WriteMode =
      membership.role === 'editor' ? 'direct' : membership.role === 'contributor' ? 'staged' : 'none'
    return { read: true, write }
  },
}
```

Rules that are enforced, not advisory:

- **Fail closed.** A throw, a timeout (5 s default, `grantTimeoutMs`), or a malformed result becomes `GrantResolverError` and denies the operation. Never catch your own authorization errors and return an allow.
- **Never derive permission from the request.** The mount list on `open()`, the actor's claims, and anything a model produced are inputs to be checked, not evidence. Scope identity is server-derived (§5 rule 7).
- **Keep it close to the authorization system.** The resolver should be the same code path your HTTP layer uses. A second, parallel copy of the policy is a second thing to forget to update.
- **Keep it fast and available.** It sits in front of every read and write. A resolver that depends on a service with a worse SLA than your database makes that service's outage a filesystem outage — deny is the only safe fallback, so cache inside your own authz layer rather than lengthening the tuddofs TTL.
- **Treat inputs and outputs as security-sensitive.** Do not log grant results at debug level next to actor identifiers you would not log otherwise.

`staged` never escalates: merging a staged branch requires an `approver` whose live grant resolves to `direct`, in the same tenant, re-resolved inside the merge transaction (§5 rule 4).

### Revocation and the 30-second bound

Results are cached per process for at most 30 seconds. The cap is enforced in code: `grantCacheTtlMs` above `30000` throws `RangeError` at construction. Fork and merge always bypass the cache.

```ts
import { type TuddoFs } from 'tuddofs'

declare const fs: TuddoFs
declare const broadcast: (channel: string, payload: string) => Promise<void>

/** Call from wherever your application revokes access. */
export async function onAccessRevoked(actorId: string, mountKey: string, tenant: string): Promise<void> {
  fs.invalidate(actorId, mountKey, tenant) // this worker, immediately
  await broadcast('tuddofs:invalidate', JSON.stringify({ actorId, mountKey, tenant }))
}

/** Subscribers on every other worker run the same call. */
export function onInvalidateMessage(fs: TuddoFs, payload: string): void {
  const { actorId, mountKey, tenant } = JSON.parse(payload) as {
    actorId: string
    mountKey?: string
    tenant?: string
  }
  fs.invalidate(actorId, mountKey, tenant)
}
```

**`invalidate()` is process-local.** It clears the calling process's cache and nothing else. Under multiple workers you have two honest options:

1. Accept the bound. A revocation takes effect everywhere within the TTL — at most 30 seconds, and immediately for fork and merge. For most products this is the right answer, and it is the reason the TTL is capped rather than configurable upward.
2. Fan the invalidation out yourself, as above, over whatever pub/sub you already run (Postgres `LISTEN/NOTIFY`, Redis, your message bus). Best-effort delivery is fine: the TTL is still the backstop.

Do not attempt a third option. Lengthening the TTL to reduce resolver load trades a security bound for a performance one, and the code will not let you. If resolver load is the problem, cache inside the resolver.

Omitting arguments widens the sweep: `invalidate(actorId)` clears every mount and tenant for that actor, `invalidate(actorId, mountKey)` every tenant for that pair. A tenant-wide policy change is best handled by invalidating each affected actor; there is no "clear everything" verb, because a global flush hides the revocation path you actually needed to wire.

## Scheduled maintenance

Nothing in the package runs on a timer. `gc()` and `verify()` are host-scheduled (§10).

```ts
import { createTuddoFs, type GcReport, type GrantResolver, type TuddoFsPool, type VerifyReport } from 'tuddofs'

declare const pool: TuddoFsPool
declare const grants: GrantResolver
declare function alert(summary: string, detail: unknown): void

const fs = createTuddoFs({ pool, grants })

export async function maintenanceCycle(tenants: readonly string[]): Promise<void> {
  for (const tenant of tenants) {
    const collected: GcReport = await fs.gc({ tenant })
    // Another worker holds this tenant's lock. A skip is normal; a tenant that
    // skips every cycle for a day is a stuck worker.
    if (collected.skipped) continue

    const audit: VerifyReport = await fs.verify({ tenant, sample: 500 })
    if (!audit.ok) alert(`tuddofs verify found ${audit.findings.length} findings in ${tenant}`, audit.findings)
  }
}
```

Run it from whatever scheduler you already have. A worker process:

```ts
declare function maintenanceCycle(tenants: readonly string[]): Promise<void>
declare function activeTenants(): Promise<readonly string[]>
declare function report(error: unknown): void

const HOUR = 60 * 60 * 1000
const timer = setInterval(() => {
  void maintenanceCycle([]).catch(report)
}, 6 * HOUR)
timer.unref()

void activeTenants()
```

Or as a standalone job, with nothing but the published package and a driver. This is the whole scheduled half of the deployment; it runs against the same database your application already migrated:

```bash
cat > tuddofs-maintenance.mjs <<'EOF'
import { Pool } from 'pg'
import { createTuddoFs } from 'tuddofs'

const pool = new Pool({ connectionString: process.env.TUDDOFS_DATABASE_URL })
// gc() and verify() address no mount on behalf of an actor, so they never
// consult the resolver. A deny-all resolver keeps that true by construction.
const fs = createTuddoFs({
  pool,
  grants: { resolve: () => Promise.resolve({ read: false, write: 'none' }) },
})

try {
  const collected = await fs.gc()
  const audit = await fs.verify({ sample: 500 })
  console.log(
    JSON.stringify({
      collectedBlobs: collected.deletedBlobs,
      collectedObjects: collected.deletedObjects,
      settledBranches: collected.settledBranches,
      skippedTenants: collected.skippedTenants,
      verifyOk: audit.ok,
      findings: audit.findings.length,
    }),
  )
  // A non-zero exit is what your scheduler alerts on.
  if (!audit.ok) process.exitCode = 1
} finally {
  await pool.end()
}
EOF
TUDDOFS_DATABASE_URL="postgresql://user:password@127.0.0.1:5432/app" node tuddofs-maintenance.mjs
```

Invoked from cron, a Kubernetes `CronJob`, or any scheduler you already run:

```bash
# /etc/cron.d/tuddofs — 03:17 daily, jittered away from the top of the hour
17 3 * * * app cd /srv/app && node ./tuddofs-maintenance.mjs >> /var/log/tuddofs-maintenance.log 2>&1
```

What to know before you schedule:

- **GC is single-flight per tenant.** A worker that cannot take `pg_try_advisory_lock` for a tenant _skips_ it — it never queues, and never blocks. Overlapping schedules are safe; they just do less work. `skipped` is true only when no tenant in scope could run, and `skippedTenants` names them.
- **Grace windows are the safety margin, not a tuning knob.** Unreferenced objects are collected only after `graceMs` (24 h default) and settled branches after `settledBranchRetentionMs` (7 d). Shrinking them to reclaim storage sooner shortens the window in which an in-flight write's blob is protected before its commit lands.
- **Run GC per tenant on a large deployment.** `gc()` with no tenant walks every tenant it discovers in one call. Passing `tenant` lets you spread the work, parallelize across workers, and keep one pathological tenant from delaying the rest.
- **`verify()` returns findings as data; it never throws for corruption.** `ok === false` with an empty `findings` array is impossible — if you see findings, page someone. `sample` bounds the tree, commit, and CAS spot checks; ref/head drift is always full-scope, so a small sample still audits the index that reads depend on.
- **Alert on the findings, not on the run.** `heads-drift` and `tree-coherence` findings affect what sessions can read right now. `storage-missing` means a blob's object is gone, which is data loss you want to hear about the same day. `dangling-parent` and `orphaned-head` are integrity bugs worth an issue, not a page.
- **A `verify()` that has never run is a receipt chain nobody audits.** Daily is a reasonable default; weekly with a full `sample` on a quiet tenant is also defensible. Never is not.

## onCommit

`onCommit` is the whole product-integration surface for writes (§10 rule 4). It is dispatched after the commit transaction has committed, on `setImmediate`, so a slow or throwing handler cannot fail or delay the write. Failures are logged through `logger` and swallowed.

```ts
import type { CommitEvent } from 'tuddofs'

declare function enqueue(job: { type: string; payload: CommitEvent }): Promise<void>
declare function report(error: unknown): void

export function onCommit(event: CommitEvent): void {
  // { tenant, mount, ref, commitSha, changedPaths }
  void enqueue({ type: 'tuddofs.commit', payload: event }).catch(report)
}
```

Consequences worth designing for:

- **Delivery is best-effort and in-process.** A crash between the commit and the callback drops the event. If your listener must not miss a commit, enqueue durably (outbox table, queue) inside the handler and treat the commit history as the source of truth for reconciliation — `session.timeline()` replays what happened.
- **Handlers must be non-blocking and idempotent.** Hand off to a queue; do not do the work inline. The same commit can be observed twice by a reconciling consumer.
- **There is no merge-policy hook, by decision (§9).** When and with which approver to call `merge()` is host logic, and a second hook would add surface for no capability.

## Virtual mounts

A virtual mount serves live host data through the same file surface, with no refs, commits, or history (§6.1).

```ts
import { NotFoundError, type Actor, type VirtualEntry, type VirtualMountHandler } from 'tuddofs'

declare function mayReadTicket(actor: Actor, id: string): Promise<boolean>
declare function listTickets(actor: Actor): Promise<readonly { id: string; body: string }[]>
declare function loadTicket(id: string): Promise<{ id: string; body: string } | null>

export const ticketsMount: VirtualMountHandler = {
  async list(dir, actor) {
    if (dir !== '/') return []
    const tickets = await listTickets(actor)
    return tickets.map<VirtualEntry>(ticket => ({
      path: `/${ticket.id}.md`,
      type: 'file',
      sizeBytes: Buffer.byteLength(ticket.body),
    }))
  },
  async read(path, actor) {
    const id = path.replace(/^\/|\.md$/gu, '')
    // Authorization is the handler's job, and it fails closed.
    if (!(await mayReadTicket(actor, id))) throw new NotFoundError(`no such ticket: ${id}`, { tenant: actor.tenant })
    const ticket = await loadTicket(id)
    return ticket === null ? null : Buffer.from(ticket.body)
  },
}
```

Handler rules:

- **The handler is the authorization boundary.** It is invoked with the executing actor and must fail closed. The grant resolver still gates the mount itself, but nothing inside the package can check a path you invented.
- **Deny by throwing or returning `null`.** Never return another tenant's bytes because the path looked plausible. Prefer `NotFoundError` over `PermissionDeniedError` when existence itself is sensitive.
- **No versioning verbs.** `merge`, `history`, `restore`, and `tag` throw for virtual mounts rather than returning empty results. Do not build a UI that expects history on one.
- **The sync engine skips them entirely.** Virtual mounts are never materialized, never captured, and rejected in mirror-path mapping — a copy of live data is stale by definition. If an agent needs virtual data on disk, it reads it through the session and writes it into a governed mount deliberately.
- **`write` is optional and means "apply to my system".** A handler without `write` is read-only, and the live write mode reported by `session.mounts()` is `none`.

## Object storage and presigning

Core ships no storage SDK. `BlobStore` is a five-verb SPI; the reference implementation is [`@tuddofs/s3`](../packages/s3/README.md).

- **Without `storage`, everything is inline.** Blobs above `inlineMaxBytes` (128 KiB) are rejected rather than stuffed into Postgres. Any deployment expecting real files wants a store.
- **Presigned URLs embed the endpoint host (§8.3).** SigV4 signs the host, so a URL your server can use is not automatically a URL your _target_ or _browser client_ can use. A LAN-only MinIO means client-direct I/O and target-direct capture are both unavailable, and the honest configuration is the server-relay path.
- **Decide the transport, do not detect it.** The sync engine's `largeBlobs.transport` defaults to `'relay'`. Set `'presigned'` only when the blob endpoint is reachable from the target's network; a `'presigned'` engine whose store cannot presign fails the capture loudly instead of quietly relaying gigabytes.
- **Checksum enforcement is the identity binding.** A PUT presign pins `x-amz-checksum-sha256` as a signed header, so the store itself rejects bytes that hash differently. On a store that cannot enforce it, uploads land at a quarantine key and are re-hashed server-side before the CAS copy. Existence and size are never verification.
- **Never delete keys outside `tuddo/`.** GC's orphan-object sweep only ever lists and deletes under `tuddo/<tenant>/`; a bucket lifecycle rule you add yourself has no such restraint.

## Sync engine hosting

The engine (`tuddofs/internal`) materializes governed mounts onto a real disk. See the README for the API; the host-side obligations are:

- **`exec` confines the filesystem, not the host.** `readFile`, `writeFile`, and `mkdir` refuse paths outside the workspace root and never follow a symlink out of it. `exec` runs a real shell as the target's user, with that user's network and credentials. For the local target, that user is your server process. Untrusted code gets a sandbox and its own target — this is a deployment decision the package cannot make for you.
- **Targets need GNU coreutils.** `materialize()` probes for them and fails at acquire rather than capturing nothing later. Busybox images do not qualify.
- **Call `reconcile()` at turn end.** Deletions are applied only there. An agent loop that never reconciles accumulates files the kernel still believes exist.
- **Handle `onCaptureFailed`.** A failed scan is an error event, never an empty diff. Surface it; a target that has stopped capturing looks exactly like an agent that stopped writing.
- **One workspace per session.** Warm re-acquire is index-driven and cheap; sharing a root between sessions is not a supported configuration.

## Error taxonomy and recovery

Every exported error maps to one recovery. Switch on the class, never on the message.

| Error                         | Meaning                                                              | Host recovery                                                                           |
| ----------------------------- | -------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `PermissionDeniedError`       | Live grant denied the operation                                      | Surface to the user; do not retry                                                       |
| `GrantResolverError`          | Resolver threw, timed out, or returned garbage — failed CLOSED       | Alert; this is your authz path failing, not a filesystem fault                          |
| `PreconditionFailedError`     | `ifSha` did not match the current head                               | Re-read and re-apply, or report a conflict to the caller                                |
| `EditMatchError`              | `edit()` matched zero or several times                               | Feed the match count back to the agent; do not fall back to `write`                     |
| `InvalidPathError`            | Path rejected, or a tree-coherence collision                         | Fix the path; nothing "repairs" it. Delete the colliding entry first                    |
| `InvalidCommitTimestampError` | Commit timestamp is not canonical ISO-8601 UTC millisecond precision | Fix the injected clock; the §4.2 preimage is pinned forever and accepts no other format |
| `InvalidMountKeyError`        | Mount key outside the §4.4 charset                                   | Fix the mount table; keys are embedded in refs and mirror paths                         |
| `NotFoundError`               | Path, commit, or mount not reachable from this session               | Treat as absent; it is also the safe answer for "exists elsewhere"                      |
| `BranchSettledError`          | The session's branch is merged, abandoned, or conflicted             | Open a new session — the message says so; never a dead end                              |
| `MergePendingApprovalError`   | A staged branch needs a `direct` approver                            | Route to approval; re-run `merge({ approver })`                                         |
| `RefConflictError`            | CAS ref update lost its races                                        | Retry the operation; persistent means write contention to fix                           |
| `SchemaDriftError`            | Deployed `tuddo_*` schema differs from the pinned DDL                | Stop the rollout. Do not hand-patch tables                                              |
| `StorageError`                | Object store failed or returned inconsistent bytes                   | Retry, then alert; `verify()` will show the blast radius                                |
| `InvariantError`              | The package caught itself violating its own model                    | File a bug with the context object; do not retry                                        |
| `SyncTargetError` (internal)  | A target op failed — probe, scan, stamp, read                        | Re-materialize the workspace or replace the target                                      |

Merge conflicts are **not** exceptions: `merge()` returns `{ status: 'conflicts', conflicts }` as data, and resolving them is host UX (§15.2).

## Production checklist

- [ ] `migrate()` runs at deploy or boot, never lazily on a request.
- [ ] The resolver is backed by the live authorization system and denies the empty mount key.
- [ ] Revocations call `invalidate()`, and multi-worker deployments either fan it out or have accepted the 30-second bound in writing.
- [ ] `gc()` is scheduled, per tenant on large deployments, with skips monitored.
- [ ] `verify()` is scheduled, with `ok === false` wired to an alert.
- [ ] `onCommit` hands off to a durable queue and never blocks.
- [ ] Storage is configured, or every write is knowingly under 128 KiB.
- [ ] `largeBlobs.transport` matches the actual network path between target and blob endpoint.
- [ ] Untrusted agent code runs against a sandboxed target, not the local-directory one.
- [ ] Error handling switches on the exported classes above.
