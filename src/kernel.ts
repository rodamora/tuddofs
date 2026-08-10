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
export interface BlobObject {
  readonly key: string
  readonly lastModified: Date | string
}

export interface BlobStore {
  put(key: string, bytes: Buffer): Promise<void>
  head(key: string): Promise<{ sizeBytes: number } | null>
  get(key: string): Promise<Readable>
  delete(key: string): Promise<void>
  list?(prefix: string): Promise<readonly BlobObject[]>
  presignPut?(key: string, opts: { ttlSeconds: number; checksumSha256: string }): Promise<string>
  presignGet?(key: string, opts: { ttlSeconds: number }): Promise<string>
}

/** Reachability-GC windows and optional tenant scope. @see spec §4.8 */
export interface GcOptions {
  readonly tenant?: string
  readonly graceMs?: number
  readonly settledBranchRetentionMs?: number
}
/** Counts returned by a GC cycle; `skipped` is true only when no tenant could run. @see spec §4.8 */
export interface GcReport {
  readonly skipped: boolean
  readonly skippedTenants: readonly string[]
  readonly tenant?: string
  readonly deletedCommits: number
  readonly deletedTrees: number
  readonly deletedBlobs: number
  readonly deletedObjects: number
  readonly settledBranches: number
}
/** Typed fsck findings; corruption is reported as data instead of aborting the scan. @see spec §4.9 */
export type VerifyFinding =
  | {
      readonly kind: 'tree-hash-drift'
      readonly treeId: string
      readonly expectedSha: string
      readonly actualSha: string
    }
  | {
      readonly kind: 'commit-hash-drift'
      readonly commitId: string
      readonly expectedSha: string
      readonly actualSha: string
    }
  | {
      readonly kind: 'heads-drift'
      readonly tenant: string
      readonly ref: string
      readonly path: string
      readonly issue: 'missing' | 'unexpected' | 'mismatch'
      readonly expected?: { blobId: string; sha256: string; sizeBytes: string }
      readonly actual?: { blobId: string; sha256: string; sizeBytes: string }
    }
  | {
      readonly kind: 'storage-missing' | 'storage-size-mismatch' | 'storage-error'
      readonly blobId: string
      readonly objectKey: string
      readonly expectedSizeBytes: string
      readonly actualSizeBytes?: number
      readonly message?: string
    }
  | {
      readonly kind: 'dangling-parent'
      readonly commitId: string
      readonly parentId: string
    }
  | {
      readonly kind: 'orphaned-head'
      readonly tenant: string
      readonly ref: string
      readonly path: string
    }
  | {
      readonly kind: 'tree-entry-missing-blob'
      readonly treeId: string
      readonly path: string
      readonly blobId: string
    }
/** Limits fsck scope to one tenant and randomizes the tree, commit, and CAS spot-check samples. Ref/head drift remains full-scope. @see spec §4.9 */
export interface VerifyOptions {
  readonly tenant?: string
  readonly sample?: number
}

/** Result of an integrity scan; findings are data, not thrown scan errors. @see spec §4.9 */
export interface VerifyReport {
  readonly tenant?: string
  readonly ok: boolean
  readonly findings: readonly VerifyFinding[]
  readonly checked: {
    readonly trees: number
    readonly commits: number
    readonly refs: number
    readonly blobs: number
    readonly parents: number
  }
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
  gc(input?: GcOptions): Promise<GcReport>
  verify(input?: VerifyOptions): Promise<VerifyReport>
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

const DEFAULT_GRACE_MS = 24 * 60 * 60 * 1000
const DEFAULT_SETTLED_BRANCH_RETENTION_MS = 7 * 24 * 60 * 60 * 1000
const MAINTENANCE_BATCH_SIZE = 500

type GcCounts = {
  deletedCommits: number
  deletedTrees: number
  deletedBlobs: number
  deletedObjects: number
  settledBranches: number
}

function emptyGcCounts(): GcCounts {
  return { deletedCommits: 0, deletedTrees: 0, deletedBlobs: 0, deletedObjects: 0, settledBranches: 0 }
}

function sampleLimit(sample: number | undefined): number | null {
  if (sample === undefined || !Number.isFinite(sample) || sample <= 0) return null
  return Math.max(1, Math.floor(sample))
}

function dateFromPostgres(value: unknown): Date | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value
  if (typeof value === 'string') {
    const parsed = new Date(value)
    return Number.isNaN(parsed.getTime()) ? null : parsed
  }
  return null
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.map(item => (typeof item === 'bigint' ? item.toString() : String(item)))
}

