import assert from 'node:assert/strict'
import test, { after, before, beforeEach } from 'node:test'

import { Pool } from 'pg'
import {
  BranchSettledError,
  NotFoundError,
  PermissionDeniedError,
  PreconditionFailedError,
  createTuddoFs,
} from '../index.js'
import { GrantController, InvalidPathError, migrate } from '../internal.js'

const pool = new Pool({ connectionString: process.env.TUDDOFS_DATABASE_URL })
const tenant = 'session-security-integration'
const actor = { id: 'security-user', tenant }

before(async () => migrate(pool))
beforeEach(async () => {
  await pool.query(
    'TRUNCATE tuddo_heads, tuddo_refs, tuddo_commits, tuddo_tree_entries, tuddo_trees, tuddo_blobs RESTART IDENTITY CASCADE',
  )
})
after(async () => pool.end())

function fsWith(
  grant: (mount: string) => {
    read: boolean
    write: 'direct' | 'staged' | 'none'
  },
) {
  return createTuddoFs({
    pool,
    grants: { resolve: async (_actor, mount) => grant(mount.key) },
  })
}
function deferred<T>(): {
  promise: Promise<T>
  resolve: (value?: T | PromiseLike<T>) => void
} {
  let resolve!: (value?: T | PromiseLike<T>) => void
  const promise = new Promise<T>(resolvePromise => {
    resolve = value => resolvePromise(value as T)
  })
  return { promise, resolve }
}

async function seedMount(key: string, path: string, value: string): Promise<string> {
  const fs = fsWith(() => ({ read: true, write: 'direct' }))
  const session = await fs.open({
    actor,
    sessionId: `seed-${key}`,
    mounts: [{ key }],
  })
  const result = await session.write(`${key}:${path}`, value)
  await session.merge({ mounts: [key] })
  return result.commitSha
}
async function waitForMergeGrantFreshnessWindow(): Promise<void> {
  // A real delay is intentional: this reproduces wall-clock pool wait aging against disposable Postgres.
  const { promise, resolve } = deferred<void>()
  setTimeout(resolve, 150)
  await promise
}

test('pinnedRef rejects a commit or ref outside the pinned mount lineage', async () => {
  await seedMount('hr-payroll', '/secret.txt', 'payroll-secret')
  const fs = fsWith(() => ({ read: true, write: 'direct' }))
  const session = await fs.open({
    actor,
    sessionId: 'pin-confinement',
    mounts: [{ key: 'scratch', mode: { pin: 'mount/hr-payroll' } }],
  })

  await assert.rejects(session.read('scratch:/secret.txt'), NotFoundError)
})
test('restore rejects a foreign tenant commit that is not in the addressed mount lineage', async () => {
  const foreignSha = await seedMount('foreign', '/secret.txt', 'foreign-secret')
  const fs = fsWith(() => ({ read: true, write: 'direct' }))
  const session = await fs.open({
    actor,
    sessionId: 'restore-confinement',
    mounts: [{ key: 'scratch' }],
  })

  await assert.rejects(session.restore('scratch', foreignSha), NotFoundError)
})

test('pinnedRef rejects a foreign commit SHA even when the ref is hidden', async () => {
  const foreignSha = await seedMount('hr-payroll', '/secret.txt', 'payroll-secret')
  const fs = fsWith(() => ({ read: true, write: 'direct' }))
  const session = await fs.open({
    actor,
    sessionId: 'pin-sha-confinement',
    mounts: [{ key: 'scratch', mode: { pin: foreignSha } }],
  })

  await assert.rejects(session.read('scratch:/secret.txt'), NotFoundError)
})

test('timeline only returns commits reachable from the session mounts', async () => {
  const foreignSha = await seedMount('foreign', '/secret.txt', 'foreign-secret')
  const fs = fsWith(() => ({ read: true, write: 'direct' }))
  const session = await fs.open({
    actor,
    sessionId: 'timeline-confinement',
    mounts: [{ key: 'scratch' }],
  })
  const ownSha = (await session.write('scratch:/own.txt', 'own')).commitSha

  const timeline = await session.timeline()
  assert.ok(timeline.some(record => record.commitSha === ownSha))
  assert.ok(!timeline.some(record => record.commitSha === foreignSha))
})

