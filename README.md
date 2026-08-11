# tuddofs

`tuddofs` is a multi-tenant, permission-confined, branchable filesystem for AI agents. It stores content-addressed files and immutable history in PostgreSQL, with an optional object-storage backend for larger blobs. The package is an embeddable TypeScript library: your application supplies the PostgreSQL pool, actor identity, and grant resolver.

## Current status

The kernel and session layers are implemented and covered by unit and PostgreSQL integration tests. This release includes governed mounts, branch and commit history, merge and merge resolution, restore, tags, pinning, garbage collection, and verification.

The following are intentionally not promised features of this release:

- a sync engine for external workspaces;
- streaming large-blob reads and writes.

These boundaries are reflected in the exported API; do not build a production workflow around capabilities that are not listed there.

## Requirements

- Node.js 20 or newer
- PostgreSQL 13 or newer
- A PostgreSQL-compatible driver and pool supplied by the host application. The examples use `pg`, but `tuddofs` keeps it out of its runtime dependencies so hosts can use another structurally compatible pool.
- Optional object storage implementing the exported `BlobStore` interface

## Install

```bash
npm install tuddofs pg
```

`tuddofs` owns its PostgreSQL schema. Its tables use the `tuddo_*` prefix and are created by `migrate`; they do not require an ORM migration in the host application.

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
    mounts: [{ key: mount }],
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
import { createTuddoFs, createDirectAdapter } from 'tuddofs'

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
  mounts: [{ key: mount }],
})
const tools = createDirectAdapter(session)
await tools.write_file({
  path: `${mount}:/notes/today.md`,
  content: 'Ship safely.\n',
})
console.log(await tools.read_file({ path: `${mount}:/notes/today.md` }))
await pool.end()
```

Set `TUDDOFS_DATABASE_URL` to a PostgreSQL connection string before running the example. The grant resolver is called for each protected operation and should be backed by the host application's authorization system.

## Core concepts

### Tenants and grants

Every operation carries an actor with an `id` and `tenant`. A host-provided `GrantResolver` decides whether that actor can read a mount and whether writes are `none`, `direct`, or `staged`. The kernel fails closed when the resolver throws or times out, and authorization is checked at the filesystem boundary rather than delegated to a caller convention.

### Mounts

A mount is addressed as `mount-key:/absolute/path`, for example `project:notes:/notes/today.md`. Sessions can open multiple mounts. A normal mount follows its branch, while a pinned mount addresses a selected commit. Virtual mounts can expose a host-managed read/list/write handler without putting those files in the versioned kernel tables.

### Commits and content addressing

Writes create immutable content-addressed blobs, trees, and commits. Tree and commit hashes are deterministic and the golden vectors in `fixtures/golden-hashes.json` pin their byte formats. Optimistic concurrency is available through `ifSha`, so a caller can reject an edit when the file changed since it was read.

### Branches and sessions

`fork` creates or reuses a tenant-and-mount branch for an agent session. The branch records provenance such as agent kind, thread ID, run ID, and author. An opened session gives the executing agent only the mounts and paths granted to its actor; it does not expose the host application's other data.

## Security model

The host-supplied grant resolver is the policy authority and a trust boundary: `tuddofs` does not infer permissions from a caller's mount list or actor claims. It is consulted at the filesystem boundary for each protected operation. A resolver result is cached only within the process, for at most 30 seconds by default, so a revocation can have a bounded 30-second enforcement window. Call `fs.invalidate(actorId, mountKey, tenant)` when a host revokes access to clear the matching cache entries immediately.

Authorization fails closed. Resolver exceptions, timeouts, malformed results, and omitted permissions become denial rather than ambient access. Keep the resolver close to the host authorization system, and treat its inputs and outputs as security-sensitive. The migration also requires permission to create and inspect the package-owned `tuddo_*` tables in the configured schema; it claims that namespace for the package and should not be shared with unrelated tables.

## API surface

The package entry point exports:

- `createTuddoFs(options)` — construct the kernel with a PostgreSQL-compatible pool, required grants, optional blob storage, and lifecycle hooks.
- `migrate()` and `tuddoFsDdl` — create or inspect the package-owned `tuddo_*` schema.
- Kernel operations — `fork`, `read`, `write`, `delete`, `gc`, and `verify`.
- `open(input)` — create a session with an actor, session ID, and mount list.
- Session file operations — `read`, `readBytes`, `write`, `edit`, `list`, `glob`, `stat`, `delete`, `history`, `timeline`, `diff`, `merge`, `resolveMerge`, `restore`, `tag`, and `discard`.
- `createDirectAdapter(session)` — expose the session's basic file operations as direct tool-shaped functions for an agent loop.
- `BlobStore` and related types — integrate object storage for blobs that do not fit the inline threshold.
- Deterministic hashing helpers — `sha256`, `treePreimage`, `hashTree`, `commitPreimage`, and `hashCommit`.
- Typed errors — including `PermissionDeniedError`, `PreconditionFailedError`, `NotFoundError`, `RefConflictError`, `SchemaDriftError`, and `StorageError`.

The TypeScript declarations in `dist/index.d.ts` are the authoritative details for option and result shapes.

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
