# tuddofs

`tuddofs` is a multi-tenant, permission-confined, branchable filesystem for AI agents. It stores content-addressed files and immutable history in PostgreSQL, with an optional object-storage backend for larger blobs. The package is an embeddable TypeScript library: your application supplies the PostgreSQL pool, actor identity, and grant resolver.

## Current status

The kernel and session layers are implemented and covered by unit and PostgreSQL integration tests. The following are **not yet complete features** and are not promised as production-ready in this release:

- a sync engine for external workspaces;
- merge workflows;
- restore, tags, and pin operations;
- streaming large-blob reads and writes.

The public API may contain experimental hooks around some of these areas while the contracts are being finished. Do not build a production workflow around them yet.

## Requirements

- Node.js 20 or newer
- PostgreSQL 16 or newer
- PostgreSQL's `pg` driver (installed as the package runtime dependency)
- Optional object storage implementing the exported `BlobStore` interface

## Install

```bash
npm install tuddofs pg
```

`tuddofs` owns its PostgreSQL schema. Its tables use the `tuddo_*` prefix and are created by `migrate`; they do not require an ORM migration in the host application.

## Quickstart

The repository includes a small demo that creates a tenant, opens a governed session, writes and edits a file, reads it back, and demonstrates mount confinement. Run it against a disposable PostgreSQL container:

```bash
npm install
npm run build

docker run --rm --detach --name tuddofs-quickstart \
  --env POSTGRES_USER=tuddofs \
  --env POSTGRES_PASSWORD=tuddofs \
  --env POSTGRES_DB=tuddofs_it \
  --publish 55434:5432 \
  postgres:16-alpine

until docker exec tuddofs-quickstart pg_isready -U tuddofs -d tuddofs_it >/dev/null 2>&1; do sleep 1; done
TUDDOFS_DATABASE_URL=postgresql://tuddofs:tuddofs@127.0.0.1:55434/tuddofs_it npm run demo
docker rm --force tuddofs-quickstart
```

The final command prints JSON containing the edited file, its listing, and `confined: true`. For an application, import from the package entry point after building or installing it:

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

## API surface

The package entry point exports:

- `createTuddoFs(options)` — construct the kernel with a `pg` pool, grants, optional blob storage, and lifecycle hooks.
- `migrate()` and `tuddoFsDdl` — create or inspect the package-owned `tuddo_*` schema.
- Kernel operations — `fork`, `read`, `write`, `delete`, `gc`, and `verify`.
- `open(input)` — create a session with an actor, session ID, and mount list.
- Session file operations — `read`, `readBytes`, `write`, `edit`, `list`, `glob`, `stat`, `delete`, `history`, `timeline`, and `diff`.
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

Integration tests require a disposable PostgreSQL 16 container. They use `TUDDOFS_DATABASE_URL` and verify that migrations create exactly these public tables:

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
  --publish 55434:5432 \
  postgres:16-alpine
until docker exec tuddofs-it pg_isready -U tuddofs -d tuddofs_it >/dev/null 2>&1; do sleep 1; done
TUDDOFS_DATABASE_URL=postgresql://tuddofs:tuddofs@127.0.0.1:55434/tuddofs_it npm run test:integration
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
