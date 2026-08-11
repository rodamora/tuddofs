import assert from 'node:assert/strict'
import test, { after, before } from 'node:test'

import { Pool } from 'pg'

import { createTuddoFs, migrate } from '../internal.js'

const connectionString = process.env.TUDDOFS_DATABASE_URL
const schema = 'tuddo_schema_path_test'
const adminPool = new Pool({ connectionString })
const grants = { resolve: async () => ({ read: true, write: 'direct' as const }) }

before(async () => {
  await adminPool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
})

after(async () => {
  await adminPool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
  await adminPool.end()
})

test('fresh migration targets the configured schema despite a different pool search_path', async () => {
  const pool = new Pool({ connectionString, options: `-c search_path=${schema}` })
  try {
    await migrate(pool, { schema })
    const tables = await adminPool.query<{ table_name: string }>(
      `SELECT table_name
       FROM information_schema.tables
       WHERE table_schema = $1 AND table_name LIKE 'tuddo\\_%'
       ORDER BY table_name`,
      [schema],
    )
    assert.deepEqual(
      tables.rows.map(row => row.table_name),
      [
        'tuddo_blobs',
        'tuddo_commits',
        'tuddo_heads',
        'tuddo_migrations',
        'tuddo_refs',
        'tuddo_tree_entries',
        'tuddo_trees',
      ],
    )

    const fs = createTuddoFs({ pool, schema, grants })
    const branch = await fs.fork({
      tenant: 'schema-path-tenant',
      mount: 'project:schema-path',
      sessionId: 'schema-path-session',
      authorUser: 'schema-path-user',
    })
    assert.ok(branch)
    const write = await fs.write({
      tenant: 'schema-path-tenant',
      mount: 'project:schema-path',
      ref: branch.ref,
      path: '/readme.txt',
      bytes: 'configured schema',
      authorUser: 'schema-path-user',
    })
    const read = await fs.read({
      tenant: 'schema-path-tenant',
      mount: 'project:schema-path',
      ref: branch.ref,
      path: '/readme.txt',
    })
    assert.equal(read?.sha256, write.sha256)
    assert.equal(read?.bytes.toString(), 'configured schema')
  } finally {
    await pool.end()
  }
})

test('default migration stays on public when the pool search_path points elsewhere', async () => {
  await migrate(adminPool)
  await adminPool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
  await adminPool.query(`CREATE SCHEMA "${schema}"`)
  const pool = new Pool({ connectionString, options: `-c search_path=${schema}` })
  try {
    await migrate(pool)
    const publicTables = await adminPool.query<{ count: string }>(
      `SELECT count(*)::text AS count
       FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name LIKE 'tuddo\\_%'`,
    )
    const alternateTables = await adminPool.query<{ count: string }>(
      `SELECT count(*)::text AS count
       FROM information_schema.tables
       WHERE table_schema = $1 AND table_name LIKE 'tuddo\\_%'`,
      [schema],
    )
    assert.equal(publicTables.rows[0]?.count, '7')
    assert.equal(alternateTables.rows[0]?.count, '0')
  } finally {
    await pool.end()
  }
})
