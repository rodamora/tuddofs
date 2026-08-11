import assert from 'node:assert/strict'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import ts from 'typescript'

async function compileReadmeBlock(marker: RegExp, filename: string): Promise<void> {
  const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))))
  const readme = await readFile(join(root, 'README.md'), 'utf8')
  const match = marker.exec(readme)
  assert.ok(match?.[1], `README block for ${marker.source} is missing`)

  const sourcePath = join(root, filename)
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
      paths: { tuddofs: ['./src/index.ts'], 'tuddofs/internal': ['./src/internal.ts'] },
    })
    const diagnostics = ts
      .getPreEmitDiagnostics(program)
      .map(diagnostic => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'))
    assert.deepEqual(diagnostics, [])
  } finally {
    await rm(sourcePath, { force: true })
  }
}

test('README TypeScript quickstart compiles against the public entry', async () => {
  await compileReadmeBlock(/For an application[\s\S]*?```ts\n([\s\S]*?)\n```/u, '.readme-quickstart.ts')
})

test('README sync-engine example compiles against the internal entry', async () => {
  await compileReadmeBlock(/## Sync engine[\s\S]*?```ts\n([\s\S]*?)\n```/u, '.readme-sync.ts')
})

test('README SSH target example compiles against the internal entry', async () => {
  await compileReadmeBlock(/### SSH target[\s\S]*?```ts\n([\s\S]*?)\n```/u, '.readme-ssh.ts')
})

test('README large-blob capture example compiles against the internal entry', async () => {
  await compileReadmeBlock(/### Large blobs in capture[\s\S]*?```ts\n([\s\S]*?)\n```/u, '.readme-large-blobs.ts')
})