async function deleteMaintenanceBatch(
  client: Queryable,
  text: string,
  values: readonly unknown[],
): Promise<{ rows: Array<Record<string, unknown>>; rowCount: number | null }> {
  await client.query('SAVEPOINT afs_gc_batch')
  try {
    const result = await client.query(text, values)
    await client.query('RELEASE SAVEPOINT afs_gc_batch')
    return result
  } catch (error) {
    await client.query('ROLLBACK TO SAVEPOINT afs_gc_batch').catch(() => undefined)
    await client.query('RELEASE SAVEPOINT afs_gc_batch').catch(() => undefined)
    if (error !== null && typeof error === 'object' && 'code' in error && error.code === '23503')
      return { rows: [], rowCount: 0 }
    throw error
  }
}

async function maintenanceTransaction<T>(client: Queryable, work: () => Promise<T>): Promise<T> {
  await client.query('BEGIN')
  try {
    const result = await work()
    await client.query('COMMIT')
    return result
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw error
  }
}

async function collectTenant(
  client: Queryable,
  tenant: string,
  cutoff: Date,
  settledCutoff: Date,
): Promise<{ counts: GcCounts }> {
  const counts = emptyGcCounts()

  for (;;) {
    const count = await maintenanceTransaction(client, async () => {
      const settled = await client.query<{ name: string }>(
        `SELECT name
         FROM afs_refs
         WHERE tenant = $1 AND kind = 'branch' AND state <> 'open'
           AND settled_at IS NOT NULL AND settled_at < $2
         ORDER BY name
         LIMIT $3`,
        [tenant, settledCutoff, MAINTENANCE_BATCH_SIZE],
      )
      if (settled.rows.length === 0) return 0
      const names = settled.rows.map(row => row.name)
      await client.query('DELETE FROM afs_heads WHERE tenant = $1 AND ref_name = ANY($2::text[])', [tenant, names])
      const deleted = await client.query<{ name: string }>(
        `DELETE FROM afs_refs
         WHERE tenant = $1 AND name = ANY($2::text[])
         RETURNING name`,
        [tenant, names],
      )
      return deleted.rowCount ?? deleted.rows.length
    })
    counts.settledBranches += count
    if (count === 0) break
  }

  for (;;) {
    const count = await maintenanceTransaction(client, async () => {
      const deleted = await deleteMaintenanceBatch(
        client,
        `WITH RECURSIVE reachable(id) AS (
           SELECT commit_id
           FROM afs_refs
           WHERE tenant = $1
           UNION
           SELECT parent_id
           FROM reachable r
           JOIN afs_commits c ON c.id = r.id AND c.tenant = $1
           CROSS JOIN LATERAL unnest(c.parents) AS parents(parent_id)
         ),
         grace_protected(id) AS (
           SELECT id
           FROM afs_commits
           WHERE tenant = $1 AND created_at > $2
         ),
         protected_ids(id) AS (
           SELECT id FROM reachable
           UNION
           SELECT id FROM grace_protected
           UNION
           SELECT parent_id
           FROM protected_ids p
           JOIN afs_commits c ON c.id = p.id AND c.tenant = $1
           CROSS JOIN LATERAL unnest(c.parents) AS parents(parent_id)
         ),
         doomed AS (
           SELECT c.id
           FROM afs_commits c
           WHERE c.tenant = $1 AND c.created_at <= $2
             AND NOT EXISTS (SELECT 1 FROM protected_ids p WHERE p.id = c.id)
             AND NOT EXISTS (
               SELECT 1 FROM afs_refs r
               WHERE r.tenant = c.tenant AND (r.commit_id = c.id OR r.base_commit = c.id)
             )
             AND NOT EXISTS (
               SELECT 1
               FROM afs_commits child
               CROSS JOIN LATERAL unnest(child.parents) AS parents(parent_id)
               WHERE child.tenant = $1 AND parents.parent_id = c.id
             )
           ORDER BY c.id
           LIMIT $3
         )
         DELETE FROM afs_commits c
         USING doomed
         WHERE c.id = doomed.id
         RETURNING c.id`,
        [tenant, cutoff, MAINTENANCE_BATCH_SIZE],
      )
      return deleted.rowCount ?? deleted.rows.length
    })
    counts.deletedCommits += count
    if (count === 0) break
  }

  for (;;) {
    const count = await maintenanceTransaction(client, async () => {
      const deleted = await deleteMaintenanceBatch(
        client,
        `WITH doomed AS (
           SELECT t.id
           FROM afs_trees t
           WHERE t.tenant = $1 AND t.created_at <= $2
             AND NOT EXISTS (SELECT 1 FROM afs_commits c WHERE c.tree_id = t.id)
           ORDER BY t.id
           LIMIT $3
         )
         DELETE FROM afs_trees t
         USING doomed
         WHERE t.id = doomed.id
         RETURNING t.id`,
        [tenant, cutoff, MAINTENANCE_BATCH_SIZE],
      )
      return deleted.rowCount ?? deleted.rows.length
    })
    counts.deletedTrees += count
    if (count === 0) break
  }

  for (;;) {
    const count = await maintenanceTransaction(client, async () => {
      const deleted = await deleteMaintenanceBatch(
        client,
        `WITH doomed AS (
           SELECT b.id
           FROM afs_blobs b
           WHERE b.tenant = $1 AND b.created_at <= $2
             AND NOT EXISTS (SELECT 1 FROM afs_tree_entries e WHERE e.blob_id = b.id)
           ORDER BY b.id
           LIMIT $3
         )
         DELETE FROM afs_blobs b
         USING doomed
         WHERE b.id = doomed.id
         RETURNING b.id`,
        [tenant, cutoff, MAINTENANCE_BATCH_SIZE],
      )
      return deleted.rowCount ?? deleted.rows.length
    })
    counts.deletedBlobs += count
    if (count === 0) break
  }

  return { counts }
}

