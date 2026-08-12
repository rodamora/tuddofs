#!/usr/bin/env node
// Test launcher for every suite in the repository.
//
// Two reasons this exists rather than a bare `node --test`:
//
// 1. Node's built-in runner only expands glob patterns from Node 22 onward, and
//    it only discovers TypeScript files on versions that can strip types. This
//    package supports Node >= 20, so we collect the files ourselves and hand
//    the runner an explicit list, which every supported version understands.
// 2. Architecture §13.6: "No xfail/skip markers for known-broken invariants. CI
//    reports skips distinctly from passes." A skip inside a green run is
//    invisible in the spec reporter's tail, so every run is also written to a
//    TAP stream that is scanned for SKIP/TODO directives afterwards. Skips are
//    always reported loudly; with TUDDOFS_NO_SKIPS=1 — what CI sets on jobs
//    whose environment is fully provisioned — they fail the run.

import { spawn } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git'])

/**
 * Every suite, named by the npm script that runs it. `serial` marks suites that
 * share one database, one container, or one MinIO bucket.
 */
const SUITES = {
  unit: {
    roots: ['src'],
    matches: path => path.includes('/__tests__/') && path.endsWith('.test.ts'),
  },
  integration: {
    roots: ['src/integration'],
    matches: path => path.endsWith('.integration.test.ts'),
    serial: true,
    databaseUrl: true,
  },
  s3: {
    roots: ['packages/s3/test'],
    matches: path => path.endsWith('.test.ts'),
  },
  minio: {
    roots: ['scripts'],
    matches: path => path.startsWith('scripts/minio-') && path.endsWith('.test.ts'),
    serial: true,
    databaseUrl: true,
  },
  ssh: {
    roots: ['src/integration'],
    matches: path => path.endsWith('.ssh.test.ts'),
    serial: true,
    databaseUrl: true,
  },
}

/** Recursively collect files under `dir` whose repository-relative path satisfies `matches`. */
async function collect(dir, matches, found = []) {
  const entries = await readdir(dir, { withFileTypes: true })
  for (const entry of entries) {
    const absolute = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      await collect(absolute, matches, found)
    } else if (entry.isFile() && matches(relative(ROOT, absolute))) {
      found.push(absolute)
    }
  }
  return found
}

const name = process.argv[2] ?? 'unit'
const suite = SUITES[name]
if (!suite) {
  console.error(`Unknown suite "${name}". Known suites: ${Object.keys(SUITES).join(', ')}.`)
  process.exit(1)
}

const files = []
for (const root of suite.roots) files.push(...(await collect(join(ROOT, root), suite.matches)))
files.sort()

if (files.length === 0) {
  console.error(`No ${name} test files found.`)
  process.exit(1)
}

const reportDir = await mkdtemp(join(tmpdir(), `tuddofs-${name}-report-`))
const tapPath = join(reportDir, 'run.tap')

const args = [
  '--import',
  'tsx',
  // The spec stream is what a human reads; the TAP stream is what the skip gate
  // parses. Both reporters see the same run.
  '--test-reporter=spec',
  '--test-reporter-destination=stdout',
  '--test-reporter=tap',
  `--test-reporter-destination=${tapPath}`,
  '--test',
]
if (suite.serial) args.push('--test-concurrency=1')
args.push(...files)

const env = { ...process.env, NODE_ENV: 'test' }
if (suite.databaseUrl && !env.TUDDOFS_DATABASE_URL) {
  env.TUDDOFS_DATABASE_URL = 'postgresql://tuddofs:tuddofs@127.0.0.1:55434/tuddofs_it'
}

const child = spawn(process.execPath, args, { stdio: 'inherit', env })

child.on('exit', (code, signal) => {
  void (async () => {
    let skipped = []
    try {
      const tap = await readFile(tapPath, 'utf8')
      skipped = tap.split('\n').filter(line => /^\s*(?:not )?ok\b.*#\s*(?:skip|todo)\b/iu.test(line))
    } catch {
      // A run killed before the reporter flushed has no TAP to judge; the exit
      // status below is the verdict.
    } finally {
      await rm(reportDir, { recursive: true, force: true }).catch(() => undefined)
    }

    if (skipped.length > 0) {
      const strict = process.env.TUDDOFS_NO_SKIPS === '1'
      const headline = `${skipped.length} ${name} test(s) did not run (§13.6):`
      const detail = [headline, ...skipped.map(line => `  ${line.trim()}`)].join('\n')
      if (strict) {
        console.error(`\n${detail}\nTUDDOFS_NO_SKIPS=1 requires a skip-free run.`)
        process.exit(1)
      }
      console.warn(`\n${detail}\nSet the suite's environment to run them, or TUDDOFS_NO_SKIPS=1 to make this fatal.`)
    }

    if (signal) process.kill(process.pid, signal)
    else process.exit(code ?? 1)
  })()
})
