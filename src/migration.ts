import { SchemaDriftError } from './errors.js'

/**
 * The database handle accepted by package-owned migrations.
 * @see spec §4.1 and §10b.2
 */
export interface TuddoFsClient {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rows: Row[]; rowCount: number | null }>
  release(error?: Error): void
}

export interface TuddoFsPool {
  connect(): Promise<TuddoFsClient>
}

type SchemaColumn = { table_name: string; column_name: string }
type MigrationRow = { version: number; name: string }

const LEDGER_DDL = `CREATE TABLE IF NOT EXISTS tuddo_migrations (
  version     INTEGER PRIMARY KEY,
  name        TEXT NOT NULL,
  applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
)`

/**
 * Migration 001 is the frozen §4.1 kernel schema. It is immutable once its
 * ledger row is committed; future schema changes must append a new migration.
 * @see spec §15.7
 */
const DDL = [
  `CREATE TABLE IF NOT EXISTS tuddo_blobs (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant      TEXT NOT NULL,
  sha256      TEXT NOT NULL,
  size_bytes  BIGINT NOT NULL,
  inline      BYTEA,
  object_key  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant, sha256),
  CHECK ((inline IS NULL) <> (object_key IS NULL))
)`,
  `CREATE TABLE IF NOT EXISTS tuddo_trees (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant      TEXT NOT NULL,
  tree_sha    TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant, tree_sha)
)`,
  `CREATE TABLE IF NOT EXISTS tuddo_tree_entries (
  tree_id     BIGINT NOT NULL REFERENCES tuddo_trees(id) ON DELETE CASCADE,
  path        TEXT NOT NULL,
  blob_id     BIGINT NOT NULL REFERENCES tuddo_blobs(id) ON DELETE RESTRICT,
  mode        INT NOT NULL DEFAULT 420,
  PRIMARY KEY (tree_id, path)
)`,
  `CREATE TABLE IF NOT EXISTS tuddo_commits (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant      TEXT NOT NULL,
  commit_sha  TEXT NOT NULL,
  tree_id     BIGINT NOT NULL REFERENCES tuddo_trees(id) ON DELETE RESTRICT,
  parents     BIGINT[] NOT NULL DEFAULT '{}',
  author_user TEXT NOT NULL,
  agent_kind  TEXT,
  thread_id   TEXT,
  run_id      TEXT,
  op          TEXT NOT NULL,
  message     TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant, commit_sha)
)`,
  'CREATE INDEX IF NOT EXISTS tuddo_commits_run ON tuddo_commits (tenant, run_id) WHERE run_id IS NOT NULL',
  'CREATE INDEX IF NOT EXISTS tuddo_commits_thread ON tuddo_commits (tenant, thread_id) WHERE thread_id IS NOT NULL',
  `CREATE TABLE IF NOT EXISTS tuddo_refs (
  tenant       TEXT NOT NULL,
  name         TEXT NOT NULL,
  kind         TEXT NOT NULL,
  commit_id    BIGINT NOT NULL REFERENCES tuddo_commits(id) ON DELETE RESTRICT,
  base_commit  BIGINT REFERENCES tuddo_commits(id) ON DELETE RESTRICT,
  state        TEXT NOT NULL DEFAULT 'open',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  settled_at   TIMESTAMPTZ,
  PRIMARY KEY (tenant, name)
)`,
  `CREATE TABLE IF NOT EXISTS tuddo_heads (
  tenant      TEXT NOT NULL,
  ref_name    TEXT NOT NULL,
  path        TEXT NOT NULL,
  blob_id     BIGINT NOT NULL,
  sha256      TEXT NOT NULL,
  size_bytes  BIGINT NOT NULL,
  PRIMARY KEY (tenant, ref_name, path)
)`,
] as const

const EXPECTED_COLUMNS: readonly SchemaColumn[] = [
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
].map(([table_name, column_name]) => ({ table_name, column_name }))

const MIGRATIONS = [{ version: 1, name: 'initial schema', statements: DDL }] as const

async function assertFrozenSchema(client: TuddoFsClient): Promise<void> {
  const tableNames = [...new Set(EXPECTED_COLUMNS.map(column => column.table_name))].sort()
  const tables = await client.query<{ table_name: string }>(
    `SELECT table_name
     FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name LIKE 'tuddo\\_%'
     ORDER BY table_name`,
  )
  const expectedTables = [...tableNames, 'tuddo_migrations'].sort()
  const actualTables = tables.rows.map(row => row.table_name).sort()
  if (
    actualTables.length !== expectedTables.length ||
    actualTables.some((tableName, index) => tableName !== expectedTables[index])
  ) {
    throw new SchemaDriftError(
      `Agent FS schema drift detected: expected ${expectedTables.length} tables, found ${actualTables.length}`,
    )
  }
  const result = await client.query<SchemaColumn>(
    `SELECT table_name, column_name
     FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = ANY($1::text[])
     ORDER BY table_name, ordinal_position`,
    [tableNames],
  )
  const expected = EXPECTED_COLUMNS.map(column => `${column.table_name}.${column.column_name}`).sort()
  const actual = result.rows.map(column => `${column.table_name}.${column.column_name}`).sort()
  if (actual.length !== expected.length || actual.some((column, index) => column !== expected[index])) {
    throw new SchemaDriftError(
      `Agent FS schema drift detected: expected ${expected.length} frozen columns, found ${actual.length}`,
    )
  }
}

/**
 * Apply package-owned migrations under a transaction-local advisory lock, then
 * verify the live §4.1 schema even when every migration is already recorded.
 * @see spec §4.1, §10b.2, and §15.7
 */
export async function migrate(pool: TuddoFsPool): Promise<void> {
  const client = await pool.connect()
  let committed = false
  try {
    await client.query('BEGIN')
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('tuddofs:migrations'))`)
    await client.query(LEDGER_DDL)
    const applied = await client.query<MigrationRow>('SELECT version, name FROM tuddo_migrations ORDER BY version')
    for (const migration of MIGRATIONS) {
      const row = applied.rows.find(candidate => candidate.version === migration.version)
      if (row) {
        if (row.name !== migration.name) {
          throw new SchemaDriftError(`Migration ${migration.version} has immutable name drift`)
        }
        continue
      }
      for (const statement of migration.statements) await client.query(statement)
      await client.query(
        `INSERT INTO tuddo_migrations (version, name)
         VALUES ($1, $2)
         ON CONFLICT (version) DO NOTHING`,
        [migration.version, migration.name],
      )
    }
    await assertFrozenSchema(client)
    await client.query('COMMIT')
    committed = true
  } catch (error) {
    if (!committed) await client.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally {
    client.release()
  }
}

export const tuddoFsDdl = DDL