async function discoverTenants(client: Queryable): Promise<string[]> {
  const result = await client.query<{ tenant: string }>(
    `SELECT tenant FROM afs_refs
     UNION
     SELECT tenant FROM afs_blobs
     UNION
     SELECT tenant FROM afs_trees
     UNION
     SELECT tenant FROM afs_commits
     ORDER BY tenant`,
  )
  return result.rows.map(row => row.tenant)
}
type VerifyTreeRow = {
  id: string
  tree_sha: string
  path: string | null
  mode: number | null
  blob_id: string | null
  blob_sha: string | null
  blob_size: string | null
}

type VerifyCommitRow = {
  id: string
  commit_sha: string
  tree_sha: string | null
  parents: unknown
  author_user: string
  agent_kind: string | null
  thread_id: string | null
  run_id: string | null
  op: string
  created_at: unknown
}

type VerifyRefRow = {
  tenant: string
  name: string
  commit_id: string
  tree_id: string
}

type VerifyHeadRow = {
  tenant: string
  ref_name: string
  path: string
  blob_id: string
  sha256: string
  size_bytes: string
}

type VerifyBlobRow = {
  id: string
  object_key: string
  size_bytes: string
}

export function createAgentFs(options: AgentFsOptions): AgentFsKernel {
  const inlineMaxBytes = options.inlineMaxBytes ?? DEFAULT_INLINE_MAX_BYTES
  const maxCasRetries = options.maxCasRetries ?? DEFAULT_CAS_RETRIES
  const now = options.now ?? (() => new Date())

  async function gc(input: GcOptions = {}): Promise<GcReport> {
    const graceMs = input.graceMs ?? DEFAULT_GRACE_MS
    const retentionMs = input.settledBranchRetentionMs ?? DEFAULT_SETTLED_BRANCH_RETENTION_MS
    if (!Number.isFinite(graceMs) || graceMs < 0 || !Number.isFinite(retentionMs) || retentionMs < 0)
      throw new RangeError('GC grace and retention windows must be finite non-negative milliseconds')
    const discoveryClient = await options.pool.connect()
    let tenants: string[]
    try {
      tenants = input.tenant ? [input.tenant] : await discoverTenants(discoveryClient)
    } finally {
      discoveryClient.release()
    }

    const total = emptyGcCounts()
    const skippedTenants: string[] = []
    let ranTenants = 0
    const cutoff = new Date(now().getTime() - graceMs)
    const settledCutoff = new Date(now().getTime() - retentionMs)
    for (const tenant of tenants) {
      const client = await options.pool.connect()
      let locked = false
      try {
        const lock = await client.query<{ locked: boolean }>(`SELECT pg_try_advisory_lock(hashtext($1)) AS locked`, [
          `afs:gc:${tenant}`,
        ])
        locked = lock.rows[0]?.locked === true
        if (!locked) {
          skippedTenants.push(tenant)
          continue
        }
        ranTenants += 1
        const collected = await collectTenant(client, tenant, cutoff, settledCutoff)
        total.deletedCommits += collected.counts.deletedCommits
        total.deletedTrees += collected.counts.deletedTrees
        total.deletedBlobs += collected.counts.deletedBlobs
        total.settledBranches += collected.counts.settledBranches

        // A collected row must not directly delete its object key. The key
        // may have been uploaded and referenced again after the batch commit.
        if (options.storage?.list) {
          try {
            const prefix = `afs/${tenant}/`
            const listed = await options.storage.list(prefix)
            const candidates = listed.filter(object => object.key.startsWith(prefix))
            if (candidates.length > 0) {
              const known = await client.query<{ object_key: string }>(
                `SELECT object_key
                 FROM afs_blobs
                 WHERE tenant = $1 AND object_key = ANY($2::text[])`,
                [tenant, candidates.map(object => object.key)],
              )
              const knownKeys = new Set(known.rows.map(row => row.object_key))
              const nowMs = now().getTime()
              for (const object of candidates) {
                const modified = dateFromPostgres(object.lastModified)
                if (!modified || knownKeys.has(object.key) || nowMs - modified.getTime() <= graceMs) continue
                try {
                  await options.storage.delete(object.key)
                  total.deletedObjects += 1
                } catch (error) {
                  options.logger?.error(error, { tenant, objectKey: object.key, operation: 'gc' })
                }
              }
            }
          } catch (error) {
            options.logger?.error(error, { tenant, operation: 'gc-orphan-list' })
          }
        }
      } finally {
        if (locked)
          await client.query('SELECT pg_advisory_unlock(hashtext($1))', [`afs:gc:${tenant}`]).catch(() => undefined)
        client.release()
      }
    }
    return {
      skipped: ranTenants === 0,
      skippedTenants,
      ...(input.tenant === undefined ? {} : { tenant: input.tenant }),
      ...total,
    }
  }
  async function verify(input: VerifyOptions = {}): Promise<VerifyReport> {
    const client = await options.pool.connect()
    const findings: VerifyFinding[] = []
    const limit = sampleLimit(input.sample)
    const params = input.tenant === undefined ? [] : [input.tenant]
    const commitWhere = input.tenant === undefined ? '' : ' WHERE c.tenant = $1'
    const refWhere = input.tenant === undefined ? '' : ' WHERE r.tenant = $1'
    const headWhere = input.tenant === undefined ? '' : ' WHERE h.tenant = $1'
    const blobWhere =
      input.tenant === undefined ? ' WHERE object_key IS NOT NULL' : ' WHERE tenant = $1 AND object_key IS NOT NULL'
    const treeWhere = input.tenant === undefined ? '' : ' WHERE t.tenant = $1'
    const treeSampleWhere =
      limit === null
        ? ''
        : input.tenant === undefined
          ? ` WHERE t.id IN (SELECT t_sample.id FROM afs_trees t_sample ORDER BY random() LIMIT ${limit})`
          : ` AND t.id IN (
               SELECT t_sample.id FROM afs_trees t_sample
               WHERE t_sample.tenant = $1
               ORDER BY random() LIMIT ${limit}
             )`
    try {
      const treesResult = await client.query<VerifyTreeRow>(
        `SELECT t.id::text, t.tree_sha, e.path, e.mode, e.blob_id::text, b.sha256 AS blob_sha,
                b.size_bytes::text AS blob_size
         FROM afs_trees t
         LEFT JOIN afs_tree_entries e ON e.tree_id = t.id
         LEFT JOIN afs_blobs b ON b.id = e.blob_id${treeWhere}${treeSampleWhere}
         ORDER BY t.id, e.path`,
        params,
      )
      const treeRows = treesResult.rows
      const trees = new Map<
        string,
        {
          storedSha: string
          entries: TreeEntry[]
          expected: Map<string, { blobId: string; sha256: string; sizeBytes: string }>
        }
      >()
      for (const row of treeRows) {
        let tree = trees.get(row.id)
        if (!tree) {
          tree = { storedSha: row.tree_sha, entries: [], expected: new Map() }
          trees.set(row.id, tree)
        }
        if (row.path === null) continue
        if (row.blob_id === null || row.blob_sha === null || row.blob_size === null || row.mode === null) {
          findings.push({ kind: 'tree-entry-missing-blob', treeId: row.id, path: row.path, blobId: row.blob_id ?? '' })
          continue
        }
        tree.entries.push({ path: row.path, mode: row.mode, blobSha: row.blob_sha })
        tree.expected.set(row.path, { blobId: row.blob_id, sha256: row.blob_sha, sizeBytes: row.blob_size })
      }
      const sampledTrees = [...trees].slice(0, limit ?? trees.size)
      for (const [treeId, tree] of sampledTrees) {
        let computed: string
        try {
          computed = hashTree(tree.entries)
        } catch {
          computed = ''
        }
        if (computed !== tree.storedSha)
          findings.push({ kind: 'tree-hash-drift', treeId, expectedSha: computed, actualSha: tree.storedSha })
      }

      const commitsResult = await client.query<VerifyCommitRow>(
        `SELECT c.id::text, c.commit_sha, t.tree_sha, c.parents, c.author_user, c.agent_kind,
                c.thread_id, c.run_id, c.op, c.created_at
         FROM afs_commits c
         LEFT JOIN afs_trees t ON t.id = c.tree_id${commitWhere}
         ${limit === null ? 'ORDER BY c.id' : `ORDER BY random() LIMIT ${limit}`}`,
        params,
      )
      const sampledCommits = commitsResult.rows
      const sampledParentIds = [...new Set(sampledCommits.flatMap(row => stringArray(row.parents)))]
      const parentParams: readonly unknown[] = [...params, sampledParentIds]
      const parentWhere =
        input.tenant === undefined
          ? ' WHERE c.id = ANY($1::bigint[])'
          : ' WHERE c.tenant = $1 AND c.id = ANY($2::bigint[])'
      const parentRows =
        sampledParentIds.length === 0
          ? []
          : (
              await client.query<VerifyCommitRow>(
                `SELECT c.id::text, c.commit_sha, t.tree_sha, c.parents, c.author_user, c.agent_kind,
                        c.thread_id, c.run_id, c.op, c.created_at
                 FROM afs_commits c
                 LEFT JOIN afs_trees t ON t.id = c.tree_id${parentWhere}`,
                parentParams,
              )
            ).rows
      const commits = new Map([...commitsResult.rows, ...parentRows].map(row => [row.id, row]))
      let parentCount = 0
      for (const row of sampledCommits) {
        const parentIds = stringArray(row.parents)
        parentCount += parentIds.length
        const parentShas: string[] = []
        for (const parentId of parentIds) {
          const parent = commits.get(parentId)
          if (!parent) {
            findings.push({ kind: 'dangling-parent', commitId: row.id, parentId })
            parentShas.push('')
          } else {
            parentShas.push(parent.commit_sha)
          }
        }
        let computed = ''
        const created = dateFromPostgres(row.created_at)
        if (row.tree_sha && created) {
          try {
            computed = hashCommit({
              treeSha: row.tree_sha,
              parents: parentShas,
              authorUser: row.author_user,
              agentKind: row.agent_kind,
              threadId: row.thread_id,
              runId: row.run_id,
              ts: created.toISOString(),
              op: row.op,
            })
          } catch {
            computed = ''
          }
        }
        if (computed !== row.commit_sha)
          findings.push({
            kind: 'commit-hash-drift',
            commitId: row.id,
            expectedSha: computed,
            actualSha: row.commit_sha,
          })
      }

      const refsResult = await client.query<VerifyRefRow>(
        `SELECT r.tenant, r.name, r.commit_id::text, c.tree_id::text
         FROM afs_refs r JOIN afs_commits c ON c.id = r.commit_id${refWhere}
         ORDER BY r.tenant, r.name`,
        params,
      )
      const refEntriesResult = await client.query<{
        tenant: string
        name: string
        path: string | null
        blob_id: string | null
        blob_sha: string | null
        blob_size: string | null
      }>(
        `SELECT r.tenant, r.name, e.path, e.blob_id::text, b.sha256 AS blob_sha, b.size_bytes::text AS blob_size
         FROM afs_refs r
         JOIN afs_commits c ON c.id = r.commit_id
         LEFT JOIN afs_tree_entries e ON e.tree_id = c.tree_id
         LEFT JOIN afs_blobs b ON b.id = e.blob_id${refWhere}
         ORDER BY r.tenant, r.name, e.path`,
        params,
      )
      const expectedByRef = new Map<string, Map<string, { blobId: string; sha256: string; sizeBytes: string }>>()
      for (const row of refEntriesResult.rows) {
        if (row.path === null || row.blob_id === null || row.blob_sha === null || row.blob_size === null) continue
        const refKey = `${row.tenant}\u0000${row.name}`
        const expected = expectedByRef.get(refKey) ?? new Map()
        expected.set(row.path, { blobId: row.blob_id, sha256: row.blob_sha, sizeBytes: row.blob_size })
        expectedByRef.set(refKey, expected)
      }
      const headsResult = await client.query<VerifyHeadRow>(
        `SELECT h.tenant, h.ref_name, h.path, h.blob_id::text, h.sha256, h.size_bytes::text
         FROM afs_heads h${headWhere}
         ORDER BY h.tenant, h.ref_name, h.path`,
        params,
      )
      const headsByRef = new Map<string, Map<string, VerifyHeadRow>>()
      for (const row of headsResult.rows) {
        const refKey = `${row.tenant}\u0000${row.ref_name}`
        const byPath = headsByRef.get(refKey) ?? new Map<string, VerifyHeadRow>()
        byPath.set(row.path, row)
        headsByRef.set(refKey, byPath)
      }
      const refs = new Set(refsResult.rows.map(row => `${row.tenant}\u0000${row.name}`))
      for (const ref of refsResult.rows) {
        const refKey = `${ref.tenant}\u0000${ref.name}`
        const expected = expectedByRef.get(refKey) ?? new Map()
        const actual = headsByRef.get(refKey) ?? new Map<string, VerifyHeadRow>()
        for (const [path, entry] of expected) {
          const head = actual.get(path)
          if (!head) {
            findings.push({
              kind: 'heads-drift',
              tenant: ref.tenant,
              ref: ref.name,
              path,
              issue: 'missing',
              expected: entry,
            })
          } else if (
            head.blob_id !== entry.blobId ||
            head.sha256 !== entry.sha256 ||
            head.size_bytes !== entry.sizeBytes
          ) {
            findings.push({
              kind: 'heads-drift',
              tenant: ref.tenant,
              ref: ref.name,
              path,
              issue: 'mismatch',
              expected: entry,
              actual: { blobId: head.blob_id, sha256: head.sha256, sizeBytes: head.size_bytes },
            })
          }
        }
        for (const path of actual.keys()) {
          if (!expected.has(path))
            findings.push({
              kind: 'heads-drift',
              tenant: ref.tenant,
              ref: ref.name,
              path,
              issue: 'unexpected',
              actual: actual.has(path)
                ? {
                    blobId: actual.get(path)?.blob_id ?? '',
                    sha256: actual.get(path)?.sha256 ?? '',
                    sizeBytes: actual.get(path)?.size_bytes ?? '',
                  }
                : undefined,
            })
        }
      }
      for (const row of headsResult.rows) {
        if (!refs.has(`${row.tenant}\u0000${row.ref_name}`))
          findings.push({ kind: 'orphaned-head', tenant: row.tenant, ref: row.ref_name, path: row.path })
      }

      const blobs = options.storage
        ? (
            await client.query<VerifyBlobRow>(
              `SELECT id::text, object_key, size_bytes::text
               FROM afs_blobs${blobWhere}
               ${limit === null ? '' : `ORDER BY random() LIMIT ${limit}`}
               ${limit === null ? 'ORDER BY id' : ''}`,
              params,
            )
          ).rows
        : []
      if (options.storage) {
        for (const blob of blobs) {
          try {
            const object = await options.storage.head(blob.object_key)
            if (!object) {
              findings.push({
                kind: 'storage-missing',
                blobId: blob.id,
                objectKey: blob.object_key,
                expectedSizeBytes: blob.size_bytes,
              })
            } else if (object.sizeBytes !== Number(blob.size_bytes)) {
              findings.push({
                kind: 'storage-size-mismatch',
                blobId: blob.id,
                objectKey: blob.object_key,
                expectedSizeBytes: blob.size_bytes,
                actualSizeBytes: object.sizeBytes,
              })
            }
          } catch (error) {
            findings.push({
              kind: 'storage-error',
              blobId: blob.id,
              objectKey: blob.object_key,
              expectedSizeBytes: blob.size_bytes,
              message: error instanceof Error ? error.message : String(error),
            })
          }
        }
      }
      return {
        ...(input.tenant === undefined ? {} : { tenant: input.tenant }),
        ok: findings.length === 0,
        findings,
        checked: {
          trees: sampledTrees.length,
          commits: sampledCommits.length,
          refs: refsResult.rows.length,
          blobs: blobs.length,
          parents: parentCount,
        },
      }
    } finally {
      client.release()
    }
  }
  async function fork(input: ForkInput): Promise<ForkResult | null> {
    const ref = refForFork(input)
    const context = contextFor({ tenant: input.tenant, mount: input.mount, ref })
    validateMountKey(input.mount, context)
    if (!(await grant(options.grants, 'read', { ...input, ref }))) return null

    const client = await options.pool.connect()
    try {
      await client.query('BEGIN')
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`afs:gc:${input.tenant}`])
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

    // Interpret §4.5 step 9's “max 3” as three total attempts; the
    // RefConflictError.attempts field reports that same budget.
    for (let attempt = 0; attempt < maxCasRetries; attempt += 1) {
      const client = await options.pool.connect()
      const storageBacked = bytes.length > inlineMaxBytes
      let lockState: 'none' | 'acquiring' | 'held' | 'uncertain' = 'none'
      let failure: unknown
      try {
        if (storageBacked) {
          // Hold the tenant GC lock while uploading. GC keeps the same lock
          // through its orphan sweep, so no package write can upload and commit
          // a reference in the sweep's delete window.
          lockState = 'acquiring'
          await client.query('SELECT pg_advisory_lock(hashtext($1))', [`afs:gc:${input.tenant}`])
          lockState = 'held'
        }
        const objectKey = await ensureStorage(options.storage, input.tenant, bytes, sha256, inlineMaxBytes, context)
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
        if (lockState === 'held') {
          lockState = 'uncertain'
          await client.query('SELECT pg_advisory_unlock(hashtext($1))', [`afs:gc:${input.tenant}`])
          lockState = 'none'
        }
        if (options.onCommit) {
          setImmediate(() => {
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
          })
        }
        return { path, sha256, sizeBytes: BigInt(bytes.length), commitSha: commit.sha }
      } catch (error) {
        failure = error
        await client.query('ROLLBACK').catch(() => undefined)
        throw error
      } finally {
        if (lockState === 'held') {
          lockState = 'uncertain'
          try {
            await client.query('SELECT pg_advisory_unlock(hashtext($1))', [`afs:gc:${input.tenant}`])
            lockState = 'none'
          } catch (error) {
            failure ??= error
          }
        }
        if (lockState !== 'none') {
          const releaseError =
            failure instanceof Error ? failure : new Error('Agent FS advisory lock state is uncertain')
          client.release(releaseError)
        } else {
          client.release()
        }
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

  return { migrate: () => migrate(options.pool), gc, verify, fork, write, read }
}
