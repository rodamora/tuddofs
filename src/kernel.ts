import type { Readable } from 'node:stream'

import { commitPreimage, hashCommit, hashTree, sha256 as hashSha256, type TreeEntry } from './hashing.js'
import {
  AgentFsError,
  BranchSettledError,
  GrantResolverError,
  InvariantError,
  NotFoundError,
  PermissionDeniedError,
  PreconditionFailedError,
  RefConflictError,
  StorageError,
  type ErrorContext,
} from './errors.js'
import { InvalidCommitTimestampError } from './validation.js'
import { migrate, type AgentFsPool } from './migration.js'
import { validateMountKey, validatePath } from './validation.js'
export interface BlobStore {
  put(key: string, bytes: Buffer): Promise<void>
  head(key: string): Promise<{ sizeBytes: number } | null>
  get(key: string): Promise<Readable>
  delete(key: string): Promise<void>
  presignPut?(key: string, opts: { ttlSeconds: number; checksumSha256: string }): Promise<string>
  presignGet?(key: string, opts: { ttlSeconds: number }): Promise<string>
}

export interface Actor {
  readonly id: string
  readonly tenant: string
}

export type WriteMode = 'direct' | 'staged' | 'none'

/**
 * Resolve live permissions. An omitted read mount is passed as `key: ''` to
 * represent an unmounted read; resolvers MUST deny unknown keys (including
 * `''` when they do not support unmounted reads) rather than fail open.
 * @see spec §5
 */
export interface GrantResolver {
  resolve(actor: Actor, mount: { key: string }): Promise<{ read: boolean; write: WriteMode }>
}

/** Receives post-commit hook failures without affecting write durability. @see spec §10b */
export interface AgentFsLogger {
  error(error: unknown, context?: object): void
}

export interface ForkInput {
  readonly tenant: string
  readonly mount: string
  readonly sessionId: string
  readonly authorUser: string
  readonly agentKind?: string | null
  readonly threadId?: string | null
  readonly runId?: string | null
}

export interface WriteInput {
  readonly tenant: string
  readonly mount: string
  readonly ref: string
  readonly path: string
  readonly bytes: Buffer | Uint8Array | string
  readonly ifSha?: string | null
  readonly authorUser: string
  readonly agentKind?: string | null
  readonly threadId?: string | null
  readonly runId?: string | null
  readonly op?: string
  readonly message?: string | null
}

export interface ReadInput {
  readonly tenant: string
  readonly mount?: string
  readonly ref: string
  readonly path: string
}

export interface ForkResult {
  readonly tenant: string
  readonly mount: string
  readonly ref: string
  readonly commitId: bigint
  readonly baseCommitId: bigint
  readonly commitSha: string
}

export interface WriteResult {
  readonly path: string
  readonly sha256: string
  readonly sizeBytes: bigint
  readonly commitSha: string
}

export interface ReadResult {
  readonly path: string
  readonly sha256: string
  readonly sizeBytes: bigint
  readonly mode: number
  readonly bytes: Buffer
  readonly commitSha: string
}

export interface CommitEvent {
  readonly tenant: string
  readonly mount: string
  readonly ref: string
  readonly commitSha: string
  readonly changedPaths: readonly string[]
}

export interface AgentFsOptions {
  readonly pool: AgentFsPool
  readonly storage?: BlobStore
  readonly grants?: GrantResolver
  readonly logger?: AgentFsLogger
  readonly inlineMaxBytes?: number
  readonly maxCasRetries?: number
  readonly now?: () => Date
  readonly onCommit?: (event: CommitEvent) => void | Promise<void>
}

export interface AgentFsKernel {
  migrate(): Promise<void>
  fork(input: ForkInput): Promise<ForkResult | null>
  write(input: WriteInput): Promise<WriteResult>
  read(input: ReadInput): Promise<ReadResult>
}

type QueryResult<Row extends Record<string, unknown> = Record<string, unknown>> = {
  rows: Row[]
  rowCount: number | null
}

type Queryable = {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<QueryResult<Row>>
}
type RefRow = {
  commit_id: string
  base_commit: string | null
  commit_sha: string
  kind: string
  state: string
}

type HeadRow = {
  path: string
  blob_id: string
  sha256: string
  size_bytes: string
  mode: number
}

