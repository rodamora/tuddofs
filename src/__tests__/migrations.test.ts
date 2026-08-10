import './test-setup.js'

import assert from 'node:assert/strict'
import test from 'node:test'

import { SchemaDriftError } from '../errors.js'
import { migrate } from '../migration.js'

const frozenColumns = [
  ['afs_blobs', 'id'],
  ['afs_blobs', 'tenant'],
  ['afs_blobs', 'sha256'],
  ['afs_blobs', 'size_bytes'],
  ['afs_blobs', 'inline'],
  ['afs_blobs', 'object_key'],
  ['afs_blobs', 'created_at'],
  ['afs_trees', 'id'],
  ['afs_trees', 'tenant'],
  ['afs_trees', 'tree_sha'],
  ['afs_trees', 'created_at'],
  ['afs_tree_entries', 'tree_id'],
  ['afs_tree_entries', 'path'],
  ['afs_tree_entries', 'blob_id'],
  ['afs_tree_entries', 'mode'],
  ['afs_commits', 'id'],
  ['afs_commits', 'tenant'],
  ['afs_commits', 'commit_sha'],
  ['afs_commits', 'tree_id'],
  ['afs_commits', 'parents'],
  ['afs_commits', 'author_user'],
  ['afs_commits', 'agent_kind'],
  ['afs_commits', 'thread_id'],
  ['afs_commits', 'run_id'],
  ['afs_commits', 'op'],
  ['afs_commits', 'message'],
  ['afs_commits', 'created_at'],
  ['afs_refs', 'tenant'],
  ['afs_refs', 'name'],
  ['afs_refs', 'kind'],
  ['afs_refs', 'commit_id'],
  ['afs_refs', 'base_commit'],
  ['afs_refs', 'state'],
  ['afs_refs', 'created_at'],
  ['afs_refs', 'settled_at'],
  ['afs_heads', 'tenant'],
  ['afs_heads', 'ref_name'],
  ['afs_heads', 'path'],
  ['afs_heads', 'blob_id'],
  ['afs_heads', 'sha256'],
  ['afs_heads', 'size_bytes'],
] as const

function fakePool(schema = frozenColumns.map(([table_name, column_name]) => ({ table_name, column_name }))) {
  const state = { migrations: [] as { version: number; name: string }[], ddlApplications: 0 }
  return {
    state,
    async connect() {
      return {
        async query<Row extends Record<string, unknown>>(text: string) {
          if (text.includes('FROM afs_migrations')) {
            return { rows: state.migrations as Row[], rowCount: state.migrations.length }
          }
          if (text.includes('FROM information_schema.tables')) {
            const tables = [...new Set(schema.map(column => column.table_name)), 'afs_migrations'].sort()
            return { rows: tables.map(table_name => ({ table_name })) as Row[], rowCount: tables.length }
          }
          if (text.includes('FROM information_schema.columns')) {
            const orderedSchema = [...schema].sort((left, right) => left.table_name.localeCompare(right.table_name))
            return { rows: orderedSchema as Row[], rowCount: orderedSchema.length }
          }
          if (text.startsWith('INSERT INTO afs_migrations')) {
            if (state.migrations.length === 0) state.migrations.push({ version: 1, name: 'initial schema' })
            return { rows: [], rowCount: 1 }
          }
          if (
            !/^(BEGIN|COMMIT|ROLLBACK|SELECT pg_advisory)/.test(text) &&
            !text.includes('information_schema') &&
            !text.includes('afs_migrations')
          )
            state.ddlApplications += 1
          return { rows: [], rowCount: 0 }
        },
        release() {},
      }
    },
  }
}

test('migrate records migration 001 and makes the second call a schema-checked no-op', async () => {
  const pool = fakePool()

  await migrate(pool)
  const firstDdlApplications = pool.state.ddlApplications
  await migrate(pool)

  assert.deepEqual(pool.state.migrations, [{ version: 1, name: 'initial schema' }])
  assert.equal(pool.state.ddlApplications, firstDdlApplications)
})

test('migrate rejects a drifted frozen table with a typed error', async () => {
  const schema = frozenColumns
    .filter(([, column_name]) => column_name !== 'size_bytes')
    .map(([table_name, column_name]) => ({ table_name, column_name }))
  const pool = fakePool(schema)

  await assert.rejects(migrate(pool), error => error instanceof SchemaDriftError)
})