test('history only returns path changes from the addressed mount lineage', async () => {
  await seedMount('foreign', '/secret.txt', 'foreign-secret')
  const fs = fsWith(() => ({ read: true, write: 'direct' }))
  const session = await fs.open({
    actor,
    sessionId: 'history-confinement',
    mounts: [{ key: 'scratch' }],
  })

  assert.deepEqual(await session.history('scratch:/secret.txt'), [])
})

test('history includes a deletion commit when the path disappears from the tree', async () => {
  const fs = fsWith(() => ({ read: true, write: 'direct' }))
  const session = await fs.open({
    actor,
    sessionId: 'history-deletion',
    mounts: [{ key: 'scratch' }],
  })
  await session.write('scratch:/deleted.txt', 'gone')
  await session.delete('scratch:/deleted.txt')

  assert.ok((await session.history('scratch:/deleted.txt')).some(record => record.op === 'delete'))
})

test('timeline re-resolves read permission for every granted mount', async () => {
  let read = true
  const fs = fsWith(() => ({ read, write: 'direct' }))
  const session = await fs.open({
    actor,
    sessionId: 'timeline-grant-check',
    mounts: [{ key: 'scratch' }],
  })
  read = false

  await assert.rejects(session.timeline(), PermissionDeniedError)
})

test('diff rejects raw commits that are not reachable from a granted mount', async () => {
  const foreignSha = await seedMount('foreign', '/secret.txt', 'foreign-secret')
  const fs = fsWith(() => ({ read: true, write: 'direct' }))
  const session = await fs.open({
    actor,
    sessionId: 'diff-confinement',
    mounts: [{ key: 'scratch' }],
  })
  const ownSha = (await session.write('scratch:/own.txt', 'own')).commitSha

  await assert.rejects(session.diff(foreignSha, ownSha), NotFoundError)
})

test('restore re-resolves the write grant at operation time', async () => {
  let write: 'direct' | 'none' = 'direct'
  const fs = fsWith(() => ({ read: true, write }))
  const seed = await fs.open({
    actor,
    sessionId: 'restore-grant-seed',
    mounts: [{ key: 'scratch' }],
  })
  const sha = (await seed.write('scratch:/before.txt', 'before')).commitSha
  write = 'none'

  const session = await fs.open({
    actor,
    sessionId: 'restore-grant-check',
    mounts: [{ key: 'scratch' }],
  })
  await assert.rejects(session.restore('scratch', sha), PermissionDeniedError)
})

test('restore refuses to mutate a settled branch', async () => {
  const fs = fsWith(() => ({ read: true, write: 'direct' }))
  const session = await fs.open({
    actor,
    sessionId: 'restore-settled-check',
    mounts: [{ key: 'scratch' }],
  })
  const sha = (await session.write('scratch:/before.txt', 'before')).commitSha
  await session.discard()

  await assert.rejects(session.restore('scratch', sha), BranchSettledError)
})

test('tag re-resolves write permission and validates labels', async () => {
  let write: 'direct' | 'none' = 'direct'
  const fs = fsWith(() => ({ read: true, write }))
  const session = await fs.open({
    actor,
    sessionId: 'tag-validation',
    mounts: [{ key: 'scratch' }],
  })
  write = 'none'
  await assert.rejects(session.tag('scratch', 'safe'), PermissionDeniedError)

  write = 'direct'
  await assert.rejects(session.tag('scratch', '../escape'), InvalidPathError)
})

