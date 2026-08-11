#!/usr/bin/env node
// Test launcher.
//
// Node's built-in runner only expands glob patterns from Node 22 onward, and it
// only discovers TypeScript files on versions that can strip types. This package
// supports Node >= 20, so we collect the files ourselves and hand the runner an
// explicit list, which every supported version understands.

import { spawn } from 'node:child_process'
import { readdir } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git'])

/** Recursively collect files under `dir` whose relative path satisfies `matches`. */
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

const suite = process.argv[2] === 'integration' ? 'integration' : 'unit'

const matches =
  suite === 'integration'
    ? (path) => path.startsWith(`src/integration/`) && path.endsWith('.integration.test.ts')
    : (path) => path.includes(`/__tests__/`) && path.endsWith('.test.ts')

const files = (await collect(join(ROOT, 'src'), matches)).sort()

if (files.length === 0) {
  console.error(`No ${suite} test files found.`)
  process.exit(1)
}

const args = ['--import', 'tsx', '--test']
// Integration tests share one database, so they must not run in parallel.
if (suite === 'integration') args.push('--test-concurrency=1')
args.push(...files)

const env = { ...process.env, NODE_ENV: 'test' }
if (suite === 'integration' && !env.TUDDOFS_DATABASE_URL) {
  env.TUDDOFS_DATABASE_URL = 'postgresql://tuddofs:tuddofs@127.0.0.1:55434/tuddofs_it'
}

const child = spawn(process.execPath, args, { stdio: 'inherit', env })
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal)
  else process.exit(code ?? 1)
})