type Entry = {
  blobId: bigint
  sha256: string
  sizeBytes: bigint
  mode: number
}

const DEFAULT_INLINE_MAX_BYTES = 131_072
const DEFAULT_CAS_RETRIES = 3

function asBigInt(value: unknown, field: string, context?: ErrorContext): bigint {
  if (typeof value === 'bigint') return value
  if (typeof value === 'string' && /^\d+$/.test(value)) return BigInt(value)
  throw new InvariantError(`Invalid BIGINT ${field} returned by Postgres`, context)
}

function contextFor(input: { tenant: string; mount?: string; path?: string; ref?: string }): ErrorContext {
  return input
}

function refForFork(input: ForkInput): string {
  return `agent/${input.sessionId}/${input.mount}`
}

function bytesFor(input: Buffer | Uint8Array | string): Buffer {
  return Buffer.isBuffer(input) ? input : Buffer.from(input)
}

async function readAll(readable: Readable): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of readable) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  return Buffer.concat(chunks)
}

async function grant(
  resolver: GrantResolver | undefined,
  action: 'read' | 'write',
  input: { tenant: string; mount?: string; path?: string; ref?: string; authorUser?: string },
): Promise<boolean> {
  if (!resolver) return true
  const context = contextFor(input)
  try {
    const result = await resolver.resolve(
      { id: input.authorUser ?? '', tenant: input.tenant },
      { key: input.mount ?? '' },
    )
    if (action === 'read') return result.read
    return result.write !== 'none'
  } catch (error) {
    if (error instanceof AgentFsError) throw error
    throw new GrantResolverError(error instanceof Error ? error.message : 'Grant resolver failed', context)
  }
}
function timestamp(now: () => Date, context: ErrorContext): { date: Date; iso: string } {
  const date = now()
  let iso: string
  try {
    iso = date.toISOString()
  } catch {
    throw new InvalidCommitTimestampError(date, context)
  }
  try {
    commitPreimage({
      treeSha: '0'.repeat(64),
      parents: [],
      authorUser: '',
      agentKind: null,
      threadId: null,
      runId: null,
      ts: iso,
      op: 'import',
    })
  } catch (error) {
    if (error instanceof InvalidCommitTimestampError) throw new InvalidCommitTimestampError(error.timestamp, context)
    throw error
  }
  return { date, iso }
}

async function insertBlob(
  client: Queryable,
  tenant: string,
  bytes: Buffer,
  sha256: string,
  inlineMaxBytes: number,
  objectKey: string | null,
  context: ErrorContext,
): Promise<bigint> {
  const result = await client.query<{ id: string }>(
    `INSERT INTO afs_blobs (tenant, sha256, size_bytes, inline, object_key)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (tenant, sha256) DO NOTHING
     RETURNING id::text`,
    [tenant, sha256, bytes.length.toString(), bytes.length <= inlineMaxBytes ? bytes : null, objectKey],
  )
  if (result.rows[0]) return asBigInt(result.rows[0].id, 'afs_blobs.id', context)
  const existing = await client.query<{ id: string; size_bytes: string }>(
    'SELECT id::text, size_bytes::text FROM afs_blobs WHERE tenant = $1 AND sha256 = $2',
    [tenant, sha256],
  )
  const row = existing.rows[0]
  if (!row) throw new InvariantError(`Blob insert/select failed for ${sha256}`, context)
  if (asBigInt(row.size_bytes, 'afs_blobs.size_bytes', context) !== BigInt(bytes.length)) {
    throw new InvariantError(`Blob collision for ${sha256}`, context)
  }
  return asBigInt(row.id, 'afs_blobs.id', context)
}

