import { hashCommit, hashTree, sha256, type TreeEntry } from './hashing.js'
import {
  AgentFsError,
  BranchSettledError,
  NotFoundError,
  PermissionDeniedError,
  PreconditionFailedError,
} from './errors.js'
import { validateMountKey, validatePath } from './validation.js'
import type {
  Actor,
  AgentFsKernel,
  AgentFsOptions,
  DeleteResult,
  ForkResult,
  ReadResult,
  WriteResult,
} from './kernel.js'
import type { AgentFsClient } from './migration.js'

export interface VirtualEntry {
  readonly path: string
  readonly type: 'file' | 'directory'
  readonly sizeBytes?: number | bigint
  readonly sha256?: string
  readonly mode?: number
}

export interface VirtualMountHandler {
  list(dir: string, actor: Actor): Promise<readonly VirtualEntry[]>
  read(path: string, actor: Actor): Promise<Buffer | null>
  write?(path: string, bytes: Buffer, actor: Actor): Promise<void>
}

export type MountSpec =
  | { readonly key: string; readonly mode?: 'follow' | { readonly pin: string } }
  | { readonly key: string; readonly virtual: VirtualMountHandler }

export interface OpenInput {
  readonly actor: Actor
  readonly sessionId: string
  readonly attribution?: {
    readonly agentKind?: string | null
    readonly threadId?: string | null
    readonly runId?: string | null
  }
  readonly mounts: readonly MountSpec[]
}

export interface SessionStat {
  readonly path: string
  readonly sha256: string
  readonly sizeBytes: bigint
  readonly mode: number
}

export interface SessionEntry {
  readonly path: string
  readonly type: 'file' | 'directory'
  readonly sha256?: string
  readonly sizeBytes?: bigint | number
  readonly mode?: number
}

export interface TextEdit {
  readonly start: number
  readonly end: number
  readonly text: string
}

export interface EditOptions {
  readonly ifSha?: string | null
}

export interface TimelineFilter {
  readonly runId?: string
  readonly agentKind?: string
  readonly threadId?: string
}

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

export interface DiffRecord {
  readonly path: string
  readonly beforeSha: string | null
  readonly afterSha: string | null
  readonly beforeMode?: number
  readonly afterMode?: number
}

export type MergeResult =
  | 'merged'
  | 'unauthorized'
  | 'pendingApproval'
  | { readonly conflicts: readonly { path: string; baseSha?: string; oursSha?: string; theirsSha?: string }[] }

export interface SessionFileSystem {
  readonly actor: Actor
  readonly sessionId: string
  read(path: string): Promise<string>
  readBytes(path: string): Promise<Buffer>
  write(path: string, bytes: Buffer | Uint8Array | string, options?: { ifSha?: string | null }): Promise<WriteResult>
  edit(path: string, edits: readonly TextEdit[], options?: EditOptions): Promise<WriteResult>
  list(dir: string): Promise<readonly SessionEntry[]>
  glob(pattern: string): Promise<readonly SessionEntry[]>
  stat(path: string): Promise<SessionStat>
  delete(path: string, options?: { ifSha?: string | null }): Promise<DeleteResult>
  history(path: string): Promise<readonly HistoryRecord[]>
  timeline(filter?: TimelineFilter): Promise<readonly TimelineRecord[]>
  diff(a: string, b: string): Promise<readonly DiffRecord[]>
  merge(options?: { approver?: Actor }): Promise<Readonly<Record<string, MergeResult>>>
  resolveMerge(mountKey: string, options?: { approver?: Actor }): Promise<MergeResult>
  restore(mountKey: string, at: string): Promise<WriteResult | null>
  tag(mountKey: string, label: string): Promise<string>
  discard(): Promise<void>
}

type RefMount = {
  readonly key: string
  readonly mode: 'follow' | { readonly pin: string }
  readonly ref?: string
  readonly fork?: ForkResult
}
type VirtualMount = { readonly key: string; readonly virtual: VirtualMountHandler }
type Mount = RefMount | VirtualMount

type Head = { path: string; sha256: string; sizeBytes: bigint; mode: number; blobId?: string }
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

