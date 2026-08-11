import type { Readable } from 'node:stream'

import type { BlobStore } from '../kernel.js'

type BufferOnlyStore = {
  put(key: string, bytes: Buffer): Promise<void>
  head(key: string): Promise<{ sizeBytes: number } | null>
  get(key: string): Promise<Readable>
  delete(key: string): Promise<void>
}

declare const bufferOnlyStore: BufferOnlyStore

// A BlobStore receives streams from writeStream, so buffer-only adapters are unsafe.
// @ts-expect-error Buffer-only put implementations must not satisfy the streaming SPI.
const store: BlobStore = bufferOnlyStore
void store
