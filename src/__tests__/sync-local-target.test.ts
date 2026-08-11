import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { after } from 'node:test'

import { createLocalDirectoryTarget } from '../sync/local.js'
import { InvalidPathError } from '../internal.js'

const roots: string[] = []

async function freshRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'tuddofs-local-'))
  roots.push(root)
  return root
}

after(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true })
})

test('the local target creates its own root and writes, reads, and lists real files', async () => {
  const root = join(await freshRoot(), 'nested', 'workspace')
  const target = createLocalDirectoryTarget({ root })

  await target.mkdir(join(root, 'mnt', 'deep'))
  await target.writeFile(join(root, 'mnt', 'deep', 'a.md'), Buffer.from('hello'))

  assert.equal((await target.readFile(join(root, 'mnt', 'deep', 'a.md'))).toString(), 'hello')
  assert.equal(await readFile(join(root, 'mnt', 'deep', 'a.md'), 'utf8'), 'hello')
  assert.equal(target.root, root)
})

test('the local target resolves relative paths against the root and refuses escapes', async () => {
  const root = await freshRoot()
  const target = createLocalDirectoryTarget({ root })
  await target.mkdir('mnt')
  await target.writeFile('mnt/a.md', Buffer.from('relative'))

  assert.equal((await target.readFile('mnt/a.md')).toString(), 'relative')
  await assert.rejects(target.readFile('../outside.md'), InvalidPathError)
  await assert.rejects(target.readFile('/etc/hostname'), InvalidPathError)
  await assert.rejects(target.writeFile('../outside.md', Buffer.from('x')), InvalidPathError)
  await assert.rejects(target.mkdir('../outside'), InvalidPathError)
  await assert.rejects(target.readFile('.'), InvalidPathError)
})

test('the local target never follows a symlink out of the workspace', async () => {
  const root = await freshRoot()
  const outside = join(root, '..', `outside-${process.pid}.txt`)
  await writeFile(outside, 'host secret')
  roots.push(outside)
  const target = createLocalDirectoryTarget({ root })
  await target.mkdir('mnt')
  await symlink(outside, join(root, 'mnt', 'leak.md'))
  await symlink(join(root, '..'), join(root, 'mnt', 'up'))

  await assert.rejects(target.readFile('mnt/leak.md'), InvalidPathError)
  await assert.rejects(target.readFile(`mnt/up/outside-${process.pid}.txt`), InvalidPathError)
  await assert.rejects(target.writeFile('mnt/leak.md', Buffer.from('overwrite')), InvalidPathError)
  assert.equal(await readFile(outside, 'utf8'), 'host secret')
})

test('exec runs a shell command in the root and reports combined output', async () => {
  const root = await freshRoot()
  const target = createLocalDirectoryTarget({ root })
  await target.mkdir('mnt')

  const result = await target.exec("printf out; printf err >&2; ls mnt >/dev/null; echo ' done'")
  assert.equal(result.exitCode, 0)
  assert.ok(result.output.includes('out'))
  assert.ok(result.output.includes('err'))

  const failed = await target.exec('exit 3')
  assert.equal(failed.exitCode, 3)
})

test('an exec killed mid-run reports the signal and keeps the output it produced', async () => {
  const root = await freshRoot()
  const target = createLocalDirectoryTarget({ root })

  const killed = await target.exec('echo alive; kill -9 $$; echo dead')
  assert.equal(killed.exitCode, 137)
  assert.ok(killed.output.includes('alive'))
  assert.ok(!killed.output.includes('dead'))
})

test('an exec that exceeds its timeout kills the whole command group', async () => {
  const root = await freshRoot()
  const target = createLocalDirectoryTarget({ root, execTimeoutMs: 50 })

  const startedAt = Date.now()
  const timedOut = await target.exec('echo start; sleep 30')
  assert.equal(timedOut.exitCode, 137)
  assert.ok(timedOut.output.includes('start'))
  // A timeout that only kills the shell leaves `sleep` holding the stdio pipes
  // and the exec settles 30s late instead of 50ms late.
  assert.ok(Date.now() - startedAt < 5_000, `exec settled after ${Date.now() - startedAt}ms`)
})
test('the GNU coreutils probe and the capture chain run against a real directory', async () => {
  const root = await freshRoot()
  const target = createLocalDirectoryTarget({ root })
  await target.mkdir('mnt')
  await target.mkdir('.tuddofs')
  await target.writeFile('mnt/plain.md', Buffer.from('one'))
  await target.writeFile('mnt/weird name\nwith newline.md', Buffer.from('two'))

  assert.equal((await target.exec('sha256sum --version && find --version')).exitCode, 0)
  const scan = await target.exec(
    "cd '" +
      root +
      "' && find 'mnt' -type f -print0 > '.tuddofs/scan' && xargs -0 -r sha256sum --zero < '.tuddofs/scan'",
  )
  assert.equal(scan.exitCode, 0)
  const names = scan.output
    .split('\0')
    .filter(Boolean)
    .map(entry => entry.slice(66))
    .sort()
  assert.deepEqual(names, ['mnt/plain.md', 'mnt/weird name\nwith newline.md'])
})