async function insertTree(
  client: Queryable,
  tenant: string,
  entries: Map<string, Entry>,
  context: ErrorContext,
): Promise<{ id: bigint; sha: string }> {
  const treeEntries: TreeEntry[] = [...entries].map(([path, entry]) => ({
    path,
    mode: entry.mode,
    blobSha: entry.sha256,
  }))
  const treeSha = hashTree(treeEntries)
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO afs_trees (tenant, tree_sha)
     VALUES ($1, $2)
     ON CONFLICT (tenant, tree_sha) DO NOTHING
     RETURNING id::text`,
    [tenant, treeSha],
  )
  const treeId = inserted.rows[0]
    ? asBigInt(inserted.rows[0].id, 'afs_trees.id', context)
    : await loadTreeId(client, tenant, treeSha, context)
  if (inserted.rows[0]) {
    const rows = [...entries]
    for (let offset = 0; offset < rows.length; offset += 5000) {
      const chunk = rows.slice(offset, offset + 5000)
      if (chunk.length === 0) continue
      const params: unknown[] = [treeId.toString()]
      const values = chunk.map(([path, entry], index) => {
        const base = index * 3 + 2
        params.push(path, entry.blobId.toString(), entry.mode)
        return `($1::bigint, $${base}, $${base + 1}::bigint, $${base + 2})`
      })
      await client.query(
        `INSERT INTO afs_tree_entries (tree_id, path, blob_id, mode)
         VALUES ${values.join(', ')}
         ON CONFLICT (tree_id, path) DO NOTHING`,
        params,
      )
    }
  }
  return { id: treeId, sha: treeSha }
}

async function loadTreeId(client: Queryable, tenant: string, treeSha: string, context: ErrorContext): Promise<bigint> {
  const selected = await client.query<{ id: string }>(
    'SELECT id::text FROM afs_trees WHERE tenant = $1 AND tree_sha = $2',
    [tenant, treeSha],
  )
  const row = selected.rows[0]
  if (!row) throw new InvariantError(`Tree insert/select failed for ${treeSha}`, context)
  return asBigInt(row.id, 'afs_trees.id', context)
}

async function insertCommit(
  client: Queryable,
  input: {
    tenant: string
    treeId: bigint
    treeSha: string
    parentIds: readonly bigint[]
    parentShas: readonly string[]
    authorUser: string
    agentKind: string | null
    threadId: string | null
    runId: string | null
    op: string
    message: string | null
    createdAt: Date
    context: ErrorContext
  },
): Promise<{ id: bigint; sha: string }> {
  const createdAtIso = input.createdAt.toISOString()
  const hashInput = {
    treeSha: input.treeSha,
    parents: input.parentShas,
    authorUser: input.authorUser,
    agentKind: input.agentKind,
    threadId: input.threadId,
    runId: input.runId,
    ts: createdAtIso,
    op: input.op,
  }
  const commitSha = hashCommit(hashInput)
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO afs_commits (
       tenant, commit_sha, tree_id, parents, author_user, agent_kind,
       thread_id, run_id, op, message, created_at
     ) VALUES ($1, $2, $3::bigint, $4::bigint[], $5, $6, $7, $8, $9, $10, $11)
     ON CONFLICT (tenant, commit_sha) DO NOTHING
     RETURNING id::text`,
    [
      input.tenant,
      commitSha,
      input.treeId.toString(),
      input.parentIds.map(parent => parent.toString()),
      input.authorUser,
      input.agentKind,
      input.threadId,
      input.runId,
      input.op,
      input.message,
      input.createdAt,
    ],
  )
  if (inserted.rows[0]) return { id: asBigInt(inserted.rows[0].id, 'afs_commits.id', input.context), sha: commitSha }
  const selected = await client.query<{ id: string }>(
    'SELECT id::text FROM afs_commits WHERE tenant = $1 AND commit_sha = $2',
    [input.tenant, commitSha],
  )
  const row = selected.rows[0]
  if (!row) throw new InvariantError(`Commit insert/select failed for ${commitSha}`, input.context)
  return { id: asBigInt(row.id, 'afs_commits.id', input.context), sha: commitSha }
}
async function loadRef(client: Queryable, tenant: string, ref: string, context: ErrorContext): Promise<RefRow> {
  const result = await client.query<RefRow>(
    `SELECT r.commit_id::text, r.base_commit::text, c.commit_sha, r.kind, r.state
     FROM afs_refs r JOIN afs_commits c ON c.id = r.commit_id
     WHERE r.tenant = $1 AND r.name = $2`,
    [tenant, ref],
  )
  const row = result.rows[0]
  if (!row) throw new NotFoundError(`Ref not found: ${ref}`, context)
  return row
}