test('tag state is immutable and uses the tag state', async () => {
  const fs = fsWith(() => ({ read: true, write: 'direct' }))
  const session = await fs.open({
    actor,
    sessionId: 'tag-immutable',
    mounts: [{ key: 'scratch' }],
  })
  await session.write('scratch:/first.txt', 'first')
  const tagName = await session.tag('scratch', 'snapshot')
  await session.write('scratch:/second.txt', 'second')

  await assert.rejects(session.tag('scratch', 'snapshot'), PreconditionFailedError)
  const tag = await pool.query<{ commit_sha: string; state: string }>(
    `SELECT c.commit_sha, r.state
     FROM tuddo_refs r JOIN tuddo_commits c ON c.id = r.commit_id
     WHERE r.tenant = $1 AND r.name = $2`,
    [tenant, tagName],
  )
  assert.equal(tag.rows[0]?.state, 'tag')
  assert.equal(tag.rows[0]?.commit_sha, (await session.timeline()).find(record => record.op === 'write')?.commitSha)
})

test('merge records unauthorized when the live writer grant is revoked', async () => {
  let write: 'direct' | 'none' = 'direct'
  const fs = fsWith(() => ({ read: true, write }))
  const session = await fs.open({
    actor,
    sessionId: 'merge-unauthorized',
    mounts: [{ key: 'scratch' }],
  })
  write = 'none'

  assert.deepEqual(await session.merge({ mounts: ['scratch'] }), {
    scratch: { status: 'unauthorized' },
  })
  const branch = await pool.query<{ state: string }>('SELECT state FROM tuddo_refs WHERE tenant = $1 AND name = $2', [
    tenant,
    'agent/merge-unauthorized/scratch',
  ])
  assert.equal(branch.rows[0]?.state, 'unauthorized')
})
test('commit resolution ignores a revoked unrelated mount until lineage matches', async () => {
  const read = new Map([
    ['locked', true],
    ['okmount', true],
  ])
  const fs = createTuddoFs({
    pool,
    grants: {
      resolve: async (_actor, mount) => ({
        read: read.get(mount.key) ?? false,
        write: 'direct' as const,
      }),
    },
  })
  const session = await fs.open({
    actor,
    sessionId: 'resolve-mount-order',
    mounts: [{ key: 'locked' }, { key: 'okmount' }],
  })
  const first = await session.write('okmount:/a.txt', 'a')
  const second = await session.write('okmount:/a.txt', 'b')
  read.set('locked', false)

  assert.equal(await session.read('okmount:/a.txt'), 'b')
  assert.deepEqual(await session.diff(first.commitSha, second.commitSha), [
    {
      path: '/a.txt',
      beforeSha: first.sha256,
      afterSha: second.sha256,
      beforeMode: 420,
      afterMode: 420,
    },
  ])
})

test('staged merge returns merged for an already merged branch', async () => {
  let write: 'direct' | 'staged' = 'staged'
  const fs = fsWith(() => ({ read: true, write }))
  const session = await fs.open({
    actor,
    sessionId: 'staged-merged-idempotency',
    mounts: [{ key: 'scratch' }],
  })
  await session.write('scratch:/staged.txt', 'staged')

  write = 'direct'
  assert.deepEqual(await session.merge({ mounts: ['scratch'] }), { scratch: { status: 'merged' } })
  write = 'staged'
  assert.deepEqual(await session.merge({ mounts: ['scratch'] }), { scratch: { status: 'merged' } })
})

test('staged merge reports unauthorized for an abandoned branch', async () => {
  const fs = fsWith(() => ({ read: true, write: 'staged' }))
  const session = await fs.open({
    actor,
    sessionId: 'staged-abandoned',
    mounts: [{ key: 'scratch' }],
  })
  await session.write('scratch:/staged.txt', 'staged')
  await session.discard()

  assert.deepEqual(await session.merge({ mounts: ['scratch'] }), {
    scratch: { status: 'unauthorized' },
  })
})

