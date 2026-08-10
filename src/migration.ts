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

/**
 * Create all Agent FS tables and indexes. Calling this repeatedly is safe.
 * @see spec §4.1
 */
export async function migrate(pool: AgentFsPool): Promise<void> {
  const client = await pool.connect()
  let committed = false
  try {
    await client.query('BEGIN')
    for (const statement of DDL) await client.query(statement)
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
