import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import test, { after, afterEach, before, describe } from 'node:test'

/** The required BlobStore surface exercised by the reusable conformance suite. */
export interface ConformanceBlobStore {
  put(key: string, bytes: Buffer): Promise<void>
  head(key: string): Promise<{ sizeBytes: number } | null>
  get(key: string): Promise<Readable>
  delete(key: string): Promise<void>
  list(prefix: string): Promise<readonly { key: string }[]>
  presignPut(key: string, opts: { ttlSeconds: number; checksumSha256: string }): Promise<string>
  presignGet(key: string, opts: { ttlSeconds: number }): Promise<string>
}

export interface ConformanceStoreFixture {
  readonly store: ConformanceBlobStore
  readonly close?: () => void | Promise<void>
}

export interface BlobStoreConformanceOptions {
  readonly createStore: () => ConformanceStoreFixture | Promise<ConformanceStoreFixture>
  readonly prefix: string
  readonly name?: string
}

/** Register the store-agnostic conformance suite for a BlobStore implementation. */
export function defineBlobStoreConformanceSuite(options: BlobStoreConformanceOptions): void {
  void describe(options.name ?? 'BlobStore SPI conformance', () => {
    let fixture: ConformanceStoreFixture | undefined

    before(async () => {
      fixture = await options.createStore()
    })

    afterEach(async () => {
      if (!fixture) return
      const store = fixture.store
      const objects = await store.list(options.prefix)
      await Promise.all(objects.map(object => store.delete(object.key)))
    })

    after(async () => {
      const close = fixture?.close
      if (close) await close()
    })

    void test('implements put, head, get, and delete', async () => {
      const store = requireStore(fixture)
      const key = `${options.prefix}round-trip`
      const bytes = Buffer.from('adapter conformance')

      await store.put(key, bytes)
      assert.deepEqual(await store.head(key), { sizeBytes: bytes.length })
      assert.deepEqual(await collect(await store.get(key)), bytes)

      await store.delete(key)
      assert.equal(await store.head(key), null)
    })

    void test('isolates keys and filters list results by prefix', async () => {
      const store = requireStore(fixture)
      const alphaKey = `${options.prefix}alpha/one`
      const alphaOtherKey = `${options.prefix}alpha/two`
      const betaKey = `${options.prefix}beta/one`

      await store.put(alphaKey, Buffer.from('alpha one'))
      await store.put(alphaOtherKey, Buffer.from('alpha two'))
      await store.put(betaKey, Buffer.from('beta one'))

      assert.deepEqual((await store.list(`${options.prefix}alpha/`)).map(object => object.key).sort(), [
        alphaKey,
        alphaOtherKey,
      ])
      assert.deepEqual((await store.list(options.prefix)).map(object => object.key).sort(), [
        alphaKey,
        alphaOtherKey,
        betaKey,
      ])
      assert.deepEqual(await collect(await store.get(betaKey)), Buffer.from('beta one'))
    })

    void test('reports missing keys through head and get', async () => {
      const store = requireStore(fixture)
      const key = `${options.prefix}does-not-exist`

      assert.equal(await store.head(key), null)
      await assert.rejects(() => store.get(key))
    })
    void test('issues presigned PUT and GET URLs', async () => {
      const store = requireStore(fixture)
      const putUrl = await store.presignPut(`${options.prefix}presigned-put`, {
        ttlSeconds: 300,
        checksumSha256: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
      })
      const getUrl = await store.presignGet(`${options.prefix}presigned-get`, { ttlSeconds: 300 })

      assert.ok(putUrl)
      assert.ok(getUrl)
    })
  })
}

function requireFixture(fixture: ConformanceStoreFixture | undefined): ConformanceStoreFixture {
  assert.ok(fixture, 'BlobStore fixture was not initialized')
  return fixture
}

function requireStore(fixture: ConformanceStoreFixture | undefined): ConformanceBlobStore {
  return requireFixture(fixture).store
}

async function collect(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Uint8Array))
  return Buffer.concat(chunks)
}