test('kernel delete retries a compare-and-swap conflict before failing', async () => {
  const normal = fsWith(() => ({ read: true, write: 'direct' }))
  const session = await normal.open({
    actor,
    sessionId: 'delete-cas',
    mounts: [{ key: 'scratch' }],
  })
  await session.write('scratch:/delete-me.txt', 'delete-me')

  let failures = 1
  const flakyPool = {
    connect: async () => {
      const client = await pool.connect()
      return {
        query: async <Row extends Record<string, unknown>>(text: string, values?: readonly unknown[]) => {
          if (text.includes('UPDATE tuddo_refs SET commit_id') && failures > 0) {
            failures -= 1
            return { rows: [] as Row[], rowCount: 0 }
          }
          return client.query<Row>(text, values === undefined ? undefined : [...values])
        },
        release: (error?: Error) => client.release(error),
      }
    },
  }
  const flaky = createTuddoFs({
    pool: flakyPool,
    grants: { resolve: async () => ({ read: true, write: 'direct' }) },
    maxCasRetries: 2,
  })

  const result = await flaky.delete({
    tenant,
    mount: 'scratch',
    ref: 'agent/delete-cas/scratch',
    path: '/delete-me.txt',
    authorUser: actor.id,
  })
  assert.equal(result.path, '/delete-me.txt')
  assert.equal(failures, 0)
})
test('grant cache isolates identical actor ids across tenants and enforces its ttl ceiling', async () => {
  let calls = 0
  const grants = new GrantController({
    ttlMs: 30_000,
    resolve: async actorForGrant => {
      calls += 1
      return { read: actorForGrant.tenant === 'tenant-a', write: 'none' }
    },
  })
  const sameId = { id: 'same-user', tenant: 'tenant-a' }
  await grants.resolve(sameId, { key: 'mount' })
  const other = await grants.resolve({ id: sameId.id, tenant: 'tenant-b' }, { key: 'mount' })
  assert.equal(other.read, false)
  assert.equal(calls, 2)
  grants.invalidate('same-user', 'mount', 'tenant-a')
  await grants.resolve(sameId, { key: 'mount' })
  await grants.resolve({ id: sameId.id, tenant: 'tenant-b' }, { key: 'mount' })
  assert.equal(calls, 3)
  assert.throws(
    () =>
      new GrantController({
        ttlMs: 30_001,
        resolve: async () => ({ read: true, write: 'none' }),
      }),
    RangeError,
  )
})
test('wildcard mount keys cannot read a sibling mount through pinned refs', async () => {
  const foreignSha = await seedMount('secrets', '/secret.txt', 'foreign-secret')
  const fs = fsWith(() => ({ read: true, write: 'direct' }))
  const session = await fs.open({
    actor,
    sessionId: 'wildcard-pin',
    mounts: [{ key: 'secret_', mode: { pin: foreignSha } }],
  })

  await assert.rejects(session.read('secret_:/secret.txt'), NotFoundError)
})
test('wildcard mount keys cannot restore a sibling mount by raw commit SHA', async () => {
  const foreignSha = await seedMount('secrets', '/secret.txt', 'foreign-secret')
  const fs = fsWith(() => ({ read: true, write: 'direct' }))
  const session = await fs.open({
    actor,
    sessionId: 'wildcard-restore-sha',
    mounts: [{ key: 'secret_' }],
  })

  await assert.rejects(session.restore('secret_', foreignSha), NotFoundError)
})

test('wildcard mount keys cannot restore a sibling mount by tag ref', async () => {
  const fs = fsWith(() => ({ read: true, write: 'direct' }))
  const foreign = await fs.open({
    actor,
    sessionId: 'wildcard-tag-seed',
    mounts: [{ key: 'secrets' }],
  })
  await foreign.write('secrets:/secret.txt', 'foreign-secret')
  const tag = await foreign.tag('secrets', 'v1')
  const session = await fs.open({
    actor,
    sessionId: 'wildcard-restore-tag',
    mounts: [{ key: 'secret_' }],
  })

  await assert.rejects(session.restore('secret_', tag), NotFoundError)
})