async function loadHeads(
  client: Queryable,
  tenant: string,
  ref: string,
  commitId: bigint,
  context: ErrorContext,
): Promise<Map<string, Entry>> {
  const result = await client.query<HeadRow>(
    `SELECT h.path, h.blob_id::text, h.sha256, h.size_bytes::text,
            COALESCE(e.mode, 420)::int AS mode
     FROM afs_heads h
     LEFT JOIN afs_commits c ON c.id = $3::bigint
     LEFT JOIN afs_tree_entries e ON e.tree_id = c.tree_id AND e.path = h.path
     WHERE h.tenant = $1 AND h.ref_name = $2`,
    [tenant, ref, commitId.toString()],
  )
  return new Map(
    result.rows.map(row => [
      row.path,
      {
        blobId: asBigInt(row.blob_id, 'afs_heads.blob_id', context),
        sha256: row.sha256,
        sizeBytes: asBigInt(row.size_bytes, 'afs_heads.size_bytes', context),
        mode: row.mode,
      },
    ]),
  )
}

async function ensureStorage(
  storage: BlobStore | undefined,
  tenant: string,
  bytes: Buffer,
  sha256: string,
  inlineMaxBytes: number,
  context: ErrorContext,
): Promise<string | null> {
  if (bytes.length <= inlineMaxBytes) return null
  if (!storage) throw new StorageError('Large blob requires an object storage backend', context)
  const key = `afs/${tenant}/${sha256}`
  try {
    if (!(await storage.head(key))) await storage.put(key, bytes)
  } catch (error) {
    if (error instanceof StorageError) throw error
    throw new StorageError(error instanceof Error ? error.message : 'Object storage failed', context)
  }
  return key
}

async function updateHead(client: Queryable, tenant: string, ref: string, path: string, entry: Entry): Promise<void> {
  await client.query(
    `INSERT INTO afs_heads (tenant, ref_name, path, blob_id, sha256, size_bytes)
     VALUES ($1, $2, $3, $4::bigint, $5, $6::bigint)
     ON CONFLICT (tenant, ref_name, path) DO UPDATE SET
       blob_id = EXCLUDED.blob_id,
       sha256 = EXCLUDED.sha256,
       size_bytes = EXCLUDED.size_bytes`,
    [tenant, ref, path, entry.blobId.toString(), entry.sha256, entry.sizeBytes.toString()],
  )
}

