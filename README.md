# tuddofs

`tuddofs` is a multi-tenant, permission-confined, branchable filesystem for AI agents. It stores content-addressed files and immutable history in PostgreSQL, with an optional object-storage backend for larger blobs. The package is an embeddable TypeScript library: your application supplies the PostgreSQL pool, actor identity, and grant resolver.

## Current status

The kernel and session layers are implemented and covered by unit and PostgreSQL integration tests. This release includes governed mounts, branch and commit history, merge and merge resolution, restore, tags, pinning, garbage collection, verification, and object-storage streaming.

A sync engine that materializes governed mounts into a real directory, plus a local-directory target and an SSH target for it, are implemented and exercised by the kill-matrix acceptance suite — the same suite, run against both targets. They are published through the explicit `tuddofs/internal` subpath rather than the main entry point, because the main entry point is a deliberately fixed Tier-1 surface; see [Sync engine](#sync-engine).

The following are intentionally not promised features of this release:

- sandbox-provider sync targets (E2B, Blaxel, and the like);
- multipart object-storage upload.

The mount-handle streaming methods require a `BlobStore` with stream-capable `put`, server-side `copy`, and the relevant presign method. `session.mount(key).readStream(path)` returns a Node `Readable`; `writeStream(path, source)` hashes into a quarantine key while holding the same tenant GC lease as kernel writes, promotes to `tuddo/<tenant>/<sha256>`, then commits. `presign(path, { method: 'GET' })` returns a read URL. PUT requires a lowercase hexadecimal `{ method: 'PUT', sha256 }` and returns `{ url, headers, checksumEnforced: true }`; clients must send the returned `x-amz-checksum-sha256` header. Core converts the CAS hash to S3's base64 checksum format and rejects adapters whose result does not sign that header or whose store cannot enforce uploaded-byte checksums. Missing or non-enforcing storage capabilities fail with `StorageError`.

These boundaries are reflected in the exported API; do not build a production workflow around capabilities that are not listed there.

## Requirements

- Node.js 20 or newer
- PostgreSQL 13 or newer
- A PostgreSQL-compatible driver and pool supplied by the host application. The examples use `pg`, but `tuddofs` keeps it out of its runtime dependencies so hosts can use another structurally compatible pool.
- Optional object storage implementing the exported `BlobStore` interface
- An `ssh` client binary, only for the SSH sync target; it is spawned, never bundled

The reference S3-compatible implementation is published separately:

```bash
npm install @tuddofs/s3
```

It implements the structural `BlobStore` SPI for AWS S3, MinIO, and Cloudflare R2. See [`packages/s3/README.md`](./packages/s3/README.md) for endpoint configuration, checksum-bound presigned PUTs, and the SigV4 host-reachability caveat.

## Install

```bash
npm install tuddofs pg
```

`tuddofs` owns its PostgreSQL schema. Its tables use the `tuddo_*` prefix and are created by `fs.migrate()`; they do not require an ORM migration in the host application.

Migrations and kernel connections default to the `public` schema. Set `schema` on `createTuddoFs` when the package-owned tables belong in another PostgreSQL schema; `fs.migrate()` and every operation use that schema.

## Quickstart

Run this from an empty directory. It installs the published package and its example PostgreSQL driver; no repository checkout or build step is required:

```bash
set -eu
PORT="${TUDDOFS_QUICKSTART_PORT:-55771}"
CONTAINER="tuddofs-quickstart-$$"
WORKDIR="$(mktemp -d)"
trap 'docker rm --force "$CONTAINER" >/dev/null 2>&1 || true; rm -rf "$WORKDIR"' EXIT

cd "$WORKDIR"
npm init --yes
npm install tuddofs pg

cat > demo.mjs <<'EOF'
import { Pool } from 'pg'
import { createDirectAdapter, createTuddoFs } from 'tuddofs'

const pool = new Pool({ connectionString: process.env.TUDDOFS_DATABASE_URL })
const tenant = 'quickstart'
const mount = 'project:notes'
const fs = createTuddoFs({
  pool,
  grants: {
    resolve(actor, requestedMount) {
      return Promise.resolve(
        actor.tenant === tenant && requestedMount.key === mount
          ? { read: true, write: 'direct' }
          : { read: false, write: 'none' },
      )
    },
  },
})

try {
  await fs.migrate()
  const session = await fs.open({
    actor: { id: 'quickstart-agent', tenant },
    sessionId: 'quickstart-run',
    mounts: [mount],
  })
  const tools = createDirectAdapter(session)
  await tools.write_file({ path: `${mount}:/notes/today.md`, content: 'Ship safely.\n' })
  console.log(await tools.read_file({ path: `${mount}:/notes/today.md` }))
} finally {
  await pool.end()
}
EOF

docker run --rm --detach --name "$CONTAINER" \
  --env POSTGRES_USER=tuddofs \
  --env POSTGRES_PASSWORD=tuddofs \
  --env POSTGRES_DB=tuddofs_it \
  --publish "$PORT:5432" \
  postgres:16-alpine
until docker exec "$CONTAINER" pg_isready -U tuddofs -d tuddofs_it >/dev/null 2>&1; do sleep 1; done
TUDDOFS_DATABASE_URL="postgresql://tuddofs:tuddofs@127.0.0.1:${PORT}/tuddofs_it" node demo.mjs
```

The final command prints the file read through the governed session. The `grants` resolver in this example is the host application's policy boundary; see [Security model](#security-model).

For an application, the same setup can be embedded in your service code:

```ts
import { Pool } from 'pg'
import { createTuddoFs } from 'tuddofs'

const pool = new Pool({ connectionString: process.env.TUDDOFS_DATABASE_URL })
const tenant = 'acme'
const mount = 'project:notes'

const fs = createTuddoFs({
  pool,
  grants: {
    async resolve(actor, requestedMount) {
      return actor.tenant === tenant && requestedMount.key === mount
        ? { read: true, write: 'direct' }
        : { read: false, write: 'none' }
    },
  },
})

await fs.migrate()
const session = await fs.open({
  actor: { id: 'agent-1', tenant },
  sessionId: 'run-1',
  mounts: [mount],
})
const notes = session.mount(mount)
await notes.write('/notes/today.md', 'Ship safely.\n')
console.log(await notes.read('/notes/today.md'))
await pool.end()
```

Set `TUDDOFS_DATABASE_URL` to a PostgreSQL connection string before running the example. The grant resolver is called for each protected operation and should be backed by the host application's authorization system.

## Core concepts

### Tenants and grants

Every operation carries an actor with an `id` and `tenant`. A host-provided `GrantResolver` decides whether that actor can read a mount and whether writes are `none`, `direct`, or `staged`. The kernel fails closed when the resolver throws or times out, and authorization is checked at the filesystem boundary rather than delegated to a caller convention.

### Mounts

Sessions can open multiple mounts. Host code selects one with `session.mount(key)` and uses plain absolute paths such as `/notes/today.md`. A normal mount follows its branch, while a pinned mount addresses a selected commit. Virtual mounts can expose a host-managed read/list/write handler without putting those files in the versioned kernel tables. Compound `mount-key:/absolute/path` addressing is reserved for tool adapters such as `createDirectAdapter`.

### Commits and content addressing

Writes create immutable content-addressed blobs, trees, and commits. Tree and commit hashes are deterministic and the golden vectors in `fixtures/golden-hashes.json` pin their byte formats. Optimistic concurrency is available through `ifSha`, so a caller can reject an edit when the file changed since it was read.

### Tree coherence

Directories are implicit: trees store files only, and path segments synthesize the directory view. A tree cannot contain both a file and a descendant beneath that file, such as `/a` and `/a/x.md`. `write` and `edit` reject either direction of this collision with `InvalidPathError` naming the existing entry; delete the existing file first when intentionally replacing a file with a directory-shaped path or the reverse. A merge that would combine two coherent trees into an incoherent result returns conflicts for both paths and commits nothing. `verify()` reports incoherent ref-tip trees created before this enforcement.

### Branches and sessions

Opening a session creates or reuses a tenant-and-mount branch for the supplied `sessionId`. The branch records provenance such as agent kind, thread ID, run ID, and author. An opened session gives the executing agent only the mounts and paths granted to its actor; it does not expose the host application's other data.

## Security model

The host-supplied grant resolver is the policy authority and a trust boundary: `tuddofs` does not infer permissions from a caller's mount list or actor claims. It is consulted at the filesystem boundary for each protected operation. A resolver result is cached only within the process, for at most 30 seconds by default, so a revocation can have a bounded 30-second enforcement window. Call `fs.invalidate(actorId, mountKey, tenant)` when a host revokes access to clear the matching cache entries immediately.

Authorization fails closed. Resolver exceptions, timeouts, malformed results, and omitted permissions become denial rather than ambient access. Keep the resolver close to the host authorization system, and treat its inputs and outputs as security-sensitive. The migration also requires permission to create and inspect the package-owned `tuddo_*` tables in the configured schema; it claims that namespace for the package and should not be shared with unrelated tables.

## API surface

The main `tuddofs` entry point exports only the Tier-1 consumer surface:

- `createTuddoFs(options)` — returns `{ migrate, open, gc, verify, invalidate }`.
- `createDirectAdapter(session)` — exposes compound-addressed, tool-shaped file operations for an agent loop.
- Public option, session, mount-handle, result, grant, storage, and maintenance types.
- The typed error taxonomy: `InvalidPathError`, `InvalidMountKeyError`, `InvalidCommitTimestampError`, `PermissionDeniedError`, `PreconditionFailedError`, `RefConflictError`, `NotFoundError`, `BranchSettledError`, `MergePendingApprovalError`, `GrantResolverError`, `SchemaDriftError`, `StorageError`, `InvariantError`, and `EditMatchError`.

Low-level ref operations, deterministic hashing helpers, `GrantController`, migrations, validation functions, and the sync engine live under the explicit `tuddofs/internal` subpath. `session.mount(key)` owns plain-path file operations, including `readStream`, `writeStream`, and `presign`. Session `edit()` uses `{ oldText, newText, replaceAll? }`; `merge({ mounts?, approver? })` returns a discriminated status for each selected ref-backed mount. `session.mounts()` enumerates the session's mounts with their kind, pin state, and live write mode, and `session.mount(key).capture({ writes, deletes })` commits one workspace scan of that mount as a single commit — both exist for the sync engine and are not tool verbs.

The TypeScript declarations in `dist/index.d.ts` are the authoritative details for option and result shapes.

## Sync engine

The sync engine materializes a session's governed mounts into a real directory so shell tools work natively, and commits what they change back to the kernel. It is exported from `tuddofs/internal`:

```ts
import { createTuddoFs, type GrantResolver, type TuddoFsPool } from 'tuddofs'
import { createLocalDirectoryTarget, createSyncEngine } from 'tuddofs/internal'

declare const pool: TuddoFsPool
declare const grants: GrantResolver

const root = '/tmp/agent-workspace'
const fs = createTuddoFs({ pool, grants })
const session = await fs.open({
  actor: { id: 'agent-1', tenant: 'acme' },
  sessionId: 'run-1',
  mounts: ['project:notes'],
})
const engine = createSyncEngine({
  session,
  target: createLocalDirectoryTarget({ root }),
  root,
  events: {
    onCapture: event => console.log('committed', event.commitSha, event.paths),
    onCaptureFailed: event => console.error('capture attempt', event.attempt, event.error),
    onReadOnlySkipped: event => console.warn('read-only mount changed', event.mountKey, event.paths),
  },
})

await engine.materialize() // write the branch view into the workspace
await engine.write('project:notes', '/today.md', 'Ship safely.\n') // commits, then mirrors
await engine.exec('grep -r TODO .') // runs a real shell, then captures what it changed
await engine.reconcile() // authoritative end-of-turn scan, including deletions
```

The kernel stays the source of truth. A file tool commits before it touches the workspace, so a workspace that dies loses nothing already committed. Shell steps are captured asynchronously, one scan in flight at a time; the scan reports paths and mtimes, but every transfer decision is made on a server-side sha, and every captured path is re-validated against its mount's mirror directory. A scan that fails is reported through `onCaptureFailed`, never as "no changes". Deletions are applied only by `reconcile()`. Virtual mounts are never mirrored or captured.

Event handlers are host code and are treated as such: a handler that throws is caught, reported through the optional `logger` (falling back to `console.error`), and never aborts a capture or takes the process down. `createSyncEngine` accepts the same `logger` shape as `createTuddoFs`.

A tool write is protected from a mirror write that silently fails, but only until the next scan confirms the file on disk. That window is deliberate: once a scan has seen the committed bytes in the workspace, content matching the previous version is treated as a real change — a checkout, a formatter, an undo — and captured, not overwritten. The same protection is rebuilt from commit history when an engine re-attaches to an existing workspace, so a process that dies between a commit and its mirror write does not lose the write on the next `reconcile()`.

A target is the four-verb `SyncTarget` seam — `exec`, `readFile`, `writeFile`, `mkdir` — and the engine imports no target implementation and no provider SDK. Targets must provide GNU coreutils; `materialize()` probes for them and fails immediately if they are missing. Two targets ship: the local directory and SSH.

**Both targets confine the filesystem, not the host.** `readFile`, `writeFile`, and `mkdir` refuse any path outside the workspace root and never follow a symlink out of it, so a governed mount cannot be used to read or overwrite files elsewhere on the machine. `exec` has no such protection: it runs a real shell as the target's user, with that user's environment, filesystem, and network. Anything that user can do, a command run through the target can do. For the local target that user is your own host process; run untrusted code in a sandbox and give it its own target.

### SSH target

```ts
import { createSshTarget, createSyncEngine, type SessionFileSystem } from 'tuddofs/internal'

declare const session: SessionFileSystem

const root = '/srv/agents/run-1'
const target = createSshTarget({
  root,
  host: 'build-01.internal',
  user: 'agent',
  port: 22,
  identityFile: '/etc/tuddofs/agent_ed25519',
  knownHostsFile: '/etc/tuddofs/known_hosts',
})
const engine = createSyncEngine({ session, target, root })
```

Requirements, none of them a package dependency:

- An `ssh` client binary on the machine running `tuddofs` (`sshBinary` selects a specific one). The package spawns it rather than bundling a protocol implementation, which is how the core keeps zero runtime dependencies.
- Key-based, non-interactive authentication. `BatchMode=yes`, `PasswordAuthentication=no`, and `KbdInteractiveAuthentication=no` are fixed and cannot be overridden: an agent runtime that can block on a password prompt is a hung agent runtime. Host-key checking defaults to `StrictHostKeyChecking=yes`.
- A POSIX `sh` login shell and GNU coreutils on the remote host. A busybox host fails at `materialize()`, loudly, rather than silently capturing nothing later.

Every interpolated value — path, filename, command — is single-quoted for the remote shell, and paths are checked twice: lexically before anything reaches the network, and again on the host with `pwd -P`, which is what catches a symlinked directory pointing out of the workspace. The remote exit status is reported by the remote itself behind a per-exec nonce, because OpenSSH reports both "the command was killed by a signal" and "the transport failed" as exit 255; a command that never reported its status is a target error, never a plausible exit code. `exec` is bounded on the remote side with `timeout -s KILL`, since killing the local client leaves the remote command running.

There is no connection pooling: one ssh invocation per verb. A host that wants multiplexing passes it through as ordinary ssh configuration, for example `sshOptions: ['ControlMaster=auto', 'ControlPath=/tmp/tuddofs-%C', 'ControlPersist=60']`.

## Integration tests

Unit tests are hermetic and do not require PostgreSQL:

```bash
npm test
```

Integration tests require a disposable PostgreSQL 13 or newer container. They use `TUDDOFS_DATABASE_URL` and, with the default schema, verify that migrations create exactly these `tuddo_*` tables:

```text
tuddo_blobs
tuddo_commits
tuddo_heads
tuddo_migrations
tuddo_refs
tuddo_tree_entries
tuddo_trees
```

Run them as follows:

```bash
docker run --rm --detach --name tuddofs-it \
  --env POSTGRES_USER=tuddofs \
  --env POSTGRES_PASSWORD=tuddofs \
  --env POSTGRES_DB=tuddofs_it \
  --publish "${TUDDOFS_IT_PORT:-55771}:5432" \
  postgres:16-alpine
until docker exec tuddofs-it pg_isready -U tuddofs -d tuddofs_it >/dev/null 2>&1; do sleep 1; done
TUDDOFS_DATABASE_URL="postgresql://tuddofs:tuddofs@127.0.0.1:${TUDDOFS_IT_PORT:-55771}/tuddofs_it" npm run test:integration
docker rm --force tuddofs-it
```

The streaming acceptance suite starts and stops a pinned MinIO testcontainer itself. It defaults to a 2 GiB round trip, samples RSS continuously through upload and download, asserts a 384 MiB growth ceiling, verifies MinIO's real checksum-enforced PUT behavior, and removes its objects afterward. Supply only the disposable PostgreSQL URL:

```bash
TUDDOFS_DATABASE_URL="postgresql://tuddofs:tuddofs@127.0.0.1:${TUDDOFS_IT_PORT:-55771}/tuddofs_it" \
  npm run test:minio
```

Set `TUDDOFS_MINIO_STREAM_BYTES` to a positive byte count only for a smaller CI smoke run; the acceptance default remains exactly 2,147,483,648 bytes. The suite fails loudly rather than skipping when PostgreSQL or Docker is unavailable.

SigV4 presigned URLs embed their endpoint host. Client-direct I/O therefore requires the blob endpoint to be reachable from the client's network; otherwise the host must use the server-relay streaming path.

The SSH acceptance suite runs the same kill matrix as the local target over a real network. By default it builds `fixtures/sshd`, generates a throwaway ed25519 keypair, and starts and disposes its own uniquely named sshd container — twice: a GNU host for the matrix and a busybox host to prove the coreutils probe fails at acquire. It kills the real sshd where the matrix calls for a dead target.

```bash
TUDDOFS_DATABASE_URL="postgresql://tuddofs:tuddofs@127.0.0.1:${TUDDOFS_IT_PORT:-55771}/tuddofs_it" \
  npm run test:ssh
```

To run it against a machine you already have instead, set `TUDDOFS_SSH_HOST` and, as needed, `TUDDOFS_SSH_USER`, `TUDDOFS_SSH_PORT`, `TUDDOFS_SSH_IDENTITY`, `TUDDOFS_SSH_KNOWN_HOSTS`, and `TUDDOFS_SSH_ROOT` (default `/tmp/tuddofs-acceptance`). Workspaces are created and removed per case; the suite never kills a daemon it did not start. Like the MinIO suite, it fails loudly rather than skipping when its prerequisites are missing.

Never point these commands at a shared development or production database.

## Development commands

```bash
npm run format:check
npm run lint
npm run typecheck
npm run build
npm test
```

The package is published under the MIT license. See [LICENSE](./LICENSE).