test('wildcard mount keys cannot diff a sibling mount by raw commit SHA', async () => {
  const foreignSha = await seedMount('secrets', '/secret.txt', 'foreign-secret')
  const fs = fsWith(() => ({ read: true, write: 'direct' }))
  const session = await fs.open({
    actor,
    sessionId: 'wildcard-diff',
    mounts: [{ key: 'secret_' }],
  })
  const ownSha = (await session.write('secret_:/own.txt', 'own')).commitSha

  await assert.rejects(session.diff(foreignSha, ownSha), NotFoundError)
})
test('merge does not hold its transaction connection across a pool-backed grant resolver', async () => {
  const resolverPool = new Pool({
    connectionString: process.env.TUDDOFS_DATABASE_URL,
    max: 2,
  })
  try {
    const fs = createTuddoFs({
      pool: resolverPool,
      grantTimeoutMs: 100,
      grants: {
        resolve: async () => {
          const held = await resolverPool.connect()
          try {
            await resolverPool.query('SELECT 1')
            return { read: true, write: 'direct' as const }
          } finally {
            held.release()
          }
        },
      },
    })
    const session = await fs.open({
      actor,
      sessionId: 'merge-pool-grant',
      mounts: [{ key: 'scratch' }],
    })

    assert.deepEqual(await session.merge(), { scratch: 'merged' })
  } finally {
    await resolverPool.end()
  }
})
test('merge refreshes a grant that aged while waiting for a saturated pool', async () => {
  const saturatedPool = new Pool({
    connectionString: process.env.TUDDOFS_DATABASE_URL,
    max: 1,
  })
  let write: 'direct' | 'none' = 'direct'
  let grantCalls = 0
  let mergeStarted = false
  let observed = false
  const { promise: grantRelease, resolve: releaseGrant } = deferred<void>()
  const { promise: grantSeen, resolve: grantObserved } = deferred<void>()
  let held: { release(): void } | undefined
  try {
    const fs = createTuddoFs({
      pool: saturatedPool,
      grants: {
        resolve: async () => {
          grantCalls += 1
          const grant = { read: true, write }
          if (mergeStarted && !observed) {
            observed = true
            grantObserved()
            await grantRelease
          }
          return grant
        },
      },
    })
    const session = await fs.open({
      actor,
      sessionId: 'merge-grant-revoked-while-waiting',
      mounts: [{ key: 'scratch' }],
    })
    await session.write('scratch:/staged.txt', 'staged')
    held = await saturatedPool.connect()
    mergeStarted = true
    const mergePromise = session.merge({ mounts: ['scratch'] })

    await grantSeen
    write = 'none'
    releaseGrant()
    await waitForMergeGrantFreshnessWindow()
    held.release()
    held = undefined

    const result = await mergePromise
    assert.ok(grantCalls >= 5)
    assert.deepEqual(result, { scratch: { status: 'unauthorized' } })
    const branch = await pool.query<{ state: string }>('SELECT state FROM tuddo_refs WHERE tenant = $1 AND name = $2', [
      tenant,
      'agent/merge-grant-revoked-while-waiting/scratch',
    ])
    assert.equal(branch.rows[0]?.state, 'unauthorized')
  } finally {
    held?.release()
    await saturatedPool.end()
  }
})

