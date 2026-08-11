import './test-setup.js'

import assert from 'node:assert/strict'
import test from 'node:test'

import { SchemaDriftError } from '../errors.js'
import { migrate } from '../migration.js'

const frozenColumns = [
  ['tuddo_blobs', 'id'],
  ['tuddo_blobs', 'tenant'],
  ['tuddo_blobs', 'sha256'],
  ['tuddo_blobs', 'size_bytes'],
  ['tuddo_blobs', 'inline'],
  ['tuddo_blobs', 'object_key'],
  ['tuddo_blobs', 'created_at'],
  ['tuddo_trees', 'id'],
  ['tuddo_trees', 'tenant'],
  ['tuddo_trees', 'tree_sha'],
  ['tuddo_trees', 'created_at'],
  ['tuddo_tree_entries', 'tree_id'],
  ['tuddo_tree_entries', 'path'],
  ['tuddo_tree_entries', 'blob_id'],
  ['tuddo_tree_entries', 'mode'],
  ['tuddo_commits', 'id'],
  ['tuddo_commits', 'tenant'],
  ['tuddo_commits', 'commit_sha'],
  ['tuddo_commits', 'tree_id'],
  ['tuddo_commits', 'parents'],
  ['tuddo_commits', 'author_user'],
  ['tuddo_commits', 'agent_kind'],
  ['tuddo_commits', 'thread_id'],
  ['tuddo_commits', 'run_id'],
  ['tuddo_commits', 'op'],
  ['tuddo_commits', 'message'],
  ['tuddo_commits', 'created_at'],
  ['tuddo_refs', 'tenant'],
  ['tuddo_refs', 'name'],
  ['tuddo_refs', 'kind'],
  ['tuddo_refs', 'commit_id'],
  ['tuddo_refs', 'base_commit'],
  ['tuddo_refs', 'state'],
  ['tuddo_refs', 'created_at'],
  ['tuddo_refs', 'settled_at'],
  ['tuddo_heads', 'tenant'],
  ['tuddo_heads', 'ref_name'],
  ['tuddo_heads', 'path'],
  ['tuddo_heads', 'blob_id'],
  ['tuddo_heads', 'sha256'],
  ['tuddo_heads', 'size_bytes'],
] as const

function fakePool(
  schema = frozenColumns.map(([table_name, column_name]) => ({
    table_name,
    column_name,
  })),
  extraTables: readonly string[] = [],
) {
  const state = {
    migrations: [] as { version: number; name: string }[],
    ddlApplications: 0,
    commands: [] as string[],
  }
  return {
    state,
    async connect() {
      return {
        async query<Row extends Record<string, unknown>>(text: string) {
          state.commands.push(text)
          if (text.includes('FROM tuddo_migrations')) {
            return {
              rows: state.migrations as unknown as Row[],
              rowCount: state.migrations.length,
            }
          }
          if (text.includes('FROM information_schema.tables')) {
            const allTables = [
              ...new Set([...schema.map(column => column.table_name), ...extraTables, 'tuddo_migrations']),
            ]
            const tables = text.includes("LIKE 'tuddo\\_%'")
              ? allTables.filter(table_name => table_name.startsWith('tuddo_'))
              : allTables
            tables.sort()
            return {
              rows: tables.map(table_name => ({ table_name })) as unknown as Row[],
              rowCount: tables.length,
            }
          }
          if (text.includes('FROM information_schema.columns')) {
            const orderedSchema = [...schema].sort((left, right) => left.table_name.localeCompare(right.table_name))
            return {
              rows: orderedSchema as unknown as Row[],
              rowCount: orderedSchema.length,
            }
          }
          if (text.startsWith('INSERT INTO tuddo_migrations')) {
            if (state.migrations.length === 0) state.migrations.push({ version: 1, name: 'initial schema' })
            return { rows: [], rowCount: 1 }
          }
          if (
            !/^(BEGIN|COMMIT|ROLLBACK|SET LOCAL|SET search_path|RESET search_path|CREATE SCHEMA|SELECT pg_advisory)/.test(
              text,
            ) &&
            !text.includes('information_schema') &&
            !text.includes('tuddo_migrations')
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

test('migrate ignores cohabiting tuddox_ tables when checking the frozen schema', async () => {
  const pool = fakePool(undefined, ['tuddox_cache'])

  await migrate(pool)

  assert.deepEqual(pool.state.migrations, [{ version: 1, name: 'initial schema' }])
})

test('migrate rejects a drifted frozen table with a typed error', async () => {
  const schema = frozenColumns
    .filter(([, column_name]) => column_name !== 'size_bytes')
    .map(([table_name, column_name]) => ({ table_name, column_name }))
  const pool = fakePool(schema)

  await assert.rejects(migrate(pool), error => error instanceof SchemaDriftError)
})

test('migrate checks frozen schema drift when migration ledger is already applied', async () => {
  const schema = frozenColumns
    .filter(([, column_name]) => column_name !== 'size_bytes')
    .map(([table_name, column_name]) => ({ table_name, column_name }))
  const pool = fakePool(schema)
  pool.state.migrations.push({ version: 1, name: 'initial schema' })

  await assert.rejects(migrate(pool), error => error instanceof SchemaDriftError)
})

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

test('migrate pins the configured schema with a transaction-local search path', async () => {
  const pool = fakePool()

  await migrate(pool, { schema: 'app' })

  assert.ok(pool.state.commands.some(command => command === 'SET LOCAL search_path TO "app", pg_catalog'))
})

test('migrate names differing tables and explains recovery', async () => {
  const pool = fakePool(undefined, ['tuddo_unexpected'])

  await assert.rejects(
    migrate(pool),
    error =>
      error instanceof SchemaDriftError &&
      error.message.includes('tuddo_unexpected') &&
      error.message.includes('restore missing objects'),
  )
})

test('migrate names differing columns', async () => {
  const schema = frozenColumns
    .filter(([, column_name]) => column_name !== 'size_bytes')
    .map(([table_name, column_name]) => ({ table_name, column_name }))
  const pool = fakePool(schema)

  await assert.rejects(
    migrate(pool),
    error => error instanceof SchemaDriftError && error.message.includes('tuddo_blobs.size_bytes'),
  )
})
