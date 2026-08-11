import assert from 'node:assert/strict'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import ts from 'typescript'

test('README TypeScript quickstart compiles against the public entry', async () => {
  const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))))
  const readme = await readFile(join(root, 'README.md'), 'utf8')
  const match = /For an application[\s\S]*?```ts\n([\s\S]*?)\n```/u.exec(readme)
  assert.ok(match?.[1], 'README application quickstart block is missing')

  const sourcePath = join(root, '.readme-quickstart.ts')
  await writeFile(sourcePath, match[1])
  try {
    const program = ts.createProgram([sourcePath], {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      strict: true,
      noEmit: true,
      skipLibCheck: true,
      esModuleInterop: true,
      types: ['node'],
      baseUrl: root,
      paths: { tuddofs: ['./src/index.ts'] },
    })
    const diagnostics = ts
      .getPreEmitDiagnostics(program)
      .map(diagnostic => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'))
    assert.deepEqual(diagnostics, [])
  } finally {
    await rm(sourcePath, { force: true })
  }
})