test('merge refreshes a stale denied grant after it is restored while waiting', async () => {
  const saturatedPool = new Pool({
    connectionString: process.env.TUDDOFS_DATABASE_URL,
    max: 1,
  })
  let grantCalls = 0
  let write: 'direct' | 'none' = 'direct'
  let mergeStarted = false
  let observed = false
  const { promise: grantSeen, resolve: grantObserved } = deferred<void>()
  const { promise: grantRelease, resolve: releaseGrant } = deferred<void>()
  let held: { release(): void } | undefined
  try {
    const fs = createTuddoFs({
      pool: saturatedPool,
      grants: {
        resolve: async () => {
          grantCalls += 1
          const grant = { read: true, write }
          if (mergeStarted && !observed) {
            observed = true
            grantObserved()
            await grantRelease
          }
          return grant
        },
      },
    })
    const session = await fs.open({
      actor,
      sessionId: 'merge-grant-restored-while-waiting',
      mounts: [{ key: 'scratch' }],
    })
    await session.write('scratch:/staged.txt', 'staged')
    held = await saturatedPool.connect()
    write = 'none'
    mergeStarted = true
    const mergePromise = session.merge({ mounts: ['scratch'] })

    await grantSeen
    write = 'direct'
    releaseGrant()
    await waitForMergeGrantFreshnessWindow()
    held.release()
    held = undefined
    const result = await mergePromise
    assert.ok(grantCalls >= 5)
    assert.deepEqual(result, { scratch: { status: 'merged' } })
    const branch = await pool.query<{ state: string }>('SELECT state FROM tuddo_refs WHERE tenant = $1 AND name = $2', [
      tenant,
      'agent/merge-grant-restored-while-waiting/scratch',
    ])
    assert.equal(branch.rows[0]?.state, 'merged')
  } finally {
    held?.release()
    await saturatedPool.end()
  }
})

test('merge records the other mount when a settled mount throws', async () => {
  let pWrite: 'direct' | 'none' = 'direct'
  const fs = createTuddoFs({
    pool,

    grants: {
      resolve: async (_actor, mount) => ({
        read: true,
        write: mount.key === 'p' ? pWrite : 'direct',
      }),
    },
  })
  const session = await fs.open({
    actor,
    sessionId: 'merge-settled-loop',
    mounts: [{ key: 'p' }, { key: 'q' }],
  })
  await session.write('p:/p.txt', 'p')
  await session.write('q:/q.txt', 'q')
  pWrite = 'none'
  assert.deepEqual(await session.merge({ mounts: ['p'] }), { p: { status: 'unauthorized' } })
  pWrite = 'direct'

  assert.deepEqual(await session.merge(), {
    p: { status: 'unauthorized' },
    q: { status: 'merged' },
  })
  assert.equal((await session.read('q:/q.txt')).toString(), 'q')
})
test('merge reports a settled mount alongside other per-mount outcomes', async () => {
  const fs = fsWith(() => ({ read: true, write: 'direct' }))
  const session = await fs.open({
    actor,
    sessionId: 'merge-settled-result',
    mounts: [{ key: 'p' }, { key: 'q' }],
  })
  await session.write('p:/p.txt', 'p')
  await session.write('q:/q.txt', 'q')
  await pool.query(
    `UPDATE tuddo_refs SET state = 'abandoned', settled_at = now()
     WHERE tenant = $1 AND name = $2`,
    [tenant, 'agent/merge-settled-result/p'],
  )

  assert.deepEqual(await session.merge(), {
    p: { status: 'unauthorized' },
    q: { status: 'merged' },
  })
})

test('timeline orders writes globally across mounts', async () => {
  const fs = fsWith(() => ({ read: true, write: 'direct' }))
  const session = await fs.open({
    actor,
    sessionId: 'timeline-global-order',
    mounts: [{ key: 'p' }, { key: 'q' }],
  })
  const p1 = (await session.write('p:/p1.txt', 'p1')).commitSha
  const q1 = (await session.write('q:/q1.txt', 'q1')).commitSha
  const p2 = (await session.write('p:/p2.txt', 'p2')).commitSha
  const q2 = (await session.write('q:/q2.txt', 'q2')).commitSha

  assert.deepEqual(
    (await session.timeline()).filter(record => record.op === 'write').map(record => record.commitSha),
    [p1, q1, p2, q2],
  )
})

