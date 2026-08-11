import { SchemaDriftError } from './errors.js'

/**
 * The database handle accepted by package-owned migrations.
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

export interface TuddoFsMigrationOptions {
  readonly schema?: string
}

export const DEFAULT_TUDDOFS_SCHEMA = 'public'

const SCHEMA_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_$]{0,62}$/u

export function normalizeTuddoFsSchema(schema: string | undefined): string {
  const value = schema ?? DEFAULT_TUDDOFS_SCHEMA
  if (typeof value !== 'string' || !SCHEMA_IDENTIFIER.test(value))
    throw new TypeError('tuddofs schema must be a 1-63 character PostgreSQL identifier')
  return value
}

function quotedIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`
}

export function createTuddoFsSchemaPool(pool: TuddoFsPool, schema: string): TuddoFsPool {
  const normalizedSchema = normalizeTuddoFsSchema(schema)
  const quotedSchema = quotedIdentifier(normalizedSchema)
  return {
    async connect() {
      const client = await pool.connect()
      try {
        await client.query(`SET search_path TO ${quotedSchema}, pg_catalog`)
      } catch (error) {
        client.release(error instanceof Error ? error : undefined)
        throw error
      }
      let released = false
      return {
        async query<Row extends Record<string, unknown>>(text: string, values?: readonly unknown[]) {
          const result = await client.query<Row>(text, values)
          if (/^BEGIN(?:\s|$)/iu.test(text.trim()))
            await client.query(`SET LOCAL search_path TO ${quotedSchema}, pg_catalog`)
          return result
        },
        release(error?: Error) {
          if (released) return
          released = true
          client.release(error)
        },
      }
    },
  }
}

/**
 * Migration 001 is the frozen §4.1 kernel schema. It is immutable once its
 * ledger row is committed; future schema changes must append a new migration.
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

function symmetricDifference(
  expected: readonly string[],
  actual: readonly string[],
): {
  missing: string[]
  unexpected: string[]
} {
  const expectedSet = new Set(expected)
  const actualSet = new Set(actual)
  return {
    missing: expected.filter(value => !actualSet.has(value)),
    unexpected: actual.filter(value => !expectedSet.has(value)),
  }
}

const RECOVERY_GUIDANCE =
  'Migration 001 is already recorded; restore missing objects from a backup or, if data can be discarded, drop the configured schema and rerun migrate.'

async function assertFrozenSchema(client: TuddoFsClient, schema: string): Promise<void> {
  const tableNames = [...new Set(EXPECTED_COLUMNS.map(column => column.table_name))].sort()
  const tables = await client.query<{ table_name: string }>(
    `SELECT table_name
     FROM information_schema.tables
     WHERE table_schema = $1 AND table_name LIKE 'tuddo\\_%'
     ORDER BY table_name`,
    [schema],
  )
  const expectedTables = [...tableNames, 'tuddo_migrations'].sort()
  const actualTables = tables.rows.map(row => row.table_name).sort()
  const tableDiff = symmetricDifference(expectedTables, actualTables)
  if (tableDiff.missing.length > 0 || tableDiff.unexpected.length > 0) {
    throw new SchemaDriftError(
      `tuddofs schema drift detected in schema "${schema}": missing tables [${tableDiff.missing.join(', ') || 'none'}], unexpected tables [${tableDiff.unexpected.join(', ') || 'none'}]. ${RECOVERY_GUIDANCE}`,
    )
  }
  const result = await client.query<SchemaColumn>(
    `SELECT table_name, column_name
     FROM information_schema.columns
     WHERE table_schema = $1 AND table_name = ANY($2::text[])
     ORDER BY table_name, ordinal_position`,
    [schema, tableNames],
  )
  const expected = EXPECTED_COLUMNS.map(column => `${column.table_name}.${column.column_name}`).sort()
  const actual = result.rows.map(column => `${column.table_name}.${column.column_name}`).sort()
  const columnDiff = symmetricDifference(expected, actual)
  if (columnDiff.missing.length > 0 || columnDiff.unexpected.length > 0) {
    throw new SchemaDriftError(
      `tuddofs schema drift detected in schema "${schema}": missing columns [${columnDiff.missing.join(', ') || 'none'}], unexpected columns [${columnDiff.unexpected.join(', ') || 'none'}]. ${RECOVERY_GUIDANCE}`,
    )
  }
}

/**
 * Apply package-owned migrations under a transaction-local advisory lock, then
 * verify the live §4.1 schema even when every migration is already recorded.
 */
export async function migrate(pool: TuddoFsPool, options: TuddoFsMigrationOptions | string = {}): Promise<void> {
  const schema = normalizeTuddoFsSchema(typeof options === 'string' ? options : options.schema)
  const quotedSchema = quotedIdentifier(schema)
  const client = await pool.connect()
  let committed = false
  try {
    await client.query('BEGIN')
    await client.query(`SET LOCAL search_path TO ${quotedSchema}, pg_catalog`)
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('tuddofs:migrations'))`)
    await client.query(`CREATE SCHEMA IF NOT EXISTS ${quotedSchema}`)
    await client.query(LEDGER_DDL)
    const applied = await client.query<MigrationRow>('SELECT version, name FROM tuddo_migrations ORDER BY version')
    for (const migration of MIGRATIONS) {
      const row = applied.rows.find(candidate => candidate.version === migration.version)
      if (row) {
        if (row.name !== migration.name) {
          throw new SchemaDriftError(
            `Migration ${migration.version} has immutable name drift: expected "${migration.name}", found "${row.name}".`,
          )
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
    await assertFrozenSchema(client, schema)
    await client.query('COMMIT')
    committed = true
  } catch (error) {
    if (!committed) await client.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally {
    client.release()
  }
}

export const tuddoFsDdl: readonly string[] = DDL
