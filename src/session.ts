import { createHash, randomUUID } from 'node:crypto'
import { Readable, Transform } from 'node:stream'

import { hashCommit, hashTree, sha256, type TreeEntry } from './hashing.js'
import {
  TuddoFsError,
  BranchSettledError,
  EditMatchError,
  NotFoundError,
  PermissionDeniedError,
  PreconditionFailedError,
  StorageError,
} from './errors.js'
import { InvalidPathError, findTreeCoherenceCollisions, validateMountKey, validatePath } from './validation.js'
import type {
  Actor,
  TuddoFsKernel,
  TuddoFsOptions,
  DeleteResult,
  ForkResult,
  ReadResult,
  RestoreResult,
  WriteResult,
} from './kernel.js'
import type { TuddoFsClient } from './migration.js'
import type { ErrorContext } from './errors.js'

/** A file or directory returned by a virtual mount handler. */
export interface VirtualEntry {
  readonly path: string
  readonly type: 'file' | 'directory'
  readonly sizeBytes?: number | bigint
  readonly sha256?: string
  readonly mode?: number
}

/** Handler SPI for live, non-versioned mount data. */
export interface VirtualMountHandler {
  list(dir: string, actor: Actor): Promise<readonly VirtualEntry[]>
  read(path: string, actor: Actor): Promise<Buffer | null>
  write?(path: string, bytes: Buffer, actor: Actor): Promise<void>
}

/** A ref-backed or virtual mount included in a session. */
export type MountSpec =
  | {
      readonly key: string
      readonly mode?: 'follow' | { readonly pin: string }
    }
  | { readonly key: string; readonly virtual: VirtualMountHandler }

/** Inputs for a governed multi-mount session; mount-string shorthand is defined by architecture §6.2. */
export interface OpenInput {
  readonly actor: Actor
  readonly sessionId: string
  readonly attribution?: {
    readonly agentKind?: string | null
    readonly threadId?: string | null
    readonly runId?: string | null
  }
  readonly mounts: readonly (MountSpec | string)[]
}

/** Metadata for one file path in a session. */
export interface SessionStat {
  readonly path: string
  readonly sha256: string
  readonly sizeBytes: bigint
  readonly mode: number
}

/** A direct child returned by `list` or a glob match. */
export interface SessionEntry {
  readonly path: string
  readonly type: 'file' | 'directory'
  readonly sha256?: string
  readonly sizeBytes?: bigint | number
  readonly mode?: number
}

/** A literal text replacement governed by architecture §6.2. */
export interface TextEdit {
  readonly oldText: string
  readonly newText: string
  readonly replaceAll?: boolean
}
/** Optimistic concurrency options for `write`. */
export interface WriteOptions {
  readonly ifSha?: string | null
}
/** Optimistic precondition options for `edit`. */
export interface EditOptions {
  readonly ifSha?: string | null
}

/** Presign method and checksum options for object-backed session blobs (§8.1). */
export interface PresignOptions {
  readonly method?: 'GET' | 'PUT'
  readonly ttlSeconds?: number
  readonly sha256?: string
}

/** Optional provenance filters for timeline queries. */
export interface TimelineFilter {
  readonly runId?: string
  readonly agentKind?: string
  readonly threadId?: string
}

/** One commit that changed a requested path. */
export interface HistoryRecord {
  readonly commitSha: string
  readonly parentShas: readonly string[]
  readonly path: string
  readonly op: string
  readonly authorUser: string
  readonly agentKind: string | null
  readonly threadId: string | null
  readonly runId: string | null
  readonly createdAt: Date
}

/** One commit and its actual tree delta. */
export interface TimelineRecord {
  readonly commitSha: string
  readonly parentShas: readonly string[]
  readonly changedPaths: readonly string[]
  readonly op: string
  readonly authorUser: string
  readonly agentKind: string | null
  readonly threadId: string | null
  readonly runId: string | null
  readonly createdAt: Date
}

/** Per-path difference between two commits. */
export interface DiffRecord {
  readonly path: string
  readonly beforeSha: string | null
  readonly afterSha: string | null
  readonly beforeMode?: number
  readonly afterMode?: number
}

/** Per-mount merge outcome governed by architecture §6.2. */
export type MergeResult =
  | { readonly status: 'merged' | 'unauthorized' | 'pendingApproval' }
  | {
      readonly status: 'conflicts'
      readonly conflicts: readonly {
        path: string
        baseSha?: string
        oursSha?: string
        theirsSha?: string
      }[]
    }

type MergeAttemptResult =
  | 'merged'
  | 'unauthorized'
  | 'pendingApproval'
  | { readonly conflicts: Extract<MergeResult, { status: 'conflicts' }>['conflicts'] }

/** File and history operations bound to a mount; the handle/plain-path split is required by architecture §6.2. */
export interface MountFileSystem {
  read(path: string): Promise<string>
  readBytes(path: string): Promise<Buffer>
  write(path: string, bytes: Buffer | Uint8Array | string, options?: WriteOptions): Promise<WriteResult>
  edit(path: string, edits: readonly TextEdit[], options?: EditOptions): Promise<WriteResult>
  list(dir: string): Promise<readonly SessionEntry[]>
  glob(pattern: string): Promise<readonly SessionEntry[]>
  stat(path: string): Promise<SessionStat>
  delete(path: string, options?: { ifSha?: string | null }): Promise<DeleteResult>
  history(path: string): Promise<readonly HistoryRecord[]>
}

/** Open-session metadata and history controls defined by architecture §6.2. */
export interface SessionFileSystem {
  readonly actor: Actor
  readonly sessionId: string
  mount(key: string): MountFileSystem
  timeline(filter?: TimelineFilter): Promise<readonly TimelineRecord[]>
  diff(a: string, b: string): Promise<readonly DiffRecord[]>
  /** Stream a blob without buffering CAS bytes (§8.1). */
  readStream(mountKey: string, path: string): Promise<Readable>
  merge(options?: {
    mounts?: readonly string[]
    approver?: Actor
  }): Promise<Readonly<Partial<Record<string, MergeResult>>>>
  writeStream(mountKey: string, path: string, source: Readable): Promise<WriteResult>
  /** Issue a store-native GET or checksum-pinned PUT URL (§8.1). */
  presign(mountKey: string, path: string, options?: PresignOptions): Promise<string>
  restore(mountKey: string, at: string): Promise<RestoreResult>
  tag(mountKey: string, label: string): Promise<string>
  discard(): Promise<void>
}

type RefMount = {
  readonly key: string
  readonly mode: 'follow' | { readonly pin: string }
  readonly ref?: string
  readonly fork?: ForkResult
}
type VirtualMount = {
  readonly key: string
  readonly virtual: VirtualMountHandler
}
type Mount = RefMount | VirtualMount

type Head = {
  path: string
  sha256: string
  sizeBytes: bigint
  mode: number
  blobId?: string
}
type CommitRow = {
  id: string
  commit_sha: string
  parents: unknown
  op: string
  author_user: string
  agent_kind: string | null
  thread_id: string | null
  run_id: string | null
  created_at: Date | string
}

function asParentArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(item => String(item))
  if (typeof value === 'string') return value.replace(/[{}]/g, '').split(',').filter(Boolean)
  return []
}

function bytesFor(value: Buffer | Uint8Array | string): Buffer {
  return Buffer.isBuffer(value) ? value : Buffer.from(value)
}

function globRegex(pattern: string): RegExp {
  let source = '^'
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index]
    if (char === '*') {
      if (pattern[index + 1] === '*') {
        if (pattern[index + 2] === '/') {
          source += '(?:.*/)?'
          index += 2
        } else {
          source += '.*'
          index += 1
        }
      } else source += '[^/]*'
    } else if (char === '?') source += '[^/]'
    else source += /[\\^$+?.()|[\]{}]/u.test(char) ? `\\${char}` : char
  }
  return new RegExp(`${source}$`, 'u')
}
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/gu, character => `\\${character}`)
}
/** Merge grants are refreshed after 100ms of pool wait to bound authorization staleness. */
const MERGE_GRANT_FRESHNESS_MS = 100

function changedPaths(before: Map<string, Head>, after: Map<string, Head>): string[] {
  const paths = new Set([...before.keys(), ...after.keys()])
  return [...paths]
    .filter(path => {
      const old = before.get(path)
      const next = after.get(path)
      return old?.sha256 !== next?.sha256 || old?.mode !== next?.mode
    })
    .sort()
}
function sameHead(left: Head | undefined, right: Head | undefined): boolean {
  if (!left || !right) return left === right
  return left.sha256 === right.sha256 && left.mode === right.mode
}

