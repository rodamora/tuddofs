import assert from 'node:assert/strict'
import test from 'node:test'

import { GrantResolverError, GrantController, PermissionDeniedError } from '../index.js'

test('resolver throw surfaces GrantResolverError and denies the operation', async () => {
  const grants = new GrantController({
    resolve: async () => {
      throw new Error('acl unavailable')
    },
  })

  await assert.rejects(grants.resolve({ id: 'u1', tenant: 't1' }, { key: 'project:one' }), GrantResolverError)
})

test('typed TuddoFsError from a resolver propagates without taxonomy wrapping', async () => {
  const denied = new PermissionDeniedError('resolver denied', { tenant: 't1', mount: 'project:one' })
  const grants = new GrantController({
    resolve: async () => {
      throw denied
    },
  })

  await assert.rejects(grants.resolve({ id: 'u1', tenant: 't1' }, { key: 'project:one' }), error => error === denied)
})

test('resolver timeout surfaces GrantResolverError and denies the operation', async () => {
  const grants = new GrantController({
    timeoutMs: 5,
    resolve: async () => await new Promise(() => undefined),
  })

  await assert.rejects(grants.resolve({ id: 'u1', tenant: 't1' }, { key: 'project:one' }), GrantResolverError)
})

test('grant cache expires, invalidation clears one mount, and bypass always resolves', async () => {
  let now = 0
  let calls = 0
  const grants = new GrantController({
    ttlMs: 30_000,
    now: () => now,
    resolve: async () => {
      calls += 1
      return { read: true, write: 'direct' }
    },
  })
  const actor = { id: 'u1', tenant: 't1' }
  const mount = { key: 'project:one' }

  await grants.resolve(actor, mount)
  await grants.resolve(actor, mount)
  assert.equal(calls, 1)
  now = 30_001
  await grants.resolve(actor, mount)
  assert.equal(calls, 2)
  grants.invalidate('u1', 'project:one')
  await grants.resolve(actor, mount)
  assert.equal(calls, 3)
  await grants.resolve(actor, mount, { bypassCache: true })
  assert.equal(calls, 4)
})
test('grant cache reaps expired entries when resolving a new grant', async () => {
  let now = 0
  const grants = new GrantController({
    now: () => now,
    resolve: async () => ({ read: true, write: 'direct' }),
  })
  for (let index = 0; index < 25; index += 1)
    await grants.resolve({ id: `u${index}`, tenant: 't1' }, { key: 'project:one' })

  assert.equal((grants as unknown as { cache: Map<string, unknown> }).cache.size, 25)
  now = 30_001
  await grants.resolve({ id: 'fresh', tenant: 't1' }, { key: 'project:one' })
  assert.equal((grants as unknown as { cache: Map<string, unknown> }).cache.size, 1)
})
