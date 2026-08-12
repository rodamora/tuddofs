#!/usr/bin/env node
// Clean-container docs proof (task s4-hardening acceptance).
//
// The claim under test: a consumer who has never seen this repository can go
// from zero to governed writes and scheduled maintenance using only README.md
// and docs/host-guide.md. So this script trusts nothing from the checkout
// except the packed tarball and the two documents:
//
//   1. `npm pack` the package exactly as it would be published.
//   2. Start a scratch PostgreSQL and a scratch node:22-alpine container on a
//      private network — no host mounts, no repository, no node_modules.
//   3. Copy in the tarball plus the two programs the documents hand out
//      VERBATIM: the README quickstart heredoc and the host guide's
//      maintenance job heredoc.
//   4. `npm init` + `npm install <tarball> pg`, then run both and check what
//      they print.
//
// Any drift between the documents and the published artifact fails here, which
// is the one place it can be caught before a consumer hits it.

import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const NODE_IMAGE = process.env.TUDDOFS_QUICKSTART_NODE_IMAGE ?? 'node:22-alpine'
const POSTGRES_IMAGE = process.env.TUDDOFS_QUICKSTART_POSTGRES_IMAGE ?? 'postgres:16-alpine'
const suffix = randomUUID().slice(0, 8)
const NETWORK = `tuddofs-quickstart-${suffix}`
const POSTGRES = `tuddofs-quickstart-db-${suffix}`
const CONSUMER = `tuddofs-quickstart-app-${suffix}`
const DATABASE_URL = `postgresql://tuddofs:tuddofs@${POSTGRES}:5432/tuddofs_it`

/** Run a command to completion, returning its output and failing loudly on a non-zero exit. */
async function run(binary, args, { cwd = ROOT, allowFailure = false } = {}) {
  return await new Promise((resolve, reject) => {
    const child = spawn(binary, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => (stdout += chunk))
    child.stderr.on('data', chunk => (stderr += chunk))
    child.once('error', reject)
    child.once('close', code => {
      if (code === 0 || allowFailure) resolve({ code, stdout, stderr })
      else reject(new Error(`${binary} ${args.join(' ')} exited ${code}\n${stdout}\n${stderr}`))
    })
  })
}

/** The body of a `cat > <file> <<'EOF' … EOF` heredoc, exactly as the document prints it. */
async function heredoc(document, filename) {
  const markdown = await readFile(join(ROOT, document), 'utf8')
  const pattern = new RegExp(`cat > ${filename.replace(/\./gu, '\\.')} <<'EOF'\\n([\\s\\S]*?)\\nEOF`, 'u')
  const match = pattern.exec(markdown)
  if (!match?.[1]) throw new Error(`${document} no longer contains a runnable ${filename} block`)
  return match[1]
}

async function main() {
  const scratch = await mkdtemp(join(tmpdir(), 'tuddofs-quickstart-'))
  let started = false
  try {
    console.log('· building and packing the package')
    await run('npm', ['run', 'build:core'])
    const packed = JSON.parse((await run('npm', ['pack', '--json', '--pack-destination', scratch])).stdout)
    const tarball = join(scratch, packed[0].filename)
    console.log(`  packed ${packed[0].filename} (${packed[0].files.length} files)`)

    console.log('· extracting the documented programs')
    const demo = await heredoc('README.md', 'demo.mjs')
    const maintenance = await heredoc('docs/host-guide.md', 'tuddofs-maintenance.mjs')
    await writeFile(join(scratch, 'demo.mjs'), `${demo}\n`)
    await writeFile(join(scratch, 'tuddofs-maintenance.mjs'), `${maintenance}\n`)

    console.log('· starting a scratch database and a scratch consumer container')
    await run('docker', ['network', 'create', NETWORK])
    started = true
    await run('docker', [
      'run',
      '--detach',
      '--name',
      POSTGRES,
      '--network',
      NETWORK,
      '--env',
      'POSTGRES_USER=tuddofs',
      '--env',
      'POSTGRES_PASSWORD=tuddofs',
      '--env',
      'POSTGRES_DB=tuddofs_it',
      POSTGRES_IMAGE,
    ])
    for (let attempt = 0; ; attempt += 1) {
      const ready = await run('docker', ['exec', POSTGRES, 'pg_isready', '-U', 'tuddofs', '-d', 'tuddofs_it'], {
        allowFailure: true,
      })
      if (ready.code === 0) break
      if (attempt >= 60) throw new Error('PostgreSQL never became ready')
      await new Promise(resolve => setTimeout(resolve, 1000))
    }
    await run('docker', [
      'run',
      '--detach',
      '--name',
      CONSUMER,
      '--network',
      NETWORK,
      '--workdir',
      '/app',
      NODE_IMAGE,
      'sleep',
      '900',
    ])

    console.log('· installing the packed package in an empty project')
    await run('docker', ['exec', CONSUMER, 'mkdir', '-p', '/app'])
    await run('docker', ['cp', tarball, `${CONSUMER}:/tmp/tuddofs.tgz`])
    await run('docker', ['cp', join(scratch, 'demo.mjs'), `${CONSUMER}:/app/demo.mjs`])
    await run('docker', ['cp', join(scratch, 'tuddofs-maintenance.mjs'), `${CONSUMER}:/app/tuddofs-maintenance.mjs`])
    await run('docker', ['exec', '--workdir', '/app', CONSUMER, 'npm', 'init', '--yes'])
    await run('docker', ['exec', '--workdir', '/app', CONSUMER, 'npm', 'install', '/tmp/tuddofs.tgz', 'pg'])

    console.log('· running the README quickstart')
    const quickstart = await run('docker', [
      'exec',
      '--workdir',
      '/app',
      '--env',
      `TUDDOFS_DATABASE_URL=${DATABASE_URL}`,
      CONSUMER,
      'node',
      'demo.mjs',
    ])
    if (quickstart.stdout.trim() !== 'Ship safely.') {
      throw new Error(`README quickstart printed ${JSON.stringify(quickstart.stdout)}`)
    }
    console.log(`  quickstart printed: ${quickstart.stdout.trim()}`)

    console.log('· running the host-guide maintenance job')
    const job = await run('docker', [
      'exec',
      '--workdir',
      '/app',
      '--env',
      `TUDDOFS_DATABASE_URL=${DATABASE_URL}`,
      CONSUMER,
      'node',
      'tuddofs-maintenance.mjs',
    ])
    const summary = JSON.parse(job.stdout.trim())
    if (summary.verifyOk !== true || summary.findings !== 0) {
      throw new Error(`maintenance job reported ${job.stdout.trim()}`)
    }
    console.log(`  maintenance printed: ${job.stdout.trim()}`)

    console.log('\nPASS: README + host guide take a clean container from zero to governed writes and scheduled GC/verify.')
  } finally {
    if (started) {
      await run('docker', ['rm', '--force', CONSUMER], { allowFailure: true })
      await run('docker', ['rm', '--force', POSTGRES], { allowFailure: true })
      await run('docker', ['network', 'rm', NETWORK], { allowFailure: true })
    }
    await rm(scratch, { recursive: true, force: true })
  }
}

await main()
