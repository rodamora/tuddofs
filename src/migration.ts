import { SchemaDriftError } from './errors.js'

/**
 * The database handle accepted by package-owned migrations.
 * @see spec §4.1 and §10b.2
 */
export interface AgentFsClient {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rows: Row[]; rowCount: number | null }>
  release(): void
}

export interface AgentFsPool {
  connect(): Promise<AgentFsClient>
}

type SchemaColumn = { table_name: string; column_name: string }
type MigrationRow = { version: number; name: string }

const LEDGER_DDL = `CREATE TABLE IF NOT EXISTS afs_migrations (
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
  `CREATE TABLE IF NOT EXISTS afs_blobs (
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
  `CREATE TABLE IF NOT EXISTS afs_trees (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant      TEXT NOT NULL,
  tree_sha    TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant, tree_sha)
)`,
  `CREATE TABLE IF NOT EXISTS afs_tree_entries (
  tree_id     BIGINT NOT NULL REFERENCES afs_trees(id) ON DELETE CASCADE,
  path        TEXT NOT NULL,
  blob_id     BIGINT NOT NULL REFERENCES afs_blobs(id) ON DELETE RESTRICT,
  mode        INT NOT NULL DEFAULT 420,
  PRIMARY KEY (tree_id, path)
)`,
  `CREATE TABLE IF NOT EXISTS afs_commits (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant      TEXT NOT NULL,
  commit_sha  TEXT NOT NULL,
  tree_id     BIGINT NOT NULL REFERENCES afs_trees(id) ON DELETE RESTRICT,
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
  'CREATE INDEX IF NOT EXISTS afs_commits_run ON afs_commits (tenant, run_id) WHERE run_id IS NOT NULL',
  'CREATE INDEX IF NOT EXISTS afs_commits_thread ON afs_commits (tenant, thread_id) WHERE thread_id IS NOT NULL',
  `CREATE TABLE IF NOT EXISTS afs_refs (
  tenant       TEXT NOT NULL,
  name         TEXT NOT NULL,
  kind         TEXT NOT NULL,
  commit_id    BIGINT NOT NULL REFERENCES afs_commits(id) ON DELETE RESTRICT,
  base_commit  BIGINT REFERENCES afs_commits(id) ON DELETE RESTRICT,
  state        TEXT NOT NULL DEFAULT 'open',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  settled_at   TIMESTAMPTZ,
  PRIMARY KEY (tenant, name)
)`,
  `CREATE TABLE IF NOT EXISTS afs_heads (
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
].map(([table_name, column_name]) => ({ table_name, column_name }))

const MIGRATIONS = [{ version: 1, name: 'initial schema', statements: DDL }] as const

async function assertFrozenSchema(client: AgentFsClient): Promise<void> {
  const tableNames = [...new Set(EXPECTED_COLUMNS.map(column => column.table_name))].sort()
  const tables = await client.query<{ table_name: string }>(
    `SELECT table_name
     FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name LIKE 'afs_%'
     ORDER BY table_name`,
  )
  const expectedTables = [...tableNames, 'afs_migrations'].sort()
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
export async function migrate(pool: AgentFsPool): Promise<void> {
  const client = await pool.connect()
  let committed = false
  try {
    await client.query('BEGIN')
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('agent-fs:migrations'))`)
    await client.query(LEDGER_DDL)
    const applied = await client.query<MigrationRow>('SELECT version, name FROM afs_migrations ORDER BY version')
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
        `INSERT INTO afs_migrations (version, name)
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

export const agentFsDdl = DDL
