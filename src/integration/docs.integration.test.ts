/**
 * The runnable half of the §13.7 docs contract: the shell blocks a consumer is
 * told to copy are executed against real PostgreSQL, not just type-checked.
 *
 * `src/__tests__/docs.test.ts` compiles every TypeScript example; this file
 * runs the two JavaScript programs the documents hand out verbatim — the
 * README quickstart (governed write) and the host guide's maintenance job
 * (scheduled GC and verify). Together they are the acceptance path: zero to
 * governed writes to scheduled maintenance, using only the documents.
 */
import assert from 'node:assert/strict'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { Pool } from 'pg'

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))))
const ENTRY = pathToFileURL(join(ROOT, 'src/index.ts')).href

/** The body of a `cat > <file> <<'EOF' … EOF` heredoc, with the package import pointed at this checkout. */
async function heredoc(document: string, filename: string): Promise<string> {
  const markdown = await readFile(join(ROOT, document), 'utf8')
  const pattern = new RegExp(`cat > ${filename.replace(/\./gu, '\\.')} <<'EOF'\\n([\\s\\S]*?)\\nEOF`, 'u')
  const match = pattern.exec(markdown)
  assert.ok(match?.[1], `${document} no longer contains a runnable ${filename} block`)
  return match[1].replace("from 'tuddofs'", `from '${ENTRY}'`)
}

/** Run a generated module, capturing what it printed. */
async function runModule(source: string, name: string): Promise<unknown[][]> {
  const sourcePath = join(ROOT, `.docs-${name}-${process.pid}.mjs`)
  const output: unknown[][] = []
  const originalLog = console.log
  console.log = (...args: unknown[]) => {
    output.push(args)
  }
  try {
    await writeFile(sourcePath, source)
    // The module is generated from a document at runtime, so it cannot be statically imported.
    await import(`${pathToFileURL(sourcePath).href}?run=${Date.now()}`)
  } finally {
    console.log = originalLog
    await rm(sourcePath, { force: true })
  }
  return output
}

test('README JavaScript quickstart runs against PostgreSQL', async () => {
  const output = await runModule(await heredoc('README.md', 'demo.mjs'), 'quickstart')
  assert.deepEqual(output, [['Ship safely.\n']])
})

test('host-guide maintenance job runs GC and verify against PostgreSQL', async () => {
  // Serial suite, shared database: start from a clean slate so the audit is
  // judging this test's state and not another suite's deliberate corruption.
  const pool = new Pool({ connectionString: process.env.TUDDOFS_DATABASE_URL })
  try {
    await pool.query(
      'TRUNCATE tuddo_heads, tuddo_refs, tuddo_commits, tuddo_tree_entries, tuddo_trees, tuddo_blobs RESTART IDENTITY CASCADE',
    )
  } finally {
    await pool.end()
  }

  const output = await runModule(await heredoc('docs/host-guide.md', 'tuddofs-maintenance.mjs'), 'maintenance')
  assert.equal(output.length, 1)
  const summary = JSON.parse(String(output[0]?.[0])) as {
    collectedBlobs: number
    collectedObjects: number
    settledBranches: number
    skippedTenants: readonly string[]
    verifyOk: boolean
    findings: number
  }
  assert.equal(summary.verifyOk, true)
  assert.equal(summary.findings, 0)
  assert.deepEqual(summary.skippedTenants, [])
  assert.equal(process.exitCode, undefined, 'a clean audit must not set a failing exit code')
})
