/**
 * tuddofs sync-engine harness
 *
 * Mounts a governed tuddofs filesystem to a real directory, runs an omp agent
 * there with ALL native tools (bash, read, write, grep, glob, edit), then
 * reconciles changes back into the content-addressed store.
 *
 * No custom tools. The agent just works in a directory. tuddofs governs underneath.
 *
 * Prerequisites:
 *   - Disposable Postgres (docker run --rm -d --name tuddofs-pg \
 *       -e POSTGRES_USER=tuddofs -e POSTGRES_PASSWORD=tuddofs \
 *       -e POSTGRES_DB=tuddofs_it -p 55800:5432 postgres:16-alpine)
 *   - omp installed (bun install -g @oh-my-pi/pi-coding-agent)
 *
 * Run:
 *   TUDDOFS_DATABASE_URL="postgresql://tuddofs:tuddofs@127.0.0.1:55800/tuddofs_it" \
 *     npx tsx examples/sync-harness.ts
 */
import { Pool } from 'pg'
import { createTuddoFs } from 'tuddofs'
import { createSyncEngine, createLocalDirectoryTarget, mirrorDirName } from 'tuddofs/internal'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtemp, rm, readFile, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// ── tuddofs setup ──────────────────────────────────────────────────────

const DATABASE_URL = process.env.TUDDOFS_DATABASE_URL
if (!DATABASE_URL) {
  console.error('Set TUDDOFS_DATABASE_URL to a disposable Postgres.')
  process.exit(1)
}

const pool = new Pool({ connectionString: DATABASE_URL })
const tenant = 'test'
const mount = 'project:agent'

const fs = createTuddoFs({
  pool,
  grants: {
    resolve(actor, requestedMount) {
      return Promise.resolve(
        actor.tenant === tenant && requestedMount.key === mount
          ? { read: true, write: 'direct' }
          : { read: false, write: 'none' },
      )
    },
  },
})

await fs.migrate()

const session = await fs.open({
  actor: { id: 'test-agent', tenant },
  sessionId: 'harness-1',
  mounts: [mount],
})

// Seed a task file into the governed store
const mountHandle = session.mount(mount)
await mountHandle.write(
  '/TASK.md',
  'Create src/greeting.ts exporting greet(name: string): string. Then create README.md.\n',
)

// ── sync engine: materialize to a real directory ──────────────────────

const workspace = await mkdtemp(join(tmpdir(), 'tuddofs-mount-'))
const target = createLocalDirectoryTarget({ root: workspace })

const engine = createSyncEngine({
  session,
  target,
  root: workspace,
  events: {
    onCapture: entries => console.log(`  [capture] ${entries?.length ?? 0} paths`),
    onCaptureFailed: (err: Error) => console.error('  [capture-failed]', err.message),
  },
})

const agentCwd = join(workspace, mirrorDirName(mount))

console.log(`\nMounting governed FS → ${agentCwd}\n`)

// Phase 1: materialize — governed files appear on disk
await engine.materialize()

console.log('Materialized files:')
await showTree(agentCwd)

// ── run the omp agent with NATIVE tools ────────────────────────────────

console.log('\nLaunching omp agent (deepseek-v4-flash) with full native tools...\n')

const agentOutput = await runOmp(
  agentCwd,
  'Read TASK.md and follow its instructions exactly. Create the files it asks for.',
  'deepseek/deepseek-v4-flash',
)

console.log('--- Agent output ---')
console.log(agentOutput.slice(0, 500))
console.log('---\n')

console.log('Files on disk after agent:')
await showTree(agentCwd)

// ── Phase 4: reconcile — capture disk changes into tuddofs ─────────────

console.log('\nReconciling disk → governed store ...')
await engine.reconcile()
await engine.settle()

// ── verify: files are now in the content-addressed store ───────────────

console.log('\n=== Verification ===\n')

const entries = await mountHandle.list('/')
console.log('Governed files:')
for (const e of entries) {
  console.log(`  ${e.kind === 'dir' ? '📁' : '📄'} ${e.path}`)
}

for (const p of ['/src/greeting.ts', '/README.md']) {
  try {
    const content = await mountHandle.read(p)
    const text = typeof content === 'string' ? content : content.toString('utf-8')
    console.log(`\n--- ${p} (from tuddofs governed store) ---`)
    console.log(text)
  } catch {
    console.log(`\n--- ${p}: not in governed store ---`)
  }
}

// Content-addressed store stats
const client = await pool.connect()
const blobs = await client.query<{ count: string }>('SELECT count(*)::text FROM tuddo_blobs')
const commits = await client.query<{ count: string }>('SELECT count(*)::text FROM tuddo_commits')
console.log(`\nCAS: ${blobs.rows[0]!.count} blobs, ${commits.rows[0]!.count} commits in Postgres`)
client.release()

// Cleanup
await rm(workspace, { recursive: true, force: true })
await pool.end()

console.log('\n✓ Agent worked through a mounted tuddofs filesystem — no custom tools.')

// ── helpers ────────────────────────────────────────────────────────────

async function showTree(dir: string, prefix = ''): Promise<void> {
  let items: string[]
  try {
    items = await readdir(dir)
  } catch {
    return
  }
  for (const name of items.sort()) {
    if (name.startsWith('.')) continue
    const full = join(dir, name)
    const s = await stat(full)
    if (s.isDirectory()) {
      console.log(`${prefix}📁 ${name}/`)
      await showTree(full, prefix + '  ')
    } else {
      const content = await readFile(full, 'utf-8')
      const preview = content.slice(0, 60).replace(/\n/g, ' ↵ ')
      console.log(`${prefix}📄 ${name} (${content.length}b) ${preview}...`)
    }
  }
}

function collectStdout(proc: ChildProcess): string {
  let out = ''
  proc.stdout?.on('data', (d: Buffer) => {
    out += d.toString('utf-8')
  })
  return out
}

function runOmp(cwd: string, prompt: string, model: string): Promise<string> {
  const { promise, resolve, reject } = Promise.withResolvers<string>()
  const proc = spawn('omp', ['-p', prompt, '--model', model, '--cwd', cwd, '--no-session'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    cwd,
  })
  const stdout = collectStdout(proc)
  let stderr = ''
  proc.stderr?.on('data', (d: Buffer) => {
    stderr += d.toString('utf-8')
  })
  proc.on('close', (code: number | null) => {
    if (code !== 0 && !stdout) reject(new Error(`omp exited ${code}: ${stderr}`))
    else resolve(stdout)
  })
  return promise
}
