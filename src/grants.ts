import { GrantResolverError } from './errors.js'
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

  constructor(options: GrantControllerOptions | GrantResolver) {
    this.resolveFn = options.resolve
    this.ttlMs = 'ttlMs' in options ? (options.ttlMs ?? 30_000) : 30_000
    this.timeoutMs = 'timeoutMs' in options ? (options.timeoutMs ?? 5_000) : 5_000
    this.now = 'now' in options ? (options.now ?? (() => Date.now())) : () => Date.now()
    if (!Number.isFinite(this.ttlMs) || this.ttlMs < 0)
      throw new RangeError('Grant cache TTL must be finite and non-negative')
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0)
      throw new RangeError('Grant resolver timeout must be finite and positive')
  }

  async resolve(actor: Actor, mount: { key: string }, options: { bypassCache?: boolean } = {}): Promise<Grant> {
    const key = `${actor.id}\u0000${mount.key}`
    const now = this.now()
    if (!options.bypassCache) {
      const cached = this.cache.get(key)
      if (cached && cached.expiresAt > now) return cached.grant
      if (cached) this.cache.delete(key)
    }
    let result: Grant
    try {
      result = await this.withTimeout(this.resolveFn(actor, mount))
    } catch (error) {
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

  invalidate(actorId: string, mountKey?: string): void {
    if (mountKey === undefined) {
      for (const key of this.cache.keys()) if (key.startsWith(`${actorId}\u0000`)) this.cache.delete(key)
      return
    }
    this.cache.delete(`${actorId}\u0000${mountKey}`)
  }

  private async withTimeout<T>(promise: Promise<T>): Promise<T> {
    const promiseConstructor = Promise as typeof Promise & {
      withResolvers<T>(): { promise: Promise<T>; resolve(value: T): void }
    }
    const { promise: timeout, resolve } = promiseConstructor.withResolvers<never>()
    const timer = setTimeout(() => resolve(undefined as never), this.timeoutMs)
    try {
      return await Promise.race([
        promise,
        timeout.then(() => {
          throw new Error(`Grant resolver timed out after ${this.timeoutMs}ms`)
        }),
      ])
    } finally {
      clearTimeout(timer)
    }
  }
}
