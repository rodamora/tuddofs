import { AgentFsError, GrantResolverError } from './errors.js'
import type { Actor, GrantResolver, WriteMode } from './kernel.js'

export interface Grant {
  readonly read: boolean
  readonly write: WriteMode
}

export interface GrantControllerOptions {
  readonly resolve: GrantResolver['resolve']
  readonly ttlMs?: number
  readonly timeoutMs?: number
  readonly now?: () => number
}

type CacheEntry = { readonly expiresAt: number; readonly grant: Grant }

/** Live, fail-closed grant resolution with bounded process-local caching. @see spec §5 */
export class GrantController {
  private readonly resolveFn: GrantResolver['resolve']
  private readonly ttlMs: number
  private readonly timeoutMs: number
  private readonly now: () => number
  private readonly cache = new Map<string, CacheEntry>()
  private nextReapAt = 0

  constructor(options: GrantControllerOptions | GrantResolver) {
    this.resolveFn = options.resolve
    this.ttlMs = 'ttlMs' in options ? (options.ttlMs ?? 30_000) : 30_000
    this.timeoutMs = 'timeoutMs' in options ? (options.timeoutMs ?? 5_000) : 5_000
    this.now = 'now' in options ? (options.now ?? (() => Date.now())) : () => Date.now()
    if (!Number.isFinite(this.ttlMs) || this.ttlMs < 0 || this.ttlMs > 30_000)
      throw new RangeError('Grant cache TTL must be finite, non-negative, and at most 30000ms')
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0)
      throw new RangeError('Grant resolver timeout must be finite and positive')
  }

  async resolve(actor: Actor, mount: { key: string }, options: { bypassCache?: boolean } = {}): Promise<Grant> {
    const key = `${actor.tenant}\u0000${actor.id}\u0000${mount.key}`
    const now = this.now()
    if (now >= this.nextReapAt) {
      for (const [cachedKey, cached] of this.cache) {
        if (cached.expiresAt <= now) this.cache.delete(cachedKey)
      }
      this.nextReapAt = now + Math.max(1, Math.min(this.ttlMs, 1_000))
    }
    const cached = this.cache.get(key)
    if (cached) {
      if (cached.expiresAt <= now) this.cache.delete(key)
      else if (!options.bypassCache) return cached.grant
    }
    let result: Grant
    try {
      result = await this.withTimeout(this.resolveFn(actor, mount))
    } catch (error) {
      if (error instanceof AgentFsError) throw error
      throw new GrantResolverError(error instanceof Error ? error.message : 'Grant resolver failed', {
        tenant: actor.tenant,
        mount: mount.key,
      })
    }
    if (typeof result?.read !== 'boolean' || !['direct', 'staged', 'none'].includes(result.write)) {
      throw new GrantResolverError('Grant resolver returned an invalid grant', {
        tenant: actor.tenant,
        mount: mount.key,
      })
    }
    const grant = { read: result.read, write: result.write }
    if (!options.bypassCache) this.cache.set(key, { expiresAt: now + this.ttlMs, grant })
    return grant
  }

  invalidate(actorId: string, mountKey?: string, tenant?: string): void {
    const actorPrefix = tenant === undefined ? undefined : `${tenant}\u0000${actorId}\u0000`
    for (const key of this.cache.keys()) {
      if (actorPrefix !== undefined) {
        if (!key.startsWith(actorPrefix)) continue
      } else {
        const parts = key.split('\u0000')
        if (parts.length !== 3 || parts[1] !== actorId) continue
      }
      if (mountKey === undefined || key.endsWith(`\u0000${mountKey}`)) this.cache.delete(key)
    }
  }

  private async withTimeout<T>(promise: Promise<T>): Promise<T> {
    let timer: NodeJS.Timeout | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Grant resolver timed out after ${this.timeoutMs}ms`)), this.timeoutMs)
    })
    try {
      return await Promise.race([promise, timeout])
    } finally {
      clearTimeout(timer)
    }
  }
}