export function createAgentFs(options: AgentFsOptions): AgentFsKernel {
  const inlineMaxBytes = options.inlineMaxBytes ?? DEFAULT_INLINE_MAX_BYTES
  const maxCasRetries = options.maxCasRetries ?? DEFAULT_CAS_RETRIES
  const now = options.now ?? (() => new Date())

  async function fork(input: ForkInput): Promise<ForkResult | null> {
    const ref = refForFork(input)
    const context = contextFor({ tenant: input.tenant, mount: input.mount, ref })
    validateMountKey(input.mount, context)
    if (!(await grant(options.grants, 'read', { ...input, ref }))) return null

    const client = await options.pool.connect()
    try {
      await client.query('BEGIN')
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`${input.tenant}:mount/${input.mount}`])
      let mountRef = await client.query<RefRow>(
        `SELECT r.commit_id::text, r.base_commit::text, c.commit_sha, r.kind, r.state
         FROM afs_refs r JOIN afs_commits c ON c.id = r.commit_id
         WHERE r.tenant = $1 AND r.name = $2`,
        [input.tenant, `mount/${input.mount}`],
      )
      if (!mountRef.rows[0]) {
        const created = timestamp(now, context)
        const emptyTree = await insertTree(client, input.tenant, new Map(), context)
        const genesis = await insertCommit(client, {
          tenant: input.tenant,
          treeId: emptyTree.id,
          treeSha: emptyTree.sha,
          parentIds: [],
          parentShas: [],
          authorUser: input.authorUser,
          agentKind: input.agentKind ?? null,
          threadId: input.threadId ?? null,
          runId: input.runId ?? null,
          op: 'import',
          message: 'genesis',
          createdAt: created.date,
          context,
        })
        await client.query(
          `INSERT INTO afs_refs (tenant, name, kind, commit_id, base_commit, state)
           VALUES ($1, $2, 'branch', $3::bigint, NULL, 'open')
           ON CONFLICT (tenant, name) DO NOTHING`,
          [input.tenant, `mount/${input.mount}`, genesis.id.toString()],
        )
        mountRef = await client.query<RefRow>(
          `SELECT r.commit_id::text, r.base_commit::text, c.commit_sha, r.kind, r.state
           FROM afs_refs r JOIN afs_commits c ON c.id = r.commit_id
           WHERE r.tenant = $1 AND r.name = $2`,
          [input.tenant, `mount/${input.mount}`],
        )
      }
      const tip = mountRef.rows[0]
      if (!tip) throw new NotFoundError(`Mount ref not found: mount/${input.mount}`, context)
      const branchInsert = await client.query(
        `INSERT INTO afs_refs (tenant, name, kind, commit_id, base_commit, state)
         VALUES ($1, $2, 'branch', $3::bigint, $3::bigint, 'open')
         ON CONFLICT (tenant, name) DO NOTHING`,
        [input.tenant, ref, tip.commit_id],
      )
      const branchCreated = (branchInsert.rowCount ?? 0) > 0
      const branch = await loadRef(client, input.tenant, ref, context)
      if (branchCreated) {
        // Seed from the captured tip tree, never live mount heads: the tip is
        // the branch's snapshot even if a concurrent mount write races here.
        await client.query(
          `INSERT INTO afs_heads (tenant, ref_name, path, blob_id, sha256, size_bytes)
           SELECT $1, $2, e.path, e.blob_id, b.sha256, b.size_bytes
           FROM afs_commits c
           JOIN afs_tree_entries e ON e.tree_id = c.tree_id
           JOIN afs_blobs b ON b.id = e.blob_id
           WHERE c.id = $3::bigint
           ON CONFLICT (tenant, ref_name, path) DO NOTHING`,
          [input.tenant, ref, tip.commit_id],
        )
      }
      await client.query('COMMIT')
      return {
        tenant: input.tenant,
        mount: input.mount,
        ref,
        commitId: asBigInt(branch.commit_id, 'afs_refs.commit_id', context),
        baseCommitId: asBigInt(branch.base_commit ?? branch.commit_id, 'afs_refs.base_commit', context),
        commitSha: branch.commit_sha,
      }
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined)
      throw error
    } finally {
      client.release()
    }
  }

  async function write(input: WriteInput): Promise<WriteResult> {
    const initialContext = contextFor({ tenant: input.tenant, mount: input.mount, ref: input.ref })
    validateMountKey(input.mount, initialContext)
    const path = validatePath(input.path, initialContext)
    const context = contextFor({ tenant: input.tenant, mount: input.mount, path, ref: input.ref })
    if (!(await grant(options.grants, 'write', input)))
      throw new PermissionDeniedError('Write permission denied', context)
    const bytes = bytesFor(input.bytes)
    const sha256 = hashSha256(bytes)
    const objectKey = await ensureStorage(options.storage, input.tenant, bytes, sha256, inlineMaxBytes, context)

    // Interpret §4.5 step 9's “max 3” as three total attempts; the
    // RefConflictError.attempts field reports that same budget.
    for (let attempt = 0; attempt < maxCasRetries; attempt += 1) {
      const client = await options.pool.connect()
      try {
        await client.query('BEGIN')
        const ref = await loadRef(client, input.tenant, input.ref, context)
        if (ref.kind === 'branch' && ref.state !== 'open') throw new BranchSettledError(ref.state, context)
        const heads = await loadHeads(
          client,
          input.tenant,
          input.ref,
          asBigInt(ref.commit_id, 'afs_refs.commit_id', context),
          context,
        )
        const current = heads.get(path)
        if (input.ifSha !== undefined && input.ifSha !== (current?.sha256 ?? null)) {
          throw new PreconditionFailedError(input.ifSha, current?.sha256 ?? null, context)
        }
        if (current?.sha256 === sha256) {
          await client.query('ROLLBACK')
          return { path, sha256, sizeBytes: current.sizeBytes, commitSha: ref.commit_sha }
        }

        // Spec §4.5 lists blob insertion earlier; doing it after ref checks
        // avoids orphan blob rows on precondition or settled-branch exits.
        const blobId = await insertBlob(client, input.tenant, bytes, sha256, inlineMaxBytes, objectKey, context)
        const next = new Map(heads)
        next.set(path, { blobId, sha256, sizeBytes: BigInt(bytes.length), mode: current?.mode ?? 420 })
        const tree = await insertTree(client, input.tenant, next, context)
        const createdAt = timestamp(now, context)
        const commit = await insertCommit(client, {
          tenant: input.tenant,
          treeId: tree.id,
          treeSha: tree.sha,
          parentIds: [asBigInt(ref.commit_id, 'afs_refs.commit_id', context)],
          parentShas: [ref.commit_sha],
          authorUser: input.authorUser,
          agentKind: input.agentKind ?? null,
          threadId: input.threadId ?? null,
          runId: input.runId ?? null,
          op: input.op ?? 'write',
          message: input.message ?? null,
          createdAt: createdAt.date,
          context,
        })
        const updated = await client.query(
          `UPDATE afs_refs SET commit_id = $3::bigint
           WHERE tenant = $1 AND name = $2 AND commit_id = $4::bigint`,
          [input.tenant, input.ref, commit.id.toString(), ref.commit_id],
        )
        if ((updated.rowCount ?? 0) === 0) {
          await client.query('ROLLBACK')
          continue
        }
        await updateHead(client, input.tenant, input.ref, path, next.get(path) as Entry)
        await client.query('COMMIT')
        const event: CommitEvent = {
          tenant: input.tenant,
          mount: input.mount,
          ref: input.ref,
          commitSha: commit.sha,
          changedPaths: [path],
        }
        if (options.onCommit) {
          void Promise.resolve()
            .then(() => options.onCommit?.(event))
            .catch(error => {
              try {
                if (options.logger) options.logger.error(error, event)
                else console.error('AgentFs onCommit hook failed', error, event)
              } catch (loggerError) {
                console.error('AgentFs onCommit hook logger failed', loggerError, { error, event })
              }
            })
        }
        return { path, sha256, sizeBytes: BigInt(bytes.length), commitSha: commit.sha }
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined)
        throw error
      } finally {
        client.release()
      }
    }
    throw new RefConflictError(context, maxCasRetries)
  }

  async function read(input: ReadInput): Promise<ReadResult> {
    const initialContext = contextFor(input)
    if (input.mount !== undefined) validateMountKey(input.mount, initialContext)
    const path = validatePath(input.path, initialContext)
    const context = contextFor({ ...input, path })
    if (!(await grant(options.grants, 'read', input)))
      throw new PermissionDeniedError('Read permission denied', context)
    const client = await options.pool.connect()
    try {
      const result = await client.query<
        HeadRow & { commit_sha: string; inline: Buffer | null; object_key: string | null }
      >(
        `SELECT h.path, h.blob_id::text, h.sha256, h.size_bytes::text, e.mode,
                c.commit_sha, b.inline, b.object_key
         FROM afs_heads h
         JOIN afs_refs r ON r.tenant = h.tenant AND r.name = h.ref_name
         JOIN afs_commits c ON c.id = r.commit_id
         JOIN afs_tree_entries e ON e.tree_id = c.tree_id AND e.path = h.path
         JOIN afs_blobs b ON b.id = h.blob_id
         WHERE h.tenant = $1 AND h.ref_name = $2 AND h.path = $3`,
        [input.tenant, input.ref, path],
      )
      const row = result.rows[0]
      if (!row) throw new NotFoundError(`Path not found: ${input.path}`, context)
      let bytes: Buffer
      if (row.inline) {
        bytes = Buffer.from(row.inline)
      } else if (row.object_key && options.storage) {
        try {
          bytes = await readAll(await options.storage.get(row.object_key))
        } catch (error) {
          if (error instanceof StorageError) throw error
          throw new StorageError(error instanceof Error ? error.message : 'Object storage failed', context)
        }
      } else {
        throw new StorageError('Blob has no readable storage backend', context)
      }
      return {
        path: row.path,
        sha256: row.sha256,
        sizeBytes: asBigInt(row.size_bytes, 'afs_heads.size_bytes', context),
        mode: row.mode,
        bytes,
        commitSha: row.commit_sha,
      }
    } finally {
      client.release()
    }
  }

  return { migrate: () => migrate(options.pool), fork, write, read }
}
