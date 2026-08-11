import assert from 'node:assert/strict'
import test, { after, before, beforeEach } from 'node:test'

import { Pool } from 'pg'
import { GrantResolverError, PermissionDeniedError, createTuddoFs } from '../index.js'
import { migrate } from '../internal.js'

const pool = new Pool({ connectionString: process.env.TUDDOFS_DATABASE_URL })
const tenant = 'grants-integration'
const actor = { id: 'user-grants', tenant }
const never = new Promise<never>(() => undefined)

before(async () => migrate(pool))
beforeEach(async () => {
  await pool.query(
    'TRUNCATE tuddo_heads, tuddo_refs, tuddo_commits, tuddo_tree_entries, tuddo_trees, tuddo_blobs RESTART IDENTITY CASCADE',
  )
})
after(async () => pool.end())

test('resolver throw and timeout fail closed as GrantResolverError during open', async () => {
  const throwing = createTuddoFs({
    pool,
    grants: {
      resolve: async () => {
        throw new Error('down')
      },
    },
  })
  await assert.rejects(
    throwing.open({
      actor,
      sessionId: 'throw',
      mounts: [{ key: 'project:grant' }],
    }),
    GrantResolverError,
  )
  const hanging = createTuddoFs({
    pool,
    grantTimeoutMs: 5,
    grants: { resolve: async () => never },
  })
  await assert.rejects(
    hanging.open({
      actor,
      sessionId: 'timeout',
      mounts: [{ key: 'project:grant' }],
    }),
    GrantResolverError,
  )
})

test('fork and merge bypass the grant cache, and invalidation is actor+mount scoped', async () => {
  let calls = 0
  let mode: 'direct' | 'none' = 'direct'
  const fs = createTuddoFs({
    pool,
    grants: {
      resolve: async () => {
        calls += 1
        return { read: true, write: mode }
      },
    },
  })
  const session = await fs.open({
    actor,
    sessionId: 'bypass',
    mounts: [{ key: 'project:grant' }],
  })
  assert.ok(calls >= 2)
  const beforeMerge = calls
  assert.deepEqual(await session.merge(), { 'project:grant': { status: 'merged' } })
  assert.ok(calls > beforeMerge)
  mode = 'none'
  await assert.rejects(session.mount('project:grant').write('/denied', 'x'), PermissionDeniedError)
  assert.deepEqual(await session.merge(), { 'project:grant': { status: 'merged' } })
})

test('permission revocation is enforced at write time and system actor cannot open a session', async () => {
  let mode: 'direct' | 'none' = 'direct'
  const fs = createTuddoFs({
    pool,
    grantCacheTtlMs: 0,
    grants: { resolve: async () => ({ read: true, write: mode }) },
  })
  const session = await fs.open({
    actor,
    sessionId: 'revocation',
    mounts: [{ key: 'project:grant' }],
  })
  mode = 'none'
  await assert.rejects(session.mount('project:grant').write('/revoked', 'x'), PermissionDeniedError)
  await assert.rejects(
    fs.open({
      actor: { id: 'system', tenant },
      sessionId: 'system',
      mounts: [{ key: 'project:grant' }],
    }),
    PermissionDeniedError,
  )
})
