import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

import { StorageError } from '../errors.js'
import {
  SyncTargetError,
  buildCurlGetConfig,
  createLocalDirectoryTarget,
  createSyncEngine,
  sha256,
  type SessionFileSystem,
  type SyncTarget,
} from '../internal.js'

test('curl GET config round-trips hostile output paths and ampersand URLs', () => {
  const entries = [
    {
      url: 'https://store.example/object?X-Amz-Signature=deadbeef&part=1%2F2',
      output: '/workspace/project%3Adocs/quote"and\\slash\nline.md',
    },
    {
      url: 'https://store.example/object?name=a%26b&x=1',
      output: '/workspace/project%3Adocs/café-日本語.md',
    },
  ]

  assert.equal(
    buildCurlGetConfig(entries),
    'url = "https://store.example/object?X-Amz-Signature=deadbeef&part=1%2F2"\n' +
      'output = "/workspace/project%3Adocs/quote\\"and\\\\slash\\nline.md"\n' +
      'url = "https://store.example/object?name=a%26b&x=1"\n' +
      'output = "/workspace/project%3Adocs/café-日本語.md"\n',
  )
})

test('presigned hydration relays inline blobs and fetches object blobs on the target', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tuddofs-presigned-unit-'))
  const sourceDir = await mkdtemp(join(tmpdir(), 'tuddofs-presigned-source-'))
  try {
    const inlinePath = '/inline.txt'
    const objectPath = '/quote"and\\slash\nline%.txt'
    const inlineBytes = Buffer.from('inline bytes')
    const objectBytes = Buffer.from('object bytes')
    const objectSource = join(sourceDir, 'object.bin')
    await writeFile(objectSource, objectBytes)
    const reads: string[] = []
    const presigns: string[] = []
    const presignOptions: { method?: string; ttlSeconds?: number }[] = []
    const mount = {
      key: 'project:docs',
      virtual: false,
      pinned: false,
      write: 'direct' as const,
      async glob() {
        return [
          { path: inlinePath, sha256: sha256(inlineBytes), sizeBytes: BigInt(inlineBytes.length) },
          { path: objectPath, sha256: sha256(objectBytes), sizeBytes: BigInt(objectBytes.length) },
        ]
      },
      async readBytes(path: string) {
        reads.push(path)
        if (path === inlinePath) return inlineBytes
        throw new Error(`object blob was relayed: ${path}`)
      },
      async presign(path: string, options?: { method?: string; ttlSeconds?: number }) {
        presigns.push(path)
        presignOptions.push(options ?? {})
        if (path === inlinePath) throw new StorageError('Inline blobs do not have presigned URLs')
        return pathToFileURL(objectSource).href + '?X-Amz-Signature=deadbeef&part=1'
      },
    }
    const session = {
      async mounts() {
        return [mount]
      },
      mount() {
        return mount
      },
    } as unknown as SessionFileSystem
    const inner = createLocalDirectoryTarget({ root })
    const execs: { command: string; stdin?: Buffer }[] = []
    const target: SyncTarget = {
      async exec(command, options) {
        execs.push({ command, stdin: options?.stdin })
        return inner.exec(command, options)
      },
      readFile: path => inner.readFile(path),
      writeFile: (path, bytes) => inner.writeFile(path, bytes),
      mkdir: path => inner.mkdir(path),
    }
    const engine = createSyncEngine({
      session,
      target,
      root,
      largeBlobs: { transport: 'presigned', ttlSeconds: 321, uploadTimeoutMs: 12_345 },
    })

    await engine.materialize()

    assert.deepEqual(presigns, [inlinePath, objectPath])
    assert.deepEqual(presignOptions, [
      { method: 'GET', ttlSeconds: 321 },
      { method: 'GET', ttlSeconds: 321 },
    ])
    assert.equal(await readFile(engine.mirrorPath('project:docs', inlinePath), 'utf8'), inlineBytes.toString('utf8'))
    assert.equal(await readFile(engine.mirrorPath('project:docs', objectPath), 'utf8'), objectBytes.toString('utf8'))
    const curlExec = execs.find(entry => entry.command.includes('curl --parallel'))
    assert.ok(curlExec)
    assert.match(curlExec.command, /--config -/)
    assert.ok(!curlExec.command.includes('X-Amz-Signature=deadbeef'))
    assert.ok(curlExec.stdin)
    assert.match(curlExec.stdin.toString('utf8'), /quote\\"and\\\\slash\\nline%\.txt/)
    assert.match(curlExec.stdin.toString('utf8'), /X-Amz-Signature=deadbeef&part=1/)
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(sourceDir, { recursive: true, force: true })
  }
})

test('presign refusal without inline semantics fails acquire as StorageError', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tuddofs-presigned-refusal-'))
  try {
    const path = '/object.bin'
    const bytes = Buffer.from('object bytes')
    const mount = {
      key: 'project:docs',
      virtual: false,
      pinned: false,
      write: 'direct' as const,
      async glob() {
        return [{ path, sha256: sha256(bytes), sizeBytes: BigInt(bytes.length) }]
      },
      async readBytes() {
        throw new Error('unsupported presign must not fall back to relay')
      },
      async presign() {
        throw new StorageError('Object storage does not support GET presigning')
      },
    }
    const session = {
      async mounts() {
        return [mount]
      },
      mount() {
        return mount
      },
    } as unknown as SessionFileSystem
    const engine = createSyncEngine({
      session,
      target: createLocalDirectoryTarget({ root }),
      root,
      largeBlobs: { transport: 'presigned' },
    })

    await assert.rejects(
      engine.materialize(),
      error => error instanceof StorageError && /does not support GET presigning/.test(error.message),
    )
    await assert.rejects(readFile(join(root, '.tuddofs', 'hydrated')))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('failed presigned hydration leaves the marker absent and retries cleanly', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tuddofs-presigned-retry-'))
  const sourceDir = await mkdtemp(join(tmpdir(), 'tuddofs-presigned-retry-source-'))
  try {
    const path = '/object.bin'
    const bytes = Buffer.from('retry bytes')
    const source = join(sourceDir, 'object.bin')
    await writeFile(source, bytes)
    let reachable = false
    const mount = {
      key: 'project:docs',
      virtual: false,
      pinned: false,
      write: 'direct' as const,
      async glob() {
        return [{ path, sha256: sha256(bytes), sizeBytes: BigInt(bytes.length) }]
      },
      async readBytes() {
        throw new Error('failed direct hydration should not relay')
      },
      async presign() {
        return reachable ? pathToFileURL(source).href : pathToFileURL(join(sourceDir, 'missing')).href
      },
    }
    const session = {
      async mounts() {
        return [mount]
      },
      mount() {
        return mount
      },
    } as unknown as SessionFileSystem
    const target = createLocalDirectoryTarget({ root })
    const engine = createSyncEngine({ session, target, root, largeBlobs: { transport: 'presigned' } })

    await assert.rejects(engine.materialize(), error => error instanceof SyncTargetError && /presigned hydration failed/.test(error.message))
    await assert.rejects(readFile(join(root, '.tuddofs', 'hydrated')))

    reachable = true
    await engine.materialize()
    assert.deepEqual(await readFile(engine.mirrorPath('project:docs', path)), bytes)
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(sourceDir, { recursive: true, force: true })
  }
})