function pathForAddress(address: string): { mountKey: string; path: string } {
  const separator = address.indexOf(':/')
  if (separator <= 0) throw new NotFoundError(`Invalid session path: ${address}`)
  return { mountKey: address.slice(0, separator), path: address.slice(separator + 1) }
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

type SessionKernel = Omit<AgentFsKernel, 'open'>
export function createSessionApi(kernel: SessionKernel, options: AgentFsOptions) {
  return {
    invalidate(actorId: string, mountKey?: string) {
      kernel.invalidate(actorId, mountKey)
    },
    async open(input: OpenInput): Promise<SessionFileSystem> {
      if (!input.actor.id || input.actor.id === 'system')
        throw new PermissionDeniedError('Session actor must be an executing user', { tenant: input.actor.tenant })
      const mounts = new Map<string, Mount>()
      for (const spec of input.mounts) {
        const key = validateMountKey(spec.key, { tenant: input.actor.tenant, mount: spec.key })
        if (mounts.has(key))
          throw new PermissionDeniedError(`Duplicate mount: ${key}`, { tenant: input.actor.tenant, mount: key })
        if ('virtual' in spec) {
          mounts.set(key, { key, virtual: spec.virtual })
          continue
        }
        const mode = spec.mode ?? 'follow'
        const grant = await kernel.resolveGrant(input.actor, { key }, { bypassCache: true })
        if (!grant.read)
          throw new PermissionDeniedError('Read permission denied', { tenant: input.actor.tenant, mount: key })
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
        if (!fork) throw new PermissionDeniedError('Read permission denied', { tenant: input.actor.tenant, mount: key })
        mounts.set(key, { key, mode, ref: fork.ref, fork })
      }

      const mountFor = (address: string, allowRoot = false): { mount: Mount; path: string } => {
        const parsed = pathForAddress(address)
        const mount = mounts.get(parsed.mountKey)
        if (!mount)
          throw new NotFoundError(`Mount not found: ${parsed.mountKey}`, {
            tenant: input.actor.tenant,
            mount: parsed.mountKey,
          })
        const path =
          allowRoot && parsed.path === '/'
            ? '/'
            : validatePath(parsed.path, { tenant: input.actor.tenant, mount: parsed.mountKey })
        return { mount, path }
      }

      const readVirtual = async (mount: VirtualMount, path: string): Promise<Buffer> => {
        const bytes = await mount.virtual.read(path, input.actor)
        if (!bytes)
          throw new NotFoundError(`Path not found: ${path}`, { tenant: input.actor.tenant, mount: mount.key, path })
        return Buffer.from(bytes)
      }

      const refFor = (mount: RefMount): string => {
        if (mount.ref) return mount.ref
        return `mount/${mount.key}`
      }
      const ensureRead = async (mount: RefMount): Promise<void> => {
        const grant = await kernel.resolveGrant(input.actor, { key: mount.key })
        if (!grant.read)
          throw new PermissionDeniedError('Read permission denied', {
            tenant: input.actor.tenant,
            mount: mount.key,
          })
      }

      const pinnedRef = async (mount: RefMount): Promise<{ ref: string; commitId: string }> => {
        if (mount.mode === 'follow') return { ref: refFor(mount), commitId: '' }
        const pin = mount.mode.pin
        const client = await options.pool.connect()
        try {
          const result = await client.query<{ id: string; commit_sha: string }>(
            `SELECT c.id::text, c.commit_sha
             FROM afs_commits c LEFT JOIN afs_refs r ON r.tenant = c.tenant AND r.commit_id = c.id
             WHERE c.tenant = $1 AND (c.commit_sha = $2 OR r.name = $2)
             ORDER BY CASE WHEN r.name = $2 THEN 0 ELSE 1 END LIMIT 1`,
            [input.actor.tenant, pin],
          )
          const row = result.rows[0]
          if (!row)
            throw new NotFoundError(`Pinned commit not found: ${pin}`, {
              tenant: input.actor.tenant,
              mount: mount.key,
            })
          return { ref: `__pin/${input.sessionId}/${mount.key}`, commitId: row.id }
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
             FROM afs_commits c JOIN afs_tree_entries e ON e.tree_id = c.tree_id
             JOIN afs_blobs b ON b.id = e.blob_id
             WHERE c.tenant = $1 AND c.id = $2::bigint AND e.path = $3`,
            [input.actor.tenant, pin.commitId, path],
          )
          const row = result.rows[0]
          if (!row)
            throw new NotFoundError(`Path not found: ${path}`, { tenant: input.actor.tenant, mount: mount.key, path })
          let bytes: Buffer
          if (row.inline) bytes = Buffer.from(row.inline)
          else if (row.object_key && options.storage) bytes = await readAll(options, row.object_key)
          else
            throw new NotFoundError(`Blob unavailable: ${path}`, { tenant: input.actor.tenant, mount: mount.key, path })
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

      const readBytes = async (address: string): Promise<Buffer> => {
        const { mount, path } = mountFor(address)
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

      const listRef = async (mount: RefMount, dir: string): Promise<SessionEntry[]> => {
        const client = await options.pool.connect()
        try {
          let rows: Head[]
          if (mount.mode === 'follow') {
            const result = await client.query<{ path: string; sha256: string; size_bytes: string; mode: number }>(
              `SELECT h.path, h.sha256, h.size_bytes::text, COALESCE(e.mode, 420)::int AS mode
               FROM afs_heads h JOIN afs_refs r ON r.tenant = h.tenant AND r.name = h.ref_name
               JOIN afs_commits c ON c.id = r.commit_id
               LEFT JOIN afs_tree_entries e ON e.tree_id = c.tree_id AND e.path = h.path
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
            const result = await client.query<{ path: string; sha256: string; size_bytes: string; mode: number }>(
              `SELECT e.path, b.sha256, b.size_bytes::text, e.mode
               FROM afs_commits c JOIN afs_tree_entries e ON e.tree_id = c.tree_id JOIN afs_blobs b ON b.id = e.blob_id
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
          return [...direct.values()].sort((a, b) => a.path.localeCompare(b.path))
        } finally {
          client.release()
        }
      }
      const allRefEntries = async (mount: RefMount): Promise<SessionEntry[]> => {
        const client = await options.pool.connect()
        try {
          if (mount.mode === 'follow') {
            const result = await client.query<{ path: string; sha256: string; size_bytes: string; mode: number }>(
              `SELECT h.path, h.sha256, h.size_bytes::text, COALESCE(e.mode, 420)::int AS mode
               FROM afs_heads h JOIN afs_refs r ON r.tenant = h.tenant AND r.name = h.ref_name
               JOIN afs_commits c ON c.id = r.commit_id
               LEFT JOIN afs_tree_entries e ON e.tree_id = c.tree_id AND e.path = h.path
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
          const result = await client.query<{ path: string; sha256: string; size_bytes: string; mode: number }>(
            `SELECT e.path, b.sha256, b.size_bytes::text, e.mode
             FROM afs_commits c JOIN afs_tree_entries e ON e.tree_id = c.tree_id JOIN afs_blobs b ON b.id = e.blob_id
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

      const resolveCommit = async (value: string): Promise<{ id: string; sha: string; mountKey?: string }> => {
        const parsed = value.includes(':/') ? pathForAddress(value) : null
        if (parsed) {
          const mount = mounts.get(parsed.mountKey)
          if (!mount || 'virtual' in mount)
            throw new NotFoundError('Virtual mount has no commits', {
              tenant: input.actor.tenant,
              mount: parsed.mountKey,
            })
          const ref = refFor(mount)
          const client = await options.pool.connect()
          try {
            const result = await client.query<{ id: string; commit_sha: string }>(
              'SELECT c.id::text, c.commit_sha FROM afs_refs r JOIN afs_commits c ON c.id = r.commit_id WHERE r.tenant = $1 AND r.name = $2',
              [input.actor.tenant, ref],
            )
            const row = result.rows[0]
            if (!row)
              throw new NotFoundError(`Commit not found: ${value}`, {
                tenant: input.actor.tenant,
                mount: parsed.mountKey,
              })
            return { id: row.id, sha: row.commit_sha, mountKey: parsed.mountKey }
          } finally {
            client.release()
          }
        }
        const client = await options.pool.connect()
        try {
          const result = await client.query<{ id: string; commit_sha: string }>(
            'SELECT id::text, commit_sha FROM afs_commits WHERE tenant = $1 AND commit_sha = $2',
            [input.actor.tenant, value],
          )
          const row = result.rows[0]
          if (!row) throw new NotFoundError(`Commit not found: ${value}`, { tenant: input.actor.tenant })
          return { id: row.id, sha: row.commit_sha }
        } finally {
          client.release()
        }
      }

      const readTree = async (client: AgentFsClient, commitId: string): Promise<Map<string, Head>> => {
        const result = await client.query<{
          path: string
          blob_id: string
          sha256: string
          size_bytes: string
          mode: number
        }>(
          `SELECT e.path, e.blob_id::text, b.sha256, b.size_bytes::text, e.mode
           FROM afs_commits c JOIN afs_tree_entries e ON e.tree_id = c.tree_id JOIN afs_blobs b ON b.id = e.blob_id
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

      const unsupportedVirtual = (mountKey: string): never => {
        throw new NotFoundError('Virtual mount has no history or branches', {
          tenant: input.actor.tenant,
          mount: mountKey,
        })
      }

      return {
        actor: input.actor,
        sessionId: input.sessionId,
        async read(address: string) {
          return (await readBytes(address)).toString('utf8')
        },
        readBytes,
        async write(address: string, value: Buffer | Uint8Array | string, writeOptions = {}) {
          const { mount, path } = mountFor(address)
          const bytes = bytesFor(value)
          if ('virtual' in mount) {
            if (!mount.virtual.write)
              throw new PermissionDeniedError('Virtual mount is read-only', {
                tenant: input.actor.tenant,
                mount: mount.key,
                path,
              })
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
        async edit(address: string, edits: readonly TextEdit[], editOptions = {}) {
          const { mount, path } = mountFor(address)
          const old = await readBytes(address)
          const currentSha = sha256(old)
          if (editOptions.ifSha !== undefined && editOptions.ifSha !== currentSha)
            throw new PreconditionFailedError(editOptions.ifSha, currentSha, {
              tenant: input.actor.tenant,
              mount: mount.key,
              path,
            })
          let text = old.toString('utf8')
          for (const edit of [...edits].sort((a, b) => b.start - a.start)) {
            if (
              !Number.isInteger(edit.start) ||
              !Number.isInteger(edit.end) ||
              edit.start < 0 ||
              edit.end < edit.start ||
              edit.end > text.length
            )
              throw new AgentFsError(
                'Invalid edit range',
                { tenant: input.actor.tenant, mount: mount.key, path },
                'InvalidPathError',
              )
            text = `${text.slice(0, edit.start)}${edit.text}${text.slice(edit.end)}`
          }
          return this.write(address, text, { ifSha: currentSha })
        },
        async list(address: string) {
          const { mount, path } = mountFor(address, true)
          if ('virtual' in mount) return mount.virtual.list(path, input.actor)
          await ensureRead(mount)
          return listRef(mount, path)
        },
        async glob(address: string) {
          const { mountKey, path } = pathForAddress(address)
          const mount = mounts.get(mountKey)
          if (!mount)
            throw new NotFoundError(`Mount not found: ${mountKey}`, { tenant: input.actor.tenant, mount: mountKey })
          if (!('virtual' in mount)) await ensureRead(mount)
          const matcher = globRegex(path)
          const entries = 'virtual' in mount ? await mount.virtual.list('/', input.actor) : await allRefEntries(mount)
          return entries.filter(entry => matcher.test(entry.path))
        },
        async stat(address: string) {
          const { mount, path } = mountFor(address)
          if ('virtual' in mount) {
            const bytes = await readVirtual(mount, path)
            return { path, sha256: sha256(bytes), sizeBytes: BigInt(bytes.length), mode: 420 }
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
          return { path, sha256: result.sha256, sizeBytes: result.sizeBytes, mode: result.mode }
        },
        async delete(address: string, deleteOptions = {}) {
          const { mount, path } = mountFor(address)
          if ('virtual' in mount) {
            if (!mount.virtual.write)
              throw new PermissionDeniedError('Virtual mount is read-only', {
                tenant: input.actor.tenant,
                mount: mount.key,
                path,
              })
            await mount.virtual.write(path, Buffer.alloc(0), input.actor)
            return { path, commitSha: '' }
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
        async history(address: string) {
          const { mount, path } = mountFor(address)
          if ('virtual' in mount) return unsupportedVirtual(mount.key)
          await ensureRead(mount)
          const client = await options.pool.connect()
          try {
            const result = await client.query<CommitRow & { parent_shas: string[] }>(
              `SELECT c.id::text, c.commit_sha, c.parents, c.op, c.author_user, c.agent_kind, c.thread_id, c.run_id, c.created_at,
                      COALESCE((SELECT array_agg(p.commit_sha ORDER BY p.id) FROM afs_commits p WHERE p.id = ANY(c.parents)), '{}') AS parent_shas
               FROM afs_commits c JOIN afs_refs r ON r.tenant = c.tenant AND r.name = $2
               WHERE c.tenant = $1 AND EXISTS (SELECT 1 FROM afs_tree_entries e JOIN afs_trees t ON t.id = e.tree_id WHERE t.id = c.tree_id AND e.path = $3)
               ORDER BY c.id DESC`,
              [input.actor.tenant, refFor(mount), path],
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
          const client = await options.pool.connect()
          try {
            const result = await client.query<CommitRow & { parent_shas: string[]; changed_paths: string[] }>(
              `SELECT c.id::text, c.commit_sha, c.parents, c.op, c.author_user, c.agent_kind, c.thread_id, c.run_id, c.created_at,
                      COALESCE((SELECT array_agg(p.path ORDER BY p.path) FROM afs_tree_entries p WHERE p.tree_id = c.tree_id), '{}') AS changed_paths,
                      '{}'::text[] AS parent_shas
               FROM afs_commits c WHERE c.tenant = $1
                 AND ($2::text IS NULL OR c.run_id = $2)
                 AND ($3::text IS NULL OR c.agent_kind = $3)
                 AND ($4::text IS NULL OR c.thread_id = $4)
               ORDER BY c.id`,
              [input.actor.tenant, filter.runId ?? null, filter.agentKind ?? null, filter.threadId ?? null],
            )
            return result.rows.map(row => ({
              commitSha: row.commit_sha,
              parentShas: asParentArray(row.parents),
              changedPaths: [...new Set(row.changed_paths ?? [])].sort(),
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
        async diff(a: string, b: string) {
          const first = resolveCommit(a)
          const second = resolveCommit(b)
          const [left, right] = await Promise.all([first, second])
          if (left.mountKey && mounts.get(left.mountKey) && 'virtual' in mounts.get(left.mountKey)!)
            unsupportedVirtual(left.mountKey)
          if (right.mountKey && mounts.get(right.mountKey) && 'virtual' in mounts.get(right.mountKey)!)
            unsupportedVirtual(right.mountKey)
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
          const results: Record<string, MergeResult> = {}
          for (const mount of mounts.values()) {
            if ('virtual' in mount) results[mount.key] = unsupportedVirtual(mount.key)
            else results[mount.key] = await this.resolveMerge(mount.key, mergeOptions)
          }
          return results
        },
        async resolveMerge(mountKey: string, mergeOptions = {}) {
          const mount = mounts.get(mountKey)
          if (!mount)
            throw new NotFoundError(`Mount not found: ${mountKey}`, { tenant: input.actor.tenant, mount: mountKey })
          if ('virtual' in mount) return unsupportedVirtual(mount.key)
          const actorGrant = await kernel.resolveGrant(input.actor, { key: mount.key }, { bypassCache: true })
          if (actorGrant.write === 'none') return 'unauthorized'
          if (actorGrant.write === 'staged') {
            if (!mergeOptions.approver) return 'pendingApproval'
            const approverGrant = await kernel.resolveGrant(
              mergeOptions.approver,
              { key: mount.key },
              { bypassCache: true },
            )
            if (approverGrant.write !== 'direct') return 'unauthorized'
          }
          return mergeRef(mount)
        },
        async restore(mountKey: string, at: string) {
          const mount = mounts.get(mountKey)
          if (!mount)
            throw new NotFoundError(`Mount not found: ${mountKey}`, { tenant: input.actor.tenant, mount: mountKey })
          if ('virtual' in mount) return unsupportedVirtual(mount.key)
          if (mount.mode !== 'follow')
            throw new PermissionDeniedError('Pinned mount is read-only', {
              tenant: input.actor.tenant,
              mount: mount.key,
            })
          const commit = await resolveCommit(at)
          const client = await options.pool.connect()
          try {
            await client.query('BEGIN')
            const tree = await readTree(client, commit.id)
            const current = await client.query<{ commit_id: string; commit_sha: string }>(
              'SELECT r.commit_id::text, c.commit_sha FROM afs_refs r JOIN afs_commits c ON c.id = r.commit_id WHERE r.tenant = $1 AND r.name = $2 FOR UPDATE',
              [input.actor.tenant, refFor(mount)],
            )
            if (!current.rows[0])
              throw new NotFoundError(`Mount not found: ${mount.key}`, { tenant: input.actor.tenant, mount: mount.key })
            const created = await insertTreeCommit(
              client,
              input.actor.tenant,
              tree,
              [BigInt(current.rows[0].commit_id)],
              [current.rows[0].commit_sha],
              input,
              'restore',
            )
            await client.query('UPDATE afs_refs SET commit_id = $3::bigint WHERE tenant = $1 AND name = $2', [
              input.actor.tenant,
              refFor(mount),
              created.id.toString(),
            ])
            await replaceHeads(client, input.actor.tenant, refFor(mount), tree)
            await client.query('COMMIT')
            return {
              path: '/',
              sha256: hashTree(
                [...tree.values()].map(entry => ({ path: entry.path, mode: entry.mode, blobSha: entry.sha256 })),
              ),
              sizeBytes: 0n,
              commitSha: created.sha,
            }
          } catch (error) {
            await client.query('ROLLBACK').catch(() => undefined)
            throw error
          } finally {
            client.release()
          }
        },
        async tag(mountKey: string, label: string) {
          const mount = mounts.get(mountKey)
          if (!mount)
            throw new NotFoundError(`Mount not found: ${mountKey}`, { tenant: input.actor.tenant, mount: mountKey })
          if ('virtual' in mount) return unsupportedVirtual(mount.key)
          const client = await options.pool.connect()
          try {
            const result = await client.query<{ commit_id: string }>(
              'SELECT commit_id::text FROM afs_refs WHERE tenant = $1 AND name = $2',
              [input.actor.tenant, refFor(mount)],
            )
            const row = result.rows[0]
            if (!row)
              throw new NotFoundError(`Mount not found: ${mount.key}`, { tenant: input.actor.tenant, mount: mount.key })
            const tagName = `tag/${mount.key}/${label}`
            await client.query(
              `INSERT INTO afs_refs (tenant, name, kind, commit_id, state) VALUES ($1, $2, 'tag', $3::bigint, 'open') ON CONFLICT (tenant, name) DO UPDATE SET commit_id = EXCLUDED.commit_id`,
              [input.actor.tenant, tagName, row.commit_id],
            )
            return tagName
          } finally {
            client.release()
          }
        },
        async discard() {
          const client = await options.pool.connect()
          try {
            await client.query(
              `UPDATE afs_refs SET state = 'abandoned', settled_at = now() WHERE tenant = $1 AND name = ANY($2::text[]) AND kind = 'branch' AND state = 'open'`,
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
      } as SessionFileSystem

      async function mergeRef(mount: RefMount): Promise<MergeResult> {
        if (!mount.fork || !mount.ref) return 'merged'
        const client = await options.pool.connect()
        try {
          await client.query('BEGIN')
          const refResult = await client.query<{
            commit_id: string
            base_commit: string
            commit_sha: string
            state: string
          }>(
            'SELECT r.commit_id::text, r.base_commit::text, c.commit_sha, r.state FROM afs_refs r JOIN afs_commits c ON c.id = r.commit_id WHERE r.tenant = $1 AND r.name = $2 FOR UPDATE',
            [input.actor.tenant, mount.ref],
          )
          const branch = refResult.rows[0]
          if (!branch)
            throw new NotFoundError(`Branch not found: ${mount.ref}`, { tenant: input.actor.tenant, mount: mount.key })
          if (branch.state !== 'open')
            throw new BranchSettledError(branch.state, { tenant: input.actor.tenant, mount: mount.key, ref: mount.ref })
          const mountResult = await client.query<{ commit_id: string; commit_sha: string }>(
            'SELECT r.commit_id::text, c.commit_sha FROM afs_refs r JOIN afs_commits c ON c.id = r.commit_id WHERE r.tenant = $1 AND r.name = $2 FOR UPDATE',
            [input.actor.tenant, `mount/${mount.key}`],
          )
          const theirs = mountResult.rows[0]
          if (!theirs)
            throw new NotFoundError(`Mount not found: ${mount.key}`, { tenant: input.actor.tenant, mount: mount.key })
          const base = await readTree(client, branch.base_commit)
          const ours = await readTree(client, branch.commit_id)
          const theirsTree = await readTree(client, theirs.commit_id)
          const conflicts: { path: string; baseSha?: string; oursSha?: string; theirsSha?: string }[] = []
          const merged = new Map(theirsTree)
          for (const path of new Set([...base.keys(), ...ours.keys(), ...theirsTree.keys()])) {
            const b = base.get(path)?.sha256
            const o = ours.get(path)?.sha256
            const t = theirsTree.get(path)?.sha256
            if (o === b) continue
            if (t === b) {
              const value = ours.get(path)
              if (value) merged.set(path, value)
              else merged.delete(path)
              continue
            }
            if (o === t) continue
            conflicts.push({
              path,
              ...(b ? { baseSha: b } : {}),
              ...(o ? { oursSha: o } : {}),
              ...(t ? { theirsSha: t } : {}),
            })
          }
          if (conflicts.length) {
            await client.query('ROLLBACK')
            return { conflicts }
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
          await client.query('UPDATE afs_refs SET commit_id = $3::bigint WHERE tenant = $1 AND name = $2', [
            input.actor.tenant,
            `mount/${mount.key}`,
            created.id.toString(),
          ])
          await client.query(
            `UPDATE afs_refs SET state = 'merged', settled_at = now() WHERE tenant = $1 AND name = $2`,
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

async function readAll(options: AgentFsOptions, objectKey: string): Promise<Buffer> {
  if (!options.storage) throw new NotFoundError(`Blob unavailable: ${objectKey}`)
  const chunks: Buffer[] = []
  for await (const chunk of await options.storage.get(objectKey))
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  return Buffer.concat(chunks)
}

async function insertTreeCommit(
  client: AgentFsClient,
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
    'INSERT INTO afs_trees (tenant, tree_sha) VALUES ($1, $2) ON CONFLICT (tenant, tree_sha) DO UPDATE SET tree_sha = EXCLUDED.tree_sha RETURNING id::text',
    [tenant, treeSha],
  )
  const treeId = BigInt(tree.rows[0]?.id ?? '0')
  for (const entry of entries.values())
    await client.query(
      'INSERT INTO afs_tree_entries (tree_id, path, blob_id, mode) VALUES ($1::bigint, $2, $3::bigint, $4) ON CONFLICT DO NOTHING',
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
    'INSERT INTO afs_commits (tenant, commit_sha, tree_id, parents, author_user, agent_kind, thread_id, run_id, op, message, created_at) VALUES ($1, $2, $3::bigint, $4::bigint[], $5, $6, $7, $8, $9, NULL, $10) RETURNING id::text',
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
  client: AgentFsClient,
  tenant: string,
  ref: string,
  entries: Map<string, Head>,
): Promise<void> {
  await client.query('DELETE FROM afs_heads WHERE tenant = $1 AND ref_name = $2', [tenant, ref])
  for (const entry of entries.values())
    await client.query(
      'INSERT INTO afs_heads (tenant, ref_name, path, blob_id, sha256, size_bytes) VALUES ($1, $2, $3, $4::bigint, $5, $6)',
      [tenant, ref, entry.path, entry.blobId, entry.sha256, entry.sizeBytes.toString()],
    )
}
