import assert from 'node:assert/strict'
import test, { after, before, beforeEach } from 'node:test'

import { Pool } from 'pg'

import { InvalidPathError, NotFoundError, createTuddoFs, migrate } from '../index.js'

const pool = new Pool({ connectionString: process.env.TUDDOFS_DATABASE_URL })
const tenant = 'tree-coherence-tenant'
const mount = 'project:coherence'
const authorUser = 'coherence-user'
const actor = { id: authorUser, tenant }
const grants = { resolve: async () => ({ read: true, write: 'direct' as const }) }

before(async () => migrate(pool))
beforeEach(async () => {
  await pool.query(
    'TRUNCATE tuddo_heads, tuddo_refs, tuddo_commits, tuddo_tree_entries, tuddo_trees, tuddo_blobs RESTART IDENTITY CASCADE',
  )
})
after(async () => pool.end())

function assertTreeCoherent(paths: readonly string[], message?: string): void {
  for (const path of paths) {
    for (const candidate of paths) {
      if (candidate !== path && candidate.startsWith(`${path}/`)) {
        assert.fail(message ?? `incoherent tree: ${path} prefixes ${candidate}`)
      }
    }
  }
}

async function refTipPaths(ref: string): Promise<string[]> {
  const result = await pool.query<{ path: string }>(
    `SELECT e.path
     FROM tuddo_refs r
     JOIN tuddo_commits c ON c.id = r.commit_id
     JOIN tuddo_tree_entries e ON e.tree_id = c.tree_id
     WHERE r.tenant = $1 AND r.name = $2
     ORDER BY e.path`,
    [tenant, ref],
  )
  return result.rows.map(row => row.path)
}

test('write rejects file-as-directory and directory-as-file collisions, then permits delete-first replacement', async () => {
  const fs = createTuddoFs({ pool, grants })
  const branch = await fs.fork({ tenant, mount, sessionId: 'write-collisions', authorUser })
  assert.ok(branch)

  await fs.write({ tenant, mount, ref: branch.ref, path: '/a', bytes: 'file', authorUser })
  await assert.rejects(
    fs.write({ tenant, mount, ref: branch.ref, path: '/a/x.md', bytes: 'nested', authorUser }),
    error => error instanceof InvalidPathError && error.message.includes('/a'),
  )

  await fs.delete({ tenant, mount, ref: branch.ref, path: '/a', authorUser })
  await fs.write({ tenant, mount, ref: branch.ref, path: '/a/x.md', bytes: 'nested', authorUser })
  await assert.rejects(
    fs.write({ tenant, mount, ref: branch.ref, path: '/a', bytes: 'file', authorUser }),
    error => error instanceof InvalidPathError && error.message.includes('/a/x.md'),
  )

  await fs.delete({ tenant, mount, ref: branch.ref, path: '/a/x.md', authorUser })
  await fs.write({ tenant, mount, ref: branch.ref, path: '/a', bytes: 'replacement', authorUser })
  assert.deepEqual(await refTipPaths(branch.ref), ['/a'])
})

test('merge returns conflicts on both paths when coherent trees have a prefix collision', async () => {
  const fs = createTuddoFs({ pool, grants })
  const session = await fs.open({ actor, sessionId: 'merge-collision', mounts: [{ key: mount }] })
  const ours = await session.write(`${mount}:/a`, 'ours')
  const theirs = await fs.write({
    tenant,
    mount,
    ref: `mount/${mount}`,
    path: '/a/x.md',
    bytes: 'theirs',
    authorUser,
  })
  const mountTipBefore = await pool.query<{ commit_id: string }>(
    'SELECT commit_id::text FROM tuddo_refs WHERE tenant = $1 AND name = $2',
    [tenant, `mount/${mount}`],
  )

  assert.deepEqual(await session.resolveMerge(mount), {
    conflicts: [
      { path: '/a', oursSha: ours.sha256 },
      { path: '/a/x.md', theirsSha: theirs.sha256 },
    ],
  })
  const mountTipAfter = await pool.query<{ commit_id: string }>(
    'SELECT commit_id::text FROM tuddo_refs WHERE tenant = $1 AND name = $2',
    [tenant, `mount/${mount}`],
  )
  assert.deepEqual(mountTipAfter.rows, mountTipBefore.rows)
  assert.deepEqual(await refTipPaths(`mount/${mount}`), ['/a/x.md'])
})

