/**
 * README ↔ `.d.ts` drift gate (architecture §10 rule 4, §13.7).
 *
 * "Docs are part of the contract" is only true if something checks. Every
 * TypeScript block in every consumer-facing document is compiled against the
 * shipped entry points, so a renamed export, a changed option, or a removed
 * method fails here in the same PR that caused it — instead of failing for the
 * first consumer who copies the example.
 *
 * The gate is intentionally indiscriminate: it discovers blocks rather than
 * naming them, so a new example cannot be added outside it.
 */
import assert from 'node:assert/strict'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import ts from 'typescript'

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))))

/** Documents whose TypeScript blocks are part of the published contract. */
const DOCUMENTS = ['README.md', 'docs/host-guide.md', 'packages/s3/README.md'] as const

const COMPILER_OPTIONS: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.NodeNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
  strict: true,
  noEmit: true,
  skipLibCheck: true,
  esModuleInterop: true,
  types: ['node'],
  baseUrl: ROOT,
  paths: {
    tuddofs: ['./src/index.ts'],
    'tuddofs/internal': ['./src/internal.ts'],
    '@tuddofs/s3': ['./packages/s3/src/index.ts'],
    '@tuddofs/s3/conformance': ['./packages/s3/src/conformance.ts'],
  },
}

interface DocBlock {
  readonly document: string
  /** 1-based line of the opening fence, so a failure names a place to edit. */
  readonly line: number
  readonly code: string
}

/** Every ```ts fenced block in `markdown`, in document order. */
function typescriptBlocks(document: string, markdown: string): DocBlock[] {
  const blocks: DocBlock[] = []
  const lines = markdown.split('\n')
  for (let index = 0; index < lines.length; index += 1) {
    if (!/^```ts\s*$/u.test(lines[index] ?? '')) continue
    const start = index + 1
    let end = start
    while (end < lines.length && lines[end] !== '```') end += 1
    assert.ok(end < lines.length, `${document}: unterminated \`\`\`ts block opened at line ${index + 1}`)
    blocks.push({ document, line: index + 1, code: lines.slice(start, end).join('\n') })
    index = end
  }
  return blocks
}

async function compile(block: DocBlock, filename: string): Promise<void> {
  const sourcePath = join(ROOT, filename)
  await writeFile(sourcePath, `${block.code}\n`)
  try {
    const program = ts.createProgram([sourcePath], COMPILER_OPTIONS)
    const diagnostics = ts.getPreEmitDiagnostics(program).map(diagnostic => {
      const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')
      if (diagnostic.file === undefined || diagnostic.start === undefined) return message
      const at = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start)
      return `${block.document}:${block.line + 1 + at.line}: ${message}`
    })
    assert.deepEqual(diagnostics, [], `${block.document} block at line ${block.line} does not compile`)
  } finally {
    await rm(sourcePath, { force: true })
  }
}

for (const document of DOCUMENTS) {
  const markdown = await readFile(join(ROOT, document), 'utf8')
  const blocks = typescriptBlocks(document, markdown)

  test(`${document} declares TypeScript examples`, () => {
    assert.ok(blocks.length > 0, `${document} has no \`\`\`ts blocks; the drift gate would be vacuous`)
  })

  for (const [index, block] of blocks.entries()) {
    test(`${document} line ${block.line} example compiles against the published surface`, async () => {
      await compile(block, `.docs-example-${document.replace(/[^a-z0-9]+/giu, '-')}-${index}.ts`)
    })
  }
}
