import assert from 'node:assert/strict'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

test('README JavaScript quickstart runs against PostgreSQL', async () => {
  const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))))
  const readme = await readFile(join(root, 'README.md'), 'utf8')
  const match = /cat > demo\.mjs <<'EOF'\n([\s\S]*?)\nEOF/u.exec(readme)
  assert.ok(match?.[1], 'README runnable quickstart block is missing')

  const entryUrl = pathToFileURL(join(root, 'src/index.ts')).href
  const source = match[1].replace("from 'tuddofs'", `from '${entryUrl}'`)
  const sourcePath = join(root, `.readme-quickstart-${process.pid}.mjs`)
  const output: unknown[][] = []
  const originalLog = console.log
  console.log = (...args: unknown[]) => {
    output.push(args)
  }
  try {
    await writeFile(sourcePath, source)
    // The module is generated from the README at runtime, so it cannot be statically imported.
    await import(`${pathToFileURL(sourcePath).href}?run=${Date.now()}`)
  } finally {
    console.log = originalLog
    await rm(sourcePath, { force: true })
  }

  assert.deepEqual(output, [['Ship safely.\n']])
})