type SessionKernel = Omit<TuddoFsKernel, 'open'> & {
  writeStored(input: {
    readonly tenant: string
    readonly mount: string
    readonly ref: string
    readonly path: string
    readonly sha256: string
    readonly sizeBytes: bigint
    readonly objectKey: string
    readonly authorUser: string
    readonly agentKind?: string | null
    readonly threadId?: string | null
    readonly runId?: string | null
  }): Promise<WriteResult>
}
/** Build the session API over a kernel and its host options. */
export function createSessionApi(kernel: SessionKernel, options: TuddoFsOptions) {
  return {
    invalidate(actorId: string, mountKey?: string, tenant?: string) {
      kernel.invalidate(actorId, mountKey, tenant)
    },
    async open(input: OpenInput): Promise<SessionFileSystem> {
      if (!input.actor.id || input.actor.id === 'system')
        throw new PermissionDeniedError('Session actor must be an executing user', { tenant: input.actor.tenant })
      const mounts = new Map<string, Mount>()
      for (const rawSpec of input.mounts) {
        const spec: MountSpec = typeof rawSpec === 'string' ? { key: rawSpec } : rawSpec
        const key = validateMountKey(spec.key, {
          tenant: input.actor.tenant,
          mount: spec.key,
        })
        if (mounts.has(key))
          throw new PermissionDeniedError(`Duplicate mount: ${key}`, {
            tenant: input.actor.tenant,
            mount: key,
          })
        if ('virtual' in spec) {
          mounts.set(key, { key, virtual: spec.virtual })
          continue
        }
        const mode = spec.mode ?? 'follow'
        const grant = await kernel.resolveGrant(input.actor, { key }, { bypassCache: true })
        if (!grant.read)
          throw new PermissionDeniedError('Read permission denied', {
            tenant: input.actor.tenant,
            mount: key,
          })
        if (typeof mode === 'object') {
          mounts.set(key, { key, mode })
          continue
        }
        const fork = await kernel.fork({
          tenant: input.actor.tenant,
          mount: key,
          sessionId: input.sessionId,
          authorUser: input.actor.id,
          agentKind: input.attribution?.agentKind,
          threadId: input.attribution?.threadId,
          runId: input.attribution?.runId,
        })
        if (!fork)
          throw new PermissionDeniedError('Read permission denied', {
            tenant: input.actor.tenant,
            mount: key,
          })
        mounts.set(key, { key, mode, ref: fork.ref, fork })
      }

      const mountFor = (mountKey: string, rawPath: string, allowRoot = false): { mount: Mount; path: string } => {
        const mount = mounts.get(mountKey)
        if (!mount)
          throw new NotFoundError(`Mount not found: ${mountKey}`, {
            tenant: input.actor.tenant,
            mount: mountKey,
          })
        const path =
          allowRoot && rawPath === '/'
            ? '/'
            : validatePath(rawPath, {
                tenant: input.actor.tenant,
                mount: mountKey,
              })
        return { mount, path }
      }

      const readVirtual = async (mount: VirtualMount, path: string): Promise<Buffer> => {
        const bytes = await mount.virtual.read(path, input.actor)
        if (!bytes)
          throw new NotFoundError(`Path not found: ${path}`, {
            tenant: input.actor.tenant,
            mount: mount.key,
            path,
          })
        return Buffer.from(bytes)
      }

      const refFor = (mount: RefMount): string => {
        if (mount.ref) return mount.ref
        return `mount/${mount.key}`
      }
      const ensureRead = async (mount: RefMount, resolutionOptions: { bypassCache?: boolean } = {}): Promise<void> => {
        const grant = await kernel.resolveGrant(input.actor, { key: mount.key }, resolutionOptions)
        if (!grant.read)
          throw new PermissionDeniedError('Read permission denied', {
            tenant: input.actor.tenant,
            mount: mount.key,
          })
      }

      type LineageCommit = { id: string; commit_sha: string }
      const assertCommitInMountLineage = async (
        client: TuddoFsClient,
        mountKey: string,
        commitSha: string,
      ): Promise<LineageCommit> => {
        const result = await client.query<LineageCommit>(
          `WITH RECURSIVE lineage(id) AS (
             SELECT r.commit_id
             FROM tuddo_refs r
             WHERE r.tenant = $1
               AND (
                 r.name = $2
                 OR (r.kind = 'tag' AND r.name LIKE $3 ESCAPE E'\\\\')
                 OR r.name = $4
               )
             UNION
             SELECT parent_id
             FROM lineage current
             JOIN tuddo_commits c ON c.id = current.id
             CROSS JOIN LATERAL unnest(c.parents) AS parent_id
           )
           SELECT c.id::text, c.commit_sha
           FROM lineage
           JOIN tuddo_commits c ON c.id = lineage.id
           WHERE c.tenant = $1 AND c.commit_sha = $5
           LIMIT 1`,
          [
            input.actor.tenant,
            `mount/${mountKey}`,
            `tag/${escapeLike(mountKey)}/%`,
            `agent/${input.sessionId}/${mountKey}`,
            commitSha,
          ],
        )
        const row = result.rows[0]
        if (!row)
          throw new NotFoundError(`Commit not found in mount lineage: ${commitSha}`, {
            tenant: input.actor.tenant,
            mount: mountKey,
          })
        return row
      }

      const pinnedRef = async (mount: RefMount): Promise<{ ref: string; commitId: string }> => {
        if (mount.mode === 'follow') return { ref: refFor(mount), commitId: '' }
        const pin = mount.mode.pin
        const client = await options.pool.connect()
        try {
          let row: LineageCommit | undefined
          if (pin.startsWith('mount/') || pin.startsWith('tag/') || pin.startsWith('agent/')) {
            const result = await client.query<LineageCommit>(
              `SELECT c.id::text, c.commit_sha
               FROM tuddo_refs r JOIN tuddo_commits c ON c.id = r.commit_id
               WHERE r.tenant = $1 AND r.name = $2
                 AND (
                   r.name = $3
                   OR (r.kind = 'tag' AND r.name LIKE $4 ESCAPE E'\\\\')
                   OR r.name = $5
                 )`,
              [
                input.actor.tenant,
                pin,
                `mount/${mount.key}`,
                `tag/${escapeLike(mount.key)}/%`,
                `agent/${input.sessionId}/${mount.key}`,
              ],
            )
            row = result.rows[0]
          } else {
            row = await assertCommitInMountLineage(client, mount.key, pin)
          }
          if (!row)
            throw new NotFoundError(`Pinned commit not found: ${pin}`, {
              tenant: input.actor.tenant,
              mount: mount.key,
            })
          return {
            ref: `__pin/${input.sessionId}/${mount.key}`,
            commitId: row.id,
          }
        } finally {
          client.release()
        }
      }

      const readPinned = async (mount: RefMount, path: string): Promise<ReadResult> => {
        await ensureRead(mount)
        const pin = await pinnedRef(mount)
        const client = await options.pool.connect()
        try {
          const result = await client.query<{
            path: string
            sha256: string
            size_bytes: string
            mode: number
            inline: Buffer | null
            object_key: string | null
            commit_sha: string
          }>(
            `SELECT e.path, b.sha256, b.size_bytes::text, e.mode, b.inline, b.object_key, c.commit_sha
             FROM tuddo_commits c JOIN tuddo_tree_entries e ON e.tree_id = c.tree_id
             JOIN tuddo_blobs b ON b.id = e.blob_id
             WHERE c.tenant = $1 AND c.id = $2::bigint AND e.path = $3`,
            [input.actor.tenant, pin.commitId, path],
          )
          const row = result.rows[0]
          if (!row)
            throw new NotFoundError(`Path not found: ${path}`, {
              tenant: input.actor.tenant,
              mount: mount.key,
              path,
            })
          let bytes: Buffer
          if (row.inline) bytes = Buffer.from(row.inline)
          else if (row.object_key && options.storage)
            bytes = await readAll(options, row.object_key, {
              tenant: input.actor.tenant,
              mount: mount.key,
              path,
            })
          else
            throw new NotFoundError(`Blob unavailable: ${path}`, {
              tenant: input.actor.tenant,
              mount: mount.key,
              path,
            })
          return {
            path,
            sha256: row.sha256,
            sizeBytes: BigInt(row.size_bytes),
            mode: row.mode,
            bytes,
            commitSha: row.commit_sha,
          }
        } finally {
          client.release()
        }
      }

      const readStream = async (mountKey: string, rawPath: string): Promise<Readable> => {
        const { mount, path } = mountFor(mountKey, rawPath)
        if ('virtual' in mount) return Readable.from([await readVirtual(mount, path)])
        await ensureRead(mount)
        const commitId = mount.mode === 'follow' ? undefined : (await pinnedRef(mount)).commitId
        const client = await options.pool.connect()
        try {
          const result = await client.query<{
            path: string
            sha256: string
            size_bytes: string
            mode: number
            inline: Buffer | null
            object_key: string | null
          }>(
            `SELECT e.path, b.sha256, b.size_bytes::text, e.mode, b.inline, b.object_key
             FROM tuddo_commits c
             JOIN tuddo_tree_entries e ON e.tree_id = c.tree_id
             JOIN tuddo_blobs b ON b.id = e.blob_id
             WHERE c.tenant = $1
               AND c.id = COALESCE(
                 $2::bigint,
                 (SELECT commit_id FROM tuddo_refs WHERE tenant = $1 AND name = $3)
               )
               AND e.path = $4`,
            [input.actor.tenant, commitId ?? null, mount.mode === 'follow' ? refFor(mount) : null, path],
          )
          const row = result.rows[0]
          if (!row)
            throw new NotFoundError(`Path not found: ${path}`, {
              tenant: input.actor.tenant,
              mount: mount.key,
              path,
            })
          if (row.inline) return Readable.from([Buffer.from(row.inline)])
          if (!row.object_key || !options.storage)
            throw new StorageError('Blob has no readable storage backend', {
              tenant: input.actor.tenant,
              mount: mount.key,
              path,
            })
          try {
            return await options.storage.get(row.object_key)
          } catch (error) {
            if (error instanceof StorageError) throw error
            throw new StorageError(error instanceof Error ? error.message : 'Object storage failed', {
              tenant: input.actor.tenant,
              mount: mount.key,
              path,
            })
          }
        } finally {
          client.release()
        }
      }

      const readBytes = async (mountKey: string, rawPath: string): Promise<Buffer> => {
        const { mount, path } = mountFor(mountKey, rawPath)
        if ('virtual' in mount) return readVirtual(mount, path)
        const result =
          mount.mode === 'follow'
            ? await kernel.read({
                tenant: input.actor.tenant,
                mount: mount.key,
                ref: refFor(mount),
                path,
                authorUser: input.actor.id,
              })
            : await readPinned(mount, path)
        return result.bytes
      }
      const writeStream = async (mountKey: string, rawPath: string, source: Readable): Promise<WriteResult> => {
        const { mount, path } = mountFor(mountKey, rawPath)
        if ('virtual' in mount) {
          if (!mount.virtual.write)
            throw new PermissionDeniedError('Virtual mount is read-only', {
              tenant: input.actor.tenant,
              mount: mount.key,
              path,
            })
          const chunks: Buffer[] = []
          for await (const chunk of source)
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array))
          const bytes = Buffer.concat(chunks)
          await mount.virtual.write(path, bytes, input.actor)
          return { path, sha256: sha256(bytes), sizeBytes: BigInt(bytes.length), commitSha: '' }
        }
        if (mount.mode !== 'follow')
          throw new PermissionDeniedError('Pinned mount is read-only', {
            tenant: input.actor.tenant,
            mount: mount.key,
            path,
          })
        const grant = await kernel.resolveGrant(input.actor, { key: mount.key })
        if (grant.write === 'none')
          throw new PermissionDeniedError('Write permission denied', {
            tenant: input.actor.tenant,
            mount: mount.key,
            path,
          })
        const storage = options.storage
        if (!storage)
          throw new StorageError('Streaming writes require an object storage backend', {
            tenant: input.actor.tenant,
            mount: mount.key,
            path,
          })
        const quarantineKey = `tuddo/${input.actor.tenant}/quarantine/${randomUUID()}`
        const digest = createHash('sha256')
        let sizeBytes = 0n
        const hashing = new Transform({
          transform(chunk: Buffer | Uint8Array, _encoding, callback) {
            const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
            digest.update(bytes)
            sizeBytes += BigInt(bytes.length)
            callback(null, bytes)
          },
        })
        try {
          await storage.put(quarantineKey, source.pipe(hashing))
          const contentSha = digest.digest('hex')
          if (sizeBytes <= BigInt(options.inlineMaxBytes ?? 131_072)) {
            const chunks: Buffer[] = []
            for await (const chunk of await storage.get(quarantineKey))
              chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array))
            return await kernel.write({
              tenant: input.actor.tenant,
              mount: mount.key,
              ref: refFor(mount),
              path,
              bytes: Buffer.concat(chunks),
              authorUser: input.actor.id,
              agentKind: input.attribution?.agentKind,
              threadId: input.attribution?.threadId,
              runId: input.attribution?.runId,
            })
          }
          if (!storage.copy)
            throw new StorageError('Streaming writes require server-side object copy support', {
              tenant: input.actor.tenant,
              mount: mount.key,
              path,
            })
          const objectKey = `tuddo/${input.actor.tenant}/${contentSha}`
          await storage.copy(quarantineKey, objectKey)
          return await kernel.writeStored({
            tenant: input.actor.tenant,
            mount: mount.key,
            ref: refFor(mount),
            path,
            sha256: contentSha,
            sizeBytes,
            objectKey,
            authorUser: input.actor.id,
            agentKind: input.attribution?.agentKind,
            threadId: input.attribution?.threadId,
            runId: input.attribution?.runId,
          })
        } catch (error) {
          if (error instanceof TuddoFsError) throw error
          throw new StorageError(error instanceof Error ? error.message : 'Object storage failed', {
            tenant: input.actor.tenant,
            mount: mount.key,
            path,
          })
        } finally {
          await storage.delete(quarantineKey).catch(() => undefined)
        }
      }

      const presign = async (
        mountKey: string,
        rawPath: string,
        presignOptions: PresignOptions = {},
      ): Promise<string> => {
        const { mount, path } = mountFor(mountKey, rawPath)
        const method = presignOptions.method ?? 'GET'
        const ttlSeconds = presignOptions.ttlSeconds ?? 900
        const context = { tenant: input.actor.tenant, mount: mount.key, path }
        if (!Number.isInteger(ttlSeconds) || ttlSeconds <= 0)
          throw new StorageError('Presign TTL must be a positive integer', context)
        if ('virtual' in mount) throw new StorageError('Virtual mounts have no object-storage presign', context)
        const storage = options.storage
        if (!storage) throw new StorageError('Presigning requires an object storage backend', context)
        if (method === 'PUT') {
          const grant = await kernel.resolveGrant(input.actor, { key: mount.key })
          if (grant.write === 'none') throw new PermissionDeniedError('Write permission denied', context)
          if (mount.mode !== 'follow') throw new PermissionDeniedError('Pinned mount is read-only', context)
          const checksum = presignOptions.sha256
          if (!checksum) throw new StorageError('PUT presigns require a sha256 checksum', context)
          if (!storage.presignPut) throw new StorageError('Object storage does not support PUT presigning', context)
          const objectKey = `tuddo/${input.actor.tenant}/${checksum}`
          try {
            return await storage.presignPut(objectKey, { ttlSeconds, checksumSha256: checksum })
          } catch (error) {
            if (error instanceof StorageError) throw error
            throw new StorageError(error instanceof Error ? error.message : 'Object storage failed', context)
          }
        }
        // `method` is a closed union; GET is the only remaining branch.
        await ensureRead(mount)
        const commitId = mount.mode === 'follow' ? undefined : (await pinnedRef(mount)).commitId
        const client = await options.pool.connect()
        try {
          const result = await client.query<{ object_key: string | null; inline: Buffer | null }>(
            `SELECT b.object_key, b.inline
             FROM tuddo_commits c
             JOIN tuddo_tree_entries e ON e.tree_id = c.tree_id
             JOIN tuddo_blobs b ON b.id = e.blob_id
             WHERE c.tenant = $1
               AND c.id = COALESCE(
                 $2::bigint,
                 (SELECT commit_id FROM tuddo_refs WHERE tenant = $1 AND name = $3)
               )
               AND e.path = $4`,
            [input.actor.tenant, commitId ?? null, mount.mode === 'follow' ? refFor(mount) : null, path],
          )
          const row = result.rows[0]
          if (!row) throw new NotFoundError(`Path not found: ${path}`, context)
          if (row.inline || !row.object_key) throw new StorageError('Inline blobs do not have presigned URLs', context)
          if (!storage.presignGet) throw new StorageError('Object storage does not support GET presigning', context)
          try {
            return await storage.presignGet(row.object_key, { ttlSeconds })
          } catch (error) {
            if (error instanceof StorageError) throw error
            throw new StorageError(error instanceof Error ? error.message : 'Object storage failed', context)
          }
        } finally {
          client.release()
        }
      }

      const listRef = async (mount: RefMount, dir: string): Promise<SessionEntry[]> => {
        const client = await options.pool.connect()
        try {
          let rows: Head[]
          if (mount.mode === 'follow') {
            const result = await client.query<{
              path: string
              sha256: string
              size_bytes: string
              mode: number
            }>(
              `SELECT h.path, h.sha256, h.size_bytes::text, COALESCE(e.mode, 420)::int AS mode
               FROM tuddo_heads h JOIN tuddo_refs r ON r.tenant = h.tenant AND r.name = h.ref_name
               JOIN tuddo_commits c ON c.id = r.commit_id
               LEFT JOIN tuddo_tree_entries e ON e.tree_id = c.tree_id AND e.path = h.path
               WHERE h.tenant = $1 AND h.ref_name = $2 ORDER BY h.path`,
              [input.actor.tenant, refFor(mount)],
            )
            rows = result.rows.map(row => ({
              path: row.path,
              sha256: row.sha256,
              sizeBytes: BigInt(row.size_bytes),
              mode: row.mode,
            }))
          } else {
            const pin = await pinnedRef(mount)
            const result = await client.query<{
              path: string
              sha256: string
              size_bytes: string
              mode: number
            }>(
              `SELECT e.path, b.sha256, b.size_bytes::text, e.mode
               FROM tuddo_commits c JOIN tuddo_tree_entries e ON e.tree_id = c.tree_id JOIN tuddo_blobs b ON b.id = e.blob_id
               WHERE c.tenant = $1 AND c.id = $2::bigint ORDER BY e.path`,
              [input.actor.tenant, pin.commitId],
            )
            rows = result.rows.map(row => ({
              path: row.path,
              sha256: row.sha256,
              sizeBytes: BigInt(row.size_bytes),
              mode: row.mode,
            }))
          }
          const direct = new Map<string, SessionEntry>()
          for (const row of rows) {
            const relative = row.path.slice(1)
            const prefix = dir === '/' ? '' : `${dir.slice(1)}/`
            if (!relative.startsWith(prefix)) continue
            const rest = relative.slice(prefix.length)
            if (!rest || rest.includes('/')) {
              const first = rest.split('/')[0]
              if (first)
                direct.set(`${dir === '/' ? '' : dir}/${first}`, {
                  path: `${dir === '/' ? '' : dir}/${first}`,
                  type: 'directory',
                })
              continue
            }
            direct.set(row.path, {
              path: row.path,
              type: 'file',
              sha256: row.sha256,
              sizeBytes: row.sizeBytes,
              mode: row.mode,
            })
          }
          return [...direct.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
        } finally {
          client.release()
        }
      }
      const allRefEntries = async (mount: RefMount): Promise<SessionEntry[]> => {
        const client = await options.pool.connect()
        try {
          if (mount.mode === 'follow') {
            const result = await client.query<{
              path: string
              sha256: string
              size_bytes: string
              mode: number
            }>(
              `SELECT h.path, h.sha256, h.size_bytes::text, COALESCE(e.mode, 420)::int AS mode
               FROM tuddo_heads h JOIN tuddo_refs r ON r.tenant = h.tenant AND r.name = h.ref_name
               JOIN tuddo_commits c ON c.id = r.commit_id
               LEFT JOIN tuddo_tree_entries e ON e.tree_id = c.tree_id AND e.path = h.path
               WHERE h.tenant = $1 AND h.ref_name = $2 ORDER BY h.path`,
              [input.actor.tenant, refFor(mount)],
            )
            return result.rows.map(row => ({
              path: row.path,
              type: 'file',
              sha256: row.sha256,
              sizeBytes: BigInt(row.size_bytes),
              mode: row.mode,
            }))
          }
          const pin = await pinnedRef(mount)
          const result = await client.query<{
            path: string
            sha256: string
            size_bytes: string
            mode: number
          }>(
            `SELECT e.path, b.sha256, b.size_bytes::text, e.mode
             FROM tuddo_commits c JOIN tuddo_tree_entries e ON e.tree_id = c.tree_id JOIN tuddo_blobs b ON b.id = e.blob_id
             WHERE c.tenant = $1 AND c.id = $2::bigint ORDER BY e.path`,
            [input.actor.tenant, pin.commitId],
          )
          return result.rows.map(row => ({
            path: row.path,
            type: 'file',
            sha256: row.sha256,
            sizeBytes: BigInt(row.size_bytes),
            mode: row.mode,
          }))
        } finally {
          client.release()
        }
      }
      const allVirtualEntries = async (mount: VirtualMount): Promise<SessionEntry[]> => {
        const entries = new Map<string, SessionEntry>()
        const pending = ['/']
        const visited = new Set<string>()
        while (pending.length > 0) {
          const dir = pending.shift()!
          if (visited.has(dir)) continue
          visited.add(dir)
          for (const entry of await mount.virtual.list(dir, input.actor)) {
            entries.set(entry.path, entry)
            if (entry.type === 'directory' && !visited.has(entry.path)) pending.push(entry.path)
          }
        }
        return [...entries.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
      }

      const resolveCommit = async (
        value: string,
        preferredMountKey?: string,
        optionsForResolution: { checkRead?: boolean } = {},
      ): Promise<{ id: string; sha: string; mountKey: string }> => {
        const candidates = [...mounts.values()].filter((mount): mount is RefMount => !('virtual' in mount))
        for (const mount of candidates) {
          if (preferredMountKey !== undefined && preferredMountKey !== mount.key) continue
          const client = await options.pool.connect()
          let confined: LineageCommit
          try {
            let candidateSha = value
            if (preferredMountKey !== undefined && !/^[0-9a-f]{64}$/u.test(value)) {
              const tagName = value.startsWith('tag/') ? value : `tag/${mount.key}/${value}`
              const tag = await client.query<{ commit_sha: string }>(
                `SELECT c.commit_sha
                 FROM tuddo_refs r JOIN tuddo_commits c ON c.id = r.commit_id
                 WHERE r.tenant = $1 AND r.name = $2 AND r.kind = 'tag'`,
                [input.actor.tenant, tagName],
              )
              if (tag.rows[0]) candidateSha = tag.rows[0].commit_sha
            }
            try {
              confined = await assertCommitInMountLineage(client, mount.key, candidateSha)
            } catch (error) {
              if (error instanceof NotFoundError) continue
              throw error
            }
          } finally {
            client.release()
          }
          if (optionsForResolution.checkRead !== false) await ensureRead(mount, { bypassCache: true })
          return {
            id: confined.id,
            sha: confined.commit_sha,
            mountKey: mount.key,
          }
        }
        throw new NotFoundError(`Commit not found in granted mount lineage: ${value}`, {
          tenant: input.actor.tenant,
          ...(preferredMountKey === undefined ? {} : { mount: preferredMountKey }),
        })
      }

      const readTree = async (client: TuddoFsClient, commitId: string): Promise<Map<string, Head>> => {
        const result = await client.query<{
          path: string
          blob_id: string
          sha256: string
          size_bytes: string
          mode: number
        }>(
          `SELECT e.path, e.blob_id::text, b.sha256, b.size_bytes::text, e.mode
           FROM tuddo_commits c JOIN tuddo_tree_entries e ON e.tree_id = c.tree_id JOIN tuddo_blobs b ON b.id = e.blob_id
           WHERE c.tenant = $1 AND c.id = $2::bigint`,
          [input.actor.tenant, commitId],
        )
        return new Map(
          result.rows.map(row => [
            row.path,
            {
              path: row.path,
              sha256: row.sha256,
              sizeBytes: BigInt(row.size_bytes),
              mode: row.mode,
              blobId: row.blob_id,
            },
          ]),
        )
      }

      const readTrees = async (
        client: TuddoFsClient,
        commitIds: readonly string[],
      ): Promise<Map<string, Map<string, Head>>> => {
        const trees = new Map<string, Map<string, Head>>()
        for (const commitId of commitIds) trees.set(commitId, new Map())
        if (commitIds.length === 0) return trees
        const result = await client.query<{
          commit_id: string
          path: string
          blob_id: string
          sha256: string
          size_bytes: string
          mode: number
        }>(
          `SELECT c.id::text AS commit_id, e.path, e.blob_id::text, b.sha256, b.size_bytes::text, e.mode
           FROM tuddo_commits c
           JOIN tuddo_tree_entries e ON e.tree_id = c.tree_id
           JOIN tuddo_blobs b ON b.id = e.blob_id
           WHERE c.tenant = $1 AND c.id = ANY($2::bigint[])`,
          [input.actor.tenant, [...commitIds]],
        )
        for (const row of result.rows) {
          trees.get(row.commit_id)?.set(row.path, {
            path: row.path,
            sha256: row.sha256,
            sizeBytes: BigInt(row.size_bytes),
            mode: row.mode,
            blobId: row.blob_id,
          })
        }
        return trees
      }
      const unsupportedVirtual = (mountKey: string, path?: string): never => {
        throw new NotFoundError('Virtual mount has no history or branches', {
          tenant: input.actor.tenant,
          mount: mountKey,
          ...(path === undefined ? {} : { path }),
        })
      }
      type SessionOperations = SessionFileSystem & {
        read(mountKey: string, path: string): Promise<string>
        readBytes(mountKey: string, path: string): Promise<Buffer>
        write(
          mountKey: string,
          path: string,
          value: Buffer | Uint8Array | string,
          options?: WriteOptions,
        ): Promise<WriteResult>
        edit(mountKey: string, path: string, edits: readonly TextEdit[], options?: EditOptions): Promise<WriteResult>
        list(mountKey: string, dir: string): Promise<readonly SessionEntry[]>
        glob(mountKey: string, pattern: string): Promise<readonly SessionEntry[]>
        stat(mountKey: string, path: string): Promise<SessionStat>
        delete(mountKey: string, path: string, options?: { ifSha?: string | null }): Promise<DeleteResult>
        history(mountKey: string, path: string): Promise<readonly HistoryRecord[]>
      }
      const sessionOps: SessionOperations = {
        actor: input.actor,
        sessionId: input.sessionId,
        mount(key: string) {
          validateMountKey(key, { tenant: input.actor.tenant, mount: key })
          if (!mounts.has(key))
            throw new NotFoundError(`Mount not found: ${key}`, {
              tenant: input.actor.tenant,
              mount: key,
            })
          return {
            read: (path: string) => sessionOps.read(key, path),
            readBytes: (path: string) => sessionOps.readBytes(key, path),
            write: (path, value, writeOptions) => sessionOps.write(key, path, value, writeOptions),
            edit: (path, edits, editOptions) => sessionOps.edit(key, path, edits, editOptions),
            list: (path: string) => sessionOps.list(key, path),
            glob: (pattern: string) => sessionOps.glob(key, pattern),
            stat: (path: string) => sessionOps.stat(key, path),
            delete: (path, deleteOptions) => sessionOps.delete(key, path, deleteOptions),
            history: (path: string) => sessionOps.history(key, path),
          }
        },
        async read(mountKey: string, path: string) {
          return (await sessionOps.readBytes(mountKey, path)).toString('utf8')
        },
        readBytes: (mountKey: string, path: string) => readBytes(mountKey, path),
        readStream: (mountKey: string, path: string) => readStream(mountKey, path),
        writeStream: (mountKey: string, path: string, source: Readable) => writeStream(mountKey, path, source),
        presign: (mountKey: string, path: string, options?: PresignOptions) => presign(mountKey, path, options),
        async write(
          mountKey: string,
          rawPath: string,
          value: Buffer | Uint8Array | string,
          writeOptions: WriteOptions = {},
        ) {
          const { mount, path } = mountFor(mountKey, rawPath)
          const bytes = bytesFor(value)
          if ('virtual' in mount) {
            if (!mount.virtual.write)
              throw new PermissionDeniedError('Virtual mount is read-only', {
                tenant: input.actor.tenant,
                mount: mount.key,
                path,
              })
            await mount.virtual.write(path, bytes, input.actor)
            return {
              path,
              sha256: sha256(bytes),
              sizeBytes: BigInt(bytes.length),
              commitSha: '',
            }
          }
          if (mount.mode !== 'follow')
            throw new PermissionDeniedError('Pinned mount is read-only', {
              tenant: input.actor.tenant,
              mount: mount.key,
              path,
            })
          const grant = await kernel.resolveGrant(input.actor, {
            key: mount.key,
          })
          if (grant.write === 'none')
            throw new PermissionDeniedError('Write permission denied', {
              tenant: input.actor.tenant,
              mount: mount.key,
              path,
            })
          return kernel.write({
            tenant: input.actor.tenant,
            mount: mount.key,
            ref: refFor(mount),
            path,
            bytes,
            ifSha: writeOptions.ifSha,
            authorUser: input.actor.id,
            agentKind: input.attribution?.agentKind,
            threadId: input.attribution?.threadId,
            runId: input.attribution?.runId,
          })
        },
        async edit(mountKey: string, rawPath: string, edits: readonly TextEdit[], editOptions: EditOptions = {}) {
          const { mount, path } = mountFor(mountKey, rawPath)
          const old = await readBytes(mountKey, rawPath)
          const currentSha = sha256(old)
          if (editOptions.ifSha !== undefined && editOptions.ifSha !== currentSha)
            throw new PreconditionFailedError(editOptions.ifSha, currentSha, {
              tenant: input.actor.tenant,
              mount: mount.key,
              path,
            })
          let text = old.toString('utf8')
          for (const edit of edits) {
            let count = 0
            if (edit.oldText.length === 0) count = text.length + 1
            else {
              let offset = 0
              while (true) {
                const match = text.indexOf(edit.oldText, offset)
                if (match === -1) break
                count += 1
                offset = match + edit.oldText.length
              }
            }
            if (!edit.replaceAll && count !== 1)
              throw new EditMatchError(count, { tenant: input.actor.tenant, mount: mount.key, path })
            text = edit.replaceAll
              ? text.replaceAll(edit.oldText, edit.newText)
              : text.replace(edit.oldText, edit.newText)
          }
          return sessionOps.write(mountKey, rawPath, text, { ifSha: currentSha })
        },
        async list(mountKey: string, rawPath: string) {
          const { mount, path } = mountFor(mountKey, rawPath, true)
          if ('virtual' in mount) return mount.virtual.list(path, input.actor)
          await ensureRead(mount)
          return listRef(mount, path)
        },
        async glob(mountKey: string, pattern: string) {
          const { mount, path } = mountFor(mountKey, pattern)
          if (!('virtual' in mount)) await ensureRead(mount)
          const matcher = globRegex(path)
          const entries = 'virtual' in mount ? await allVirtualEntries(mount) : await allRefEntries(mount)
          return entries.filter(entry => matcher.test(entry.path))
        },
        async stat(mountKey: string, rawPath: string) {
          const { mount, path } = mountFor(mountKey, rawPath)
          if ('virtual' in mount) {
            const bytes = await readVirtual(mount, path)
            return {
              path,
              sha256: sha256(bytes),
              sizeBytes: BigInt(bytes.length),
              mode: 420,
            }
          }
          const result =
            mount.mode === 'follow'
              ? await kernel.read({
                  tenant: input.actor.tenant,
                  mount: mount.key,
                  ref: refFor(mount),
                  path,
                  authorUser: input.actor.id,
                })
              : await readPinned(mount, path)
          return {
            path,
            sha256: result.sha256,
            sizeBytes: result.sizeBytes,
            mode: result.mode,
          }
        },
        async delete(mountKey: string, rawPath: string, deleteOptions: { ifSha?: string | null } = {}) {
          const { mount, path } = mountFor(mountKey, rawPath)
          if ('virtual' in mount) {
            throw new PermissionDeniedError('Virtual mount does not support delete', {
              tenant: input.actor.tenant,
              mount: mount.key,
              path,
            })
          }
          if (mount.mode !== 'follow')
            throw new PermissionDeniedError('Pinned mount is read-only', {
              tenant: input.actor.tenant,
              mount: mount.key,
              path,
            })
          return kernel.delete({
            tenant: input.actor.tenant,
            mount: mount.key,
            ref: refFor(mount),
            path,
            ifSha: deleteOptions.ifSha,
            authorUser: input.actor.id,
            agentKind: input.attribution?.agentKind,
            threadId: input.attribution?.threadId,
            runId: input.attribution?.runId,
          })
        },
        async history(mountKey: string, rawPath: string) {
          const { mount, path } = mountFor(mountKey, rawPath)
          if ('virtual' in mount) return unsupportedVirtual(mount.key, path)
          await ensureRead(mount, { bypassCache: true })
          const client = await options.pool.connect()
          try {
            const ref = refFor(mount)
            const tip = await client.query<{ commit_sha: string }>(
              `SELECT c.commit_sha
               FROM tuddo_refs r JOIN tuddo_commits c ON c.id = r.commit_id
               WHERE r.tenant = $1 AND r.name = $2`,
              [input.actor.tenant, ref],
            )
            const tipRow = tip.rows[0]
            if (!tipRow)
              throw new NotFoundError(`Commit not found: ${ref}`, {
                tenant: input.actor.tenant,
                mount: mount.key,
                ref,
              })
            await assertCommitInMountLineage(client, mount.key, tipRow.commit_sha)
            const result = await client.query<CommitRow & { parent_shas: string[] }>(
              `WITH RECURSIVE lineage(id) AS (
                 SELECT r.commit_id
                 FROM tuddo_refs r
                 WHERE r.tenant = $1 AND r.name = $2
                 UNION
                 SELECT parent_id
                 FROM lineage current
                 JOIN tuddo_commits c ON c.id = current.id
                 CROSS JOIN LATERAL unnest(c.parents) AS parent_id
               )
               SELECT c.id::text, c.commit_sha, c.parents, c.op, c.author_user, c.agent_kind, c.thread_id, c.run_id, c.created_at,
                      COALESCE(
                        (SELECT array_agg(p.commit_sha ORDER BY array_position(c.parents, p.id))
                         FROM tuddo_commits p WHERE p.id = ANY(c.parents)),
                        '{}'
                      ) AS parent_shas
               FROM lineage JOIN tuddo_commits c ON c.id = lineage.id
               WHERE c.tenant = $1
                 AND (
                   (
                     cardinality(c.parents) = 0
                     AND EXISTS (
                       SELECT 1 FROM tuddo_tree_entries current_entry
                       WHERE current_entry.tree_id = c.tree_id AND current_entry.path = $3
                     )
                   )
                   OR EXISTS (
                     SELECT 1
                     FROM unnest(c.parents) AS parent_id
                     LEFT JOIN tuddo_commits parent ON parent.id = parent_id
                     LEFT JOIN tuddo_tree_entries current_entry
                       ON current_entry.tree_id = c.tree_id AND current_entry.path = $3
                     LEFT JOIN tuddo_blobs current_blob ON current_blob.id = current_entry.blob_id
                     LEFT JOIN tuddo_tree_entries parent_entry
                       ON parent_entry.tree_id = parent.tree_id AND parent_entry.path = $3
                     LEFT JOIN tuddo_blobs parent_blob ON parent_blob.id = parent_entry.blob_id
                    WHERE (current_entry.path = $3 OR parent_entry.path = $3)
                      AND (
                        current_blob.sha256 IS DISTINCT FROM parent_blob.sha256
                        OR current_entry.mode IS DISTINCT FROM parent_entry.mode
                      )
                   )
                 )
               ORDER BY c.id DESC`,
              [input.actor.tenant, ref, path],
            )
            return result.rows.map(row => ({
              commitSha: row.commit_sha,
              parentShas: row.parent_shas ?? asParentArray(row.parents),
              path,
              op: row.op,
              authorUser: row.author_user,
              agentKind: row.agent_kind,
              threadId: row.thread_id,
              runId: row.run_id,
              createdAt: new Date(row.created_at),
            }))
          } finally {
            client.release()
          }
        },
        async timeline(filter: TimelineFilter = {}) {
          const records = new Map<string, TimelineRecord>()
          const commitIds = new Map<string, bigint>()
          for (const mount of mounts.values()) {
            if ('virtual' in mount) continue
            await ensureRead(mount, { bypassCache: true })
            const client = await options.pool.connect()
            try {
              const ref = refFor(mount)
              const tip = await client.query<{ commit_sha: string }>(
                `SELECT c.commit_sha
                 FROM tuddo_refs r JOIN tuddo_commits c ON c.id = r.commit_id
                 WHERE r.tenant = $1 AND r.name = $2`,
                [input.actor.tenant, ref],
              )
              const tipRow = tip.rows[0]
              if (!tipRow) continue
              await assertCommitInMountLineage(client, mount.key, tipRow.commit_sha)
              const result = await client.query<CommitRow & { parent_shas: string[] }>(
                `WITH RECURSIVE lineage(id) AS (
                   SELECT r.commit_id
                   FROM tuddo_refs r
                   WHERE r.tenant = $1 AND r.name = $2
                   UNION
                   SELECT parent_id
                   FROM lineage current
                   JOIN tuddo_commits c ON c.id = current.id
                   CROSS JOIN LATERAL unnest(c.parents) AS parent_id
                 )
                 SELECT c.id::text, c.commit_sha, c.parents, c.op, c.author_user, c.agent_kind, c.thread_id, c.run_id, c.created_at,
                        COALESCE(
                          (SELECT array_agg(p.commit_sha ORDER BY array_position(c.parents, p.id))
                           FROM tuddo_commits p WHERE p.id = ANY(c.parents)),
                          '{}'
                        ) AS parent_shas
                 FROM lineage JOIN tuddo_commits c ON c.id = lineage.id
                 WHERE c.tenant = $1
                   AND ($3::text IS NULL OR c.run_id = $3)
                   AND ($4::text IS NULL OR c.agent_kind = $4)
                   AND ($5::text IS NULL OR c.thread_id = $5)
                 ORDER BY c.id`,
                [input.actor.tenant, ref, filter.runId ?? null, filter.agentKind ?? null, filter.threadId ?? null],
              )
              const treeIds = new Set<string>()
              for (const row of result.rows) {
                treeIds.add(row.id)
                for (const parent of asParentArray(row.parents)) treeIds.add(parent)
              }
              const trees = await readTrees(client, [...treeIds])
              for (const row of result.rows) {
                const after = trees.get(row.id) ?? new Map<string, Head>()
                const parents = asParentArray(row.parents)
                const before = parents[0] ? (trees.get(parents[0]) ?? new Map<string, Head>()) : new Map<string, Head>()
                records.set(row.commit_sha, {
                  commitSha: row.commit_sha,
                  parentShas: row.parent_shas ?? [],
                  changedPaths: changedPaths(before, after),
                  op: row.op,
                  authorUser: row.author_user,
                  agentKind: row.agent_kind,
                  threadId: row.thread_id,
                  runId: row.run_id,
                  createdAt: new Date(row.created_at),
                })
                commitIds.set(row.commit_sha, BigInt(row.id))
              }
            } finally {
              client.release()
            }
          }
          return [...records.entries()]
            .sort((left, right) => {
              const leftId = commitIds.get(left[0])!
              const rightId = commitIds.get(right[0])!
              return leftId < rightId ? -1 : leftId > rightId ? 1 : 0
            })
            .map(([, record]) => record)
        },
        async diff(a: string, b: string) {
          const first = resolveCommit(a)
          const second = resolveCommit(b)
          const [left, right] = await Promise.all([first, second])
          const client = await options.pool.connect()
          try {
            const before = await readTree(client, left.id)
            const after = await readTree(client, right.id)
            return changedPaths(before, after).map(path => ({
              path,
              beforeSha: before.get(path)?.sha256 ?? null,
              afterSha: after.get(path)?.sha256 ?? null,
              beforeMode: before.get(path)?.mode,
              afterMode: after.get(path)?.mode,
            }))
          } finally {
            client.release()
          }
        },
        async merge(mergeOptions = {}) {
          const results: Partial<Record<string, MergeResult>> = {}
          const selected = mergeOptions.mounts ? new Set(mergeOptions.mounts) : undefined
          for (const mount of mounts.values()) {
            if (selected && !selected.has(mount.key)) continue
            if ('virtual' in mount || mount.mode !== 'follow') continue
            try {
              const result = await mergeRef(mount, mergeOptions)
              results[mount.key] =
                typeof result === 'string' ? { status: result } : { status: 'conflicts', conflicts: result.conflicts }
            } catch (error) {
              if (error instanceof BranchSettledError) {
                results[mount.key] = { status: 'unauthorized' }
                continue
              }
              throw error
            }
          }
          return results
        },
        async restore(mountKey: string, at: string) {
          const mount = mounts.get(mountKey)
          if (!mount)
            throw new NotFoundError(`Mount not found: ${mountKey}`, {
              tenant: input.actor.tenant,
              mount: mountKey,
            })
          if ('virtual' in mount) return unsupportedVirtual(mount.key)
          if (mount.mode !== 'follow')
            throw new PermissionDeniedError('Pinned mount is read-only', {
              tenant: input.actor.tenant,
              mount: mount.key,
            })
          const grant = await kernel.resolveGrant(input.actor, { key: mount.key }, { bypassCache: true })
          if (grant.write === 'none')
            throw new PermissionDeniedError('Write permission denied', {
              tenant: input.actor.tenant,
              mount: mount.key,
            })
          const commit = await resolveCommit(at, mount.key, {
            checkRead: false,
          })
          return kernel.restore({
            tenant: input.actor.tenant,
            mount: mount.key,
            ref: refFor(mount),
            sourceCommitId: commit.id,
            authorUser: input.actor.id,
            agentKind: input.attribution?.agentKind,
            threadId: input.attribution?.threadId,
            runId: input.attribution?.runId,
          })
        },
        async tag(mountKey: string, label: string) {
          const mount = mounts.get(mountKey)
          if (!mount)
            throw new NotFoundError(`Mount not found: ${mountKey}`, {
              tenant: input.actor.tenant,
              mount: mountKey,
            })
          if ('virtual' in mount) return unsupportedVirtual(mount.key)
          if (mount.mode !== 'follow')
            throw new PermissionDeniedError('Pinned mount is read-only', {
              tenant: input.actor.tenant,
              mount: mount.key,
            })
          if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/u.test(label))
            throw new InvalidPathError(label, 'tag label must be a single safe ref segment', {
              tenant: input.actor.tenant,
              mount: mount.key,
            })
          const grant = await kernel.resolveGrant(input.actor, { key: mount.key }, { bypassCache: true })
          if (grant.write === 'none')
            throw new PermissionDeniedError('Write permission denied', {
              tenant: input.actor.tenant,
              mount: mount.key,
            })
          const client = await options.pool.connect()
          try {
            await client.query('BEGIN')
            const result = await client.query<{
              commit_id: string
              commit_sha: string
              state: string
            }>(
              `SELECT r.commit_id::text, c.commit_sha, r.state
               FROM tuddo_refs r JOIN tuddo_commits c ON c.id = r.commit_id
               WHERE r.tenant = $1 AND r.name = $2 FOR UPDATE`,
              [input.actor.tenant, refFor(mount)],
            )
            const row = result.rows[0]
            if (!row)
              throw new NotFoundError(`Mount not found: ${mount.key}`, {
                tenant: input.actor.tenant,
                mount: mount.key,
              })
            if (row.state !== 'open')
              throw new BranchSettledError(row.state, {
                tenant: input.actor.tenant,
                mount: mount.key,
              })
            const tagName = `tag/${mount.key}/${label}`
            const existing = await client.query<{ commit_sha: string }>(
              `SELECT c.commit_sha
               FROM tuddo_refs r JOIN tuddo_commits c ON c.id = r.commit_id
               WHERE r.tenant = $1 AND r.name = $2
               FOR UPDATE`,
              [input.actor.tenant, tagName],
            )
            if (existing.rows[0])
              throw new PreconditionFailedError(null, existing.rows[0].commit_sha, {
                tenant: input.actor.tenant,
                mount: mount.key,
                ref: tagName,
              })
            const inserted = await client.query(
              `INSERT INTO tuddo_refs (tenant, name, kind, commit_id, state)
               VALUES ($1, $2, 'tag', $3::bigint, 'tag')
               ON CONFLICT (tenant, name) DO NOTHING`,
              [input.actor.tenant, tagName, row.commit_id],
            )
            if ((inserted.rowCount ?? 0) === 0) {
              const concurrent = await client.query<{ commit_sha: string }>(
                `SELECT c.commit_sha
                 FROM tuddo_refs r JOIN tuddo_commits c ON c.id = r.commit_id
                 WHERE r.tenant = $1 AND r.name = $2`,
                [input.actor.tenant, tagName],
              )
              throw new PreconditionFailedError(null, concurrent.rows[0]?.commit_sha ?? null, {
                tenant: input.actor.tenant,
                mount: mount.key,
                ref: tagName,
              })
            }
            await client.query('COMMIT')
            return tagName
          } catch (error) {
            await client.query('ROLLBACK').catch(() => undefined)
            throw error
          } finally {
            client.release()
          }
        },
        async discard() {
          const client = await options.pool.connect()
          try {
            await client.query(
              `UPDATE tuddo_refs SET state = 'abandoned', settled_at = now() WHERE tenant = $1 AND name = ANY($2::text[]) AND kind = 'branch' AND state = 'open'`,
              [
                input.actor.tenant,
                [...mounts.values()]
                  .filter((mount): mount is RefMount => !('virtual' in mount) && Boolean(mount.ref))
                  .map(mount => mount.ref),
              ],
            )
          } finally {
            client.release()
          }
        },
      }
      const session: SessionFileSystem = {
        actor: sessionOps.actor,
        sessionId: sessionOps.sessionId,
        mount: key => sessionOps.mount(key),
        timeline: filter => sessionOps.timeline(filter),
        diff: (a, b) => sessionOps.diff(a, b),
        merge: mergeOptions => sessionOps.merge(mergeOptions),
        restore: (mountKey, at) => sessionOps.restore(mountKey, at),
        tag: (mountKey, label) => sessionOps.tag(mountKey, label),
        discard: () => sessionOps.discard(),
      }
      return session
      async function mergeRef(mount: RefMount, mergeOptions: { approver?: Actor } = {}): Promise<MergeAttemptResult> {
        if (!mount.fork || !mount.ref) return 'merged'
        if (mergeOptions.approver && mergeOptions.approver.tenant !== input.actor.tenant)
          throw new PermissionDeniedError('Approver tenant does not match session tenant', {
            tenant: input.actor.tenant,
            mount: mount.key,
          })
        // Grant resolvers are host callbacks and may borrow this pool. Resolve all
        // grants before opening the merge transaction so a saturated pool cannot
        // deadlock; the transaction immediately re-checks branch state and locks
        // the refs before applying any merge writes.
        const resolveGrant = async (actorForGrant: Actor) => ({
          grant: await kernel.resolveGrant(actorForGrant, { key: mount.key }, { bypassCache: true }),
          resolvedAt: Date.now(),
        })
        const resolveMergeGrants = async () => {
          const actor = await resolveGrant(input.actor)
          const approver =
            actor.grant.write === 'staged' && mergeOptions.approver
              ? await resolveGrant(mergeOptions.approver)
              : undefined
          return { actor, approver }
        }
        let resolutions = await resolveMergeGrants()
        let client = await options.pool.connect()
        while (
          Date.now() -
            Math.min(resolutions.actor.resolvedAt, resolutions.approver?.resolvedAt ?? Number.POSITIVE_INFINITY) >
          MERGE_GRANT_FRESHNESS_MS
        ) {
          client.release()
          resolutions = await resolveMergeGrants()
          client = await options.pool.connect()
        }
        const actorGrant = resolutions.actor.grant
        const approverGrant = resolutions.approver?.grant
        try {
          await client.query('BEGIN')
          await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`${input.actor.tenant}:mount/${mount.key}`])
          const refResult = await client.query<{
            commit_id: string
            base_commit: string
            commit_sha: string
            state: string
          }>(
            'SELECT r.commit_id::text, r.base_commit::text, c.commit_sha, r.state FROM tuddo_refs r JOIN tuddo_commits c ON c.id = r.commit_id WHERE r.tenant = $1 AND r.name = $2 FOR UPDATE',
            [input.actor.tenant, mount.ref],
          )
          const branch = refResult.rows[0]
          if (!branch)
            throw new NotFoundError(`Branch not found: ${mount.ref}`, {
              tenant: input.actor.tenant,
              mount: mount.key,
            })
          if (branch.state === 'merged') {
            await client.query('ROLLBACK')
            return 'merged'
          }
          if (branch.state === 'unauthorized') {
            await client.query('ROLLBACK')
            return 'unauthorized'
          }
          if (branch.state !== 'open')
            throw new BranchSettledError(branch.state, {
              tenant: input.actor.tenant,
              mount: mount.key,
              ref: mount.ref,
            })
          if (actorGrant.write === 'staged') {
            if (!mergeOptions.approver) {
              await client.query('ROLLBACK')
              return 'pendingApproval'
            }
            if (approverGrant?.write !== 'direct') {
              await client.query('ROLLBACK')
              return 'unauthorized'
            }
          }
          if (actorGrant.write === 'none') {
            await client.query(
              `UPDATE tuddo_refs SET state = 'unauthorized', settled_at = now()
               WHERE tenant = $1 AND name = $2`,
              [input.actor.tenant, mount.ref],
            )
            await client.query('COMMIT')
            return 'unauthorized'
          }

          const mountResult = await client.query<{
            commit_id: string
            commit_sha: string
          }>(
            'SELECT r.commit_id::text, c.commit_sha FROM tuddo_refs r JOIN tuddo_commits c ON c.id = r.commit_id WHERE r.tenant = $1 AND r.name = $2 FOR UPDATE',
            [input.actor.tenant, `mount/${mount.key}`],
          )
          const theirs = mountResult.rows[0]
          if (!theirs)
            throw new NotFoundError(`Mount not found: ${mount.key}`, {
              tenant: input.actor.tenant,
              mount: mount.key,
            })
          const base = await readTree(client, branch.base_commit)
          const ours = await readTree(client, branch.commit_id)
          const theirsTree = await readTree(client, theirs.commit_id)
          const conflicts: {
            path: string
            baseSha?: string
            oursSha?: string
            theirsSha?: string
          }[] = []
          const merged = new Map(theirsTree)
          for (const path of new Set([...base.keys(), ...ours.keys(), ...theirsTree.keys()])) {
            const b = base.get(path)
            const o = ours.get(path)
            const t = theirsTree.get(path)
            if (sameHead(o, b)) continue
            if (sameHead(t, b)) {
              const value = ours.get(path)
              if (value) merged.set(path, value)
              else merged.delete(path)
              continue
            }
            if (sameHead(o, t)) continue
            conflicts.push({
              path,
              ...(b ? { baseSha: b.sha256 } : {}),
              ...(o ? { oursSha: o.sha256 } : {}),
              ...(t ? { theirsSha: t.sha256 } : {}),
            })
          }
          if (conflicts.length) {
            await client.query('ROLLBACK')
            return { conflicts }
          }
          const collidingPaths = new Set<string>()
          for (const collision of findTreeCoherenceCollisions(merged.keys())) {
            collidingPaths.add(collision.path)
            collidingPaths.add(collision.collidingPath)
          }
          for (const path of [...collidingPaths].sort()) {
            const b = base.get(path)
            const o = ours.get(path)
            const t = theirsTree.get(path)
            conflicts.push({
              path,
              ...(b ? { baseSha: b.sha256 } : {}),
              ...(o ? { oursSha: o.sha256 } : {}),
              ...(t ? { theirsSha: t.sha256 } : {}),
            })
          }
          if (conflicts.length) {
            await client.query('ROLLBACK')
            return { conflicts }
          }
          const mergedTreeSha = hashTree(
            [...merged.values()].map(entry => ({
              path: entry.path,
              mode: entry.mode,
              blobSha: entry.sha256,
            })),
          )
          const theirsTreeSha = hashTree(
            [...theirsTree.values()].map(entry => ({
              path: entry.path,
              mode: entry.mode,
              blobSha: entry.sha256,
            })),
          )
          if (mergedTreeSha === theirsTreeSha) {
            await client.query(
              `UPDATE tuddo_refs SET state = 'merged', settled_at = now() WHERE tenant = $1 AND name = $2`,
              [input.actor.tenant, mount.ref],
            )
            await client.query('COMMIT')
            return 'merged'
          }
          const created = await insertTreeCommit(
            client,
            input.actor.tenant,
            merged,
            [BigInt(theirs.commit_id), BigInt(branch.commit_id)],
            [theirs.commit_sha, branch.commit_sha],
            input,
            'merge',
          )
          await client.query('UPDATE tuddo_refs SET commit_id = $3::bigint WHERE tenant = $1 AND name = $2', [
            input.actor.tenant,
            `mount/${mount.key}`,
            created.id.toString(),
          ])
          await client.query(
            `UPDATE tuddo_refs SET state = 'merged', settled_at = now() WHERE tenant = $1 AND name = $2`,
            [input.actor.tenant, mount.ref],
          )
          await replaceHeads(client, input.actor.tenant, `mount/${mount.key}`, merged)
          await client.query('COMMIT')
          return 'merged'
        } catch (error) {
          await client.query('ROLLBACK').catch(() => undefined)
          throw error
        } finally {
          client.release()
        }
      }
    },
  }
}

