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
 *
 * It also holds the other half of the documented contract that no compiler
 * sees on its own: the host guide's error-recovery table has to name every
 * error class the package exports, or a host switching on the class meets one
 * the document never mentioned.
 */
import assert from 'node:assert/strict'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import ts from 'typescript'

import * as publicApi from '../index.js'
import * as internalApi from '../internal.js'

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))))

/** Documents whose TypeScript blocks are part of the published contract. */
const DOCUMENTS = ['README.md', 'docs/host-guide.md', 'packages/s3/README.md'] as const

/**
 * No `paths` mapping, deliberately. The examples resolve `tuddofs`,
 * `tuddofs/internal`, and `@tuddo/s3` exactly the way a consumer does —
 * through each package's `exports` map, into the BUILT `.d.ts` files. A
 * mapping onto `src/*.ts` would compile every example against code no consumer
 * can import: it stays green when the exports map loses a subpath, and it
 * never sees a declaration the emitter widened or dropped.
 *
 * This requires `npm run build` first. The precondition test below says so out
 * loud rather than letting a stale `dist/` surface as "cannot find module".
 */
const COMPILER_OPTIONS: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.NodeNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
  strict: true,
  noEmit: true,
  skipLibCheck: true,
  esModuleInterop: true,
  types: ['node'],
}

/** A published subpath: the specifier a consumer writes, and the declaration it must land on. */
interface EntryPoint {
  readonly specifier: string
  readonly declaration: string
}

/** Every subpath `packageDir`'s manifest publishes, read from its `exports` map. */
async function publishedEntryPoints(packageDir: string): Promise<EntryPoint[]> {
  const manifest = JSON.parse(await readFile(join(ROOT, packageDir, 'package.json'), 'utf8')) as {
    name: string
    exports: Record<string, { types?: string }>
  }
  return Object.entries(manifest.exports).map(([subpath, target]) => {
    assert.ok(target.types, `${manifest.name} publishes ${subpath} without a "types" entry`)
    return {
      specifier: subpath === '.' ? manifest.name : `${manifest.name}/${subpath.replace(/^\.\//u, '')}`,
      declaration: resolve(ROOT, packageDir, target.types),
    }
  })
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

test('every published subpath resolves to a built declaration', async () => {
  const entryPoints = [...(await publishedEntryPoints('.')), ...(await publishedEntryPoints('packages/s3'))]
  assert.ok(entryPoints.length > 0, 'no published subpaths found; the drift gate would compile against nothing')
  for (const { specifier, declaration } of entryPoints) {
    assert.ok(
      ts.sys.fileExists(declaration),
      `${specifier} publishes ${declaration}, which does not exist — run \`npm run build\` before the docs gate`,
    )
    // Resolved the way a consumer resolves it: through the exports map, from a
    // file sitting where the examples above are compiled.
    const resolved = ts.resolveModuleName(specifier, join(ROOT, 'docs-example.ts'), COMPILER_OPTIONS, ts.sys)
    assert.equal(
      resolved.resolvedModule?.resolvedFileName,
      declaration,
      `${specifier} does not resolve to its published declaration`,
    )
  }
})

test('docs/host-guide.md error table covers every exported error class', async () => {
  const markdown = await readFile(join(ROOT, 'docs/host-guide.md'), 'utf8')
  const section = /\n## Error taxonomy and recovery\n([\s\S]*?)\n## /u.exec(markdown)?.[1]
  assert.ok(section, 'docs/host-guide.md no longer has an "Error taxonomy and recovery" section')
  const documented = [...section.matchAll(/^\|\s*`([A-Za-z]+Error)`/gmu)].map(match => match[1]).sort()
  // Both surfaces a host catches from: the Tier-1 classes, plus the internal
  // subpath's `SyncTargetError` for anyone running the engine.
  const exported = [...new Set([...Object.keys(publicApi), ...Object.keys(internalApi)])]
    .filter(name => name.endsWith('Error'))
    .sort()
  assert.deepEqual(documented, exported, 'the error-recovery table and the exported error classes have drifted')
})