test('verify reports a hand-seeded incoherent ref-tip tree', async () => {
  const fs = createTuddoFs({ pool, grants })
  const branch = await fs.fork({ tenant, mount, sessionId: 'verify-collision', authorUser })
  assert.ok(branch)
  await fs.write({ tenant, mount, ref: branch.ref, path: '/a', bytes: 'seed', authorUser })
  const tip = await pool.query<{ tree_id: string; blob_id: string }>(
    `SELECT c.tree_id::text, e.blob_id::text
     FROM tuddo_refs r
     JOIN tuddo_commits c ON c.id = r.commit_id
     JOIN tuddo_tree_entries e ON e.tree_id = c.tree_id
     WHERE r.tenant = $1 AND r.name = $2 AND e.path = '/a'`,
    [tenant, branch.ref],
  )
  assert.ok(tip.rows[0])
  await pool.query(
    `INSERT INTO tuddo_tree_entries (tree_id, path, blob_id, mode)
     VALUES ($1::bigint, '/a/x.md', $2::bigint, 420)`,
    [tip.rows[0].tree_id, tip.rows[0].blob_id],
  )

  const report = await fs.verify({ tenant })
  assert.deepEqual(
    report.findings.filter(finding => finding.kind === 'tree-coherence'),
    [
      {
        kind: 'tree-coherence',
        tenant,
        ref: branch.ref,
        path: '/a',
        collidingPath: '/a/x.md',
      },
    ],
  )
})

test('seeded randomized writes stay coherent and colliding coherent merges always conflict', async () => {
  const configuredSeed = process.env.TUDDOFS_PROPERTY_SEED
  const initialSeed = configuredSeed === undefined ? 0x6d2b79f5 : Number(configuredSeed)
  assert.ok(
    Number.isInteger(initialSeed) && initialSeed >= 0 && initialSeed <= 0xffffffff,
    'TUDDOFS_PROPERTY_SEED must be an unsigned 32-bit integer',
  )
  let seed = initialSeed
  const next = (): number => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
    return seed
  }
  const fs = createTuddoFs({ pool, grants })
  let iteration = 0
  try {
    const branch = await fs.fork({ tenant, mount, sessionId: 'property-ops', authorUser })
    assert.ok(branch)
    const paths = ['/a', '/a/x.md', '/b', '/b/x/y.md', '/c.md'] as const
    for (; iteration < 64; iteration += 1) {
      const path = paths[next() % paths.length]
      if (next() % 4 === 0) {
        try {
          await fs.delete({ tenant, mount, ref: branch.ref, path, authorUser })
        } catch (error) {
          if (!(error instanceof NotFoundError)) throw error
        }
      } else {
        try {
          await fs.write({ tenant, mount, ref: branch.ref, path, bytes: `value-${next()}`, authorUser })
        } catch (error) {
          if (!(error instanceof InvalidPathError)) throw error
        }
      }
      assertTreeCoherent(await refTipPaths(branch.ref), `seed=${initialSeed} operation=${iteration}`)
    }

    for (iteration = 0; iteration < 12; iteration += 1) {
      const propertyMount = `coherence:p${iteration}`
      const ancestor = `/node-${next() % 5}`
      const descendant = `${ancestor}/leaf-${next() % 5}.md`
      const session = await fs.open({
        actor,
        sessionId: `property-merge-${iteration}`,
        mounts: [{ key: propertyMount }],
      })
      const oursPath = next() % 2 === 0 ? ancestor : descendant
      const theirsPath = oursPath === ancestor ? descendant : ancestor
      await session.write(`${propertyMount}:${oursPath}`, `ours-${iteration}`)
      await fs.write({
        tenant,
        mount: propertyMount,
        ref: `mount/${propertyMount}`,
        path: theirsPath,
        bytes: `theirs-${iteration}`,
        authorUser,
      })
      const result = await session.resolveMerge(propertyMount)
      assert.ok(typeof result === 'object' && 'conflicts' in result, `seed=${initialSeed} merge=${iteration}`)
      assert.deepEqual(
        result.conflicts.map(conflict => conflict.path).sort(),
        [ancestor, descendant].sort(),
        `seed=${initialSeed} merge=${iteration}`,
      )
      assertTreeCoherent(await refTipPaths(`mount/${propertyMount}`), `seed=${initialSeed} merge=${iteration}`)
    }
  } catch (error) {
    throw new Error(`seed=${initialSeed} iteration=${iteration}`, { cause: error })
  }
})