test('history includes a parentless import commit when the path is present', async () => {
  const fs = fsWith(() => ({ read: true, write: 'direct' }))
  const session = await fs.open({
    actor,
    sessionId: 'history-parentless-import',
    mounts: [{ key: 'scratch' }],
  })
  const write = await session.write('scratch:/imported.txt', 'imported')
  const branch = await pool.query<{ commit_id: string }>(
    'SELECT commit_id::text FROM tuddo_refs WHERE tenant = $1 AND name = $2',
    [tenant, 'agent/history-parentless-import/scratch'],
  )
  await pool.query("UPDATE tuddo_commits SET parents = '{}', op = 'import' WHERE tenant = $1 AND id = $2::bigint", [
    tenant,
    branch.rows[0]?.commit_id,
  ])

  assert.ok((await session.history('scratch:/imported.txt')).some(record => record.commitSha === write.commitSha))
})

test('merge rejects an approver from another tenant before resolving its grant', async () => {
  const seen: string[] = []
  const fs = createTuddoFs({
    pool,
    grants: {
      resolve: async actorForGrant => {
        seen.push(actorForGrant.tenant)
        return { read: true, write: 'staged' }
      },
    },
  })
  const session = await fs.open({
    actor,
    sessionId: 'merge-approver-tenant',
    mounts: [{ key: 'scratch' }],
  })
  await session.write('scratch:/staged.txt', 'staged')

  await assert.rejects(
    session.merge({
      approver: { id: 'foreign-approver', tenant: 'other-tenant' },
    }),
    PermissionDeniedError,
  )
  assert.ok(!seen.includes('other-tenant'))
})
test('timeline preserves stored merge parent order', async () => {
  const fs = fsWith(() => ({ read: true, write: 'direct' }))
  const first = await fs.open({
    actor,
    sessionId: 'merge-parent-first',
    mounts: [{ key: 'scratch' }],
  })
  const firstWrite = await first.write('scratch:/first.txt', 'first')
  await first.merge({ mounts: ['scratch'] })

  const second = await fs.open({
    actor,
    sessionId: 'merge-parent-second',
    mounts: [{ key: 'scratch' }],
  })
  const secondWrite = await second.write('scratch:/second.txt', 'second')
  const external = await fs.open({
    actor,
    sessionId: 'merge-parent-external',
    mounts: [{ key: 'scratch' }],
  })
  await external.write('scratch:/external.txt', 'external')
  await external.merge({ mounts: ['scratch'] })
  assert.deepEqual(await second.merge({ mounts: ['scratch'] }), { scratch: { status: 'merged' } })

  const mountTip = await pool.query<{ commit_id: string; parents: string[] }>(
    `SELECT c.id::text, c.parents
     FROM tuddo_refs r JOIN tuddo_commits c ON c.id = r.commit_id
     WHERE r.tenant = $1 AND r.name = 'mount/scratch'`,
    [tenant],
  )
  const parentShas = await pool.query<{ commit_sha: string }>(
    'SELECT commit_sha FROM tuddo_commits WHERE id = ANY($1::bigint[]) ORDER BY array_position($1::bigint[], id)',
    [mountTip.rows[0]?.parents],
  )
  const viewer = await fs.open({
    actor,
    sessionId: 'merge-parent-viewer',
    mounts: [{ key: 'scratch' }],
  })
  const timeline = await viewer.timeline()
  const merge = timeline.filter(record => record.op === 'merge').at(-1)
  assert.ok(merge)
  assert.deepEqual(
    merge?.parentShas,
    parentShas.rows.map(row => row.commit_sha),
  )
  assert.equal(merge?.parentShas[0], parentShas.rows[0]?.commit_sha)
  void firstWrite
  void secondWrite
})
test('session merge omits pinned mounts including when selected', async () => {
  await seedMount('pinned-source', '/source.txt', 'source')
  const fs = fsWith(() => ({ read: true, write: 'direct' }))
  const session = await fs.open({
    actor,
    sessionId: 'pinned-merge',
    mounts: [{ key: 'pinned', mode: { pin: 'mount/pinned-source' } }],
  })

  assert.deepEqual(await session.merge(), {})
  assert.deepEqual(await session.merge({ mounts: ['pinned'] }), {})
})