async function readAll(options: TuddoFsOptions, objectKey: string, context: ErrorContext): Promise<Buffer> {
  if (!options.storage) throw new NotFoundError(`Blob unavailable: ${objectKey}`, context)
  try {
    const chunks: Buffer[] = []
    for await (const chunk of await options.storage.get(objectKey))
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array))
    return Buffer.concat(chunks)
  } catch (error) {
    if (error instanceof TuddoFsError) throw error
    throw new StorageError(error instanceof Error ? error.message : 'Object storage failed', context)
  }
}

async function insertTreeCommit(
  client: TuddoFsClient,
  tenant: string,
  entries: Map<string, Head>,
  parents: bigint[],
  parentShas: string[],
  input: OpenInput,
  op: string,
): Promise<{ id: bigint; sha: string }> {
  const treeEntries: TreeEntry[] = [...entries.values()].map(entry => ({
    path: entry.path,
    mode: entry.mode,
    blobSha: entry.sha256,
  }))
  const treeSha = hashTree(treeEntries)
  const tree = await client.query<{ id: string }>(
    'INSERT INTO tuddo_trees (tenant, tree_sha) VALUES ($1, $2) ON CONFLICT (tenant, tree_sha) DO UPDATE SET tree_sha = EXCLUDED.tree_sha RETURNING id::text',
    [tenant, treeSha],
  )
  const treeId = BigInt(tree.rows[0]?.id ?? '0')
  for (const entry of entries.values())
    await client.query(
      'INSERT INTO tuddo_tree_entries (tree_id, path, blob_id, mode) VALUES ($1::bigint, $2, $3::bigint, $4) ON CONFLICT DO NOTHING',
      [treeId.toString(), entry.path, entry.blobId, entry.mode],
    )
  const createdAt = new Date()
  const commitSha = hashCommit({
    treeSha,
    parents: parentShas,
    authorUser: input.actor.id,
    agentKind: input.attribution?.agentKind ?? null,
    threadId: input.attribution?.threadId ?? null,
    runId: input.attribution?.runId ?? null,
    ts: createdAt.toISOString(),
    op,
  })
  const commit = await client.query<{ id: string }>(
    'INSERT INTO tuddo_commits (tenant, commit_sha, tree_id, parents, author_user, agent_kind, thread_id, run_id, op, message, created_at) VALUES ($1, $2, $3::bigint, $4::bigint[], $5, $6, $7, $8, $9, NULL, $10) RETURNING id::text',
    [
      tenant,
      commitSha,
      treeId.toString(),
      parents.map(parent => parent.toString()),
      input.actor.id,
      input.attribution?.agentKind ?? null,
      input.attribution?.threadId ?? null,
      input.attribution?.runId ?? null,
      op,
      createdAt,
    ],
  )
  return { id: BigInt(commit.rows[0]?.id ?? '0'), sha: commitSha }
}

async function replaceHeads(
  client: TuddoFsClient,
  tenant: string,
  ref: string,
  entries: Map<string, Head>,
): Promise<void> {
  await client.query('DELETE FROM tuddo_heads WHERE tenant = $1 AND ref_name = $2', [tenant, ref])
  for (const entry of entries.values())
    await client.query(
      'INSERT INTO tuddo_heads (tenant, ref_name, path, blob_id, sha256, size_bytes) VALUES ($1, $2, $3, $4::bigint, $5, $6)',
      [tenant, ref, entry.path, entry.blobId, entry.sha256, entry.sizeBytes.toString()],
    )
}
