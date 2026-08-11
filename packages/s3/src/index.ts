import { Readable } from 'node:stream'

import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'

/** Structural BlobStore object metadata, matching the core SPI in §8.4. */
export interface BlobObject {
  readonly key: string
  readonly lastModified: Date | string
}

/** Structural five-verb BlobStore SPI plus its optional capabilities (§8.4). */
export interface ChecksumEnforcedPresignedPut {
  readonly checksumEnforced: true
  readonly url: string
  readonly headers: Readonly<Record<'x-amz-checksum-sha256', string>>
}

export interface BlobStore {
  put(key: string, bytes: Buffer | Readable): Promise<void>
  head(key: string): Promise<{ sizeBytes: number } | null>
  get(key: string): Promise<Readable>
  delete(key: string): Promise<void>
  list?(prefix: string): Promise<readonly BlobObject[]>
  presignPut?(key: string, opts: { ttlSeconds: number; checksumSha256: string }): Promise<ChecksumEnforcedPresignedPut>
  presignGet?(key: string, opts: { ttlSeconds: number }): Promise<string>
}

/** Configuration for an S3-compatible BlobStore adapter (§8.4). */
export interface S3BlobStoreOptions {
  readonly bucket: string
  readonly client?: S3Client
  readonly endpoint?: string
  readonly region?: string
  readonly forcePathStyle?: boolean
  readonly credentials?: S3ClientConfig['credentials']
}

/**
 * Typed failure raised when an S3 operation cannot satisfy the BlobStore SPI.
 * The original backend error remains available as `cause`.
 */
export class StorageError extends Error {
  readonly operation: StorageOperation
  readonly key: string
  readonly context: { readonly tenant: string; readonly mount?: string; readonly path?: string; readonly ref: string }
  readonly tenant = ''
  readonly mount?: string
  readonly path?: string
  readonly ref: string

  constructor(operation: StorageOperation, key: string, cause: unknown) {
    super(cause instanceof Error ? cause.message : 'Object storage failed', { cause })
    this.name = 'StorageError'
    this.operation = operation
    this.key = key
    this.context = { tenant: '', ref: key }
    this.ref = key
  }
}

export type StorageOperation = 'put' | 'head' | 'get' | 'delete' | 'list' | 'presignPut' | 'presignGet'

/** S3-compatible implementation of the structural BlobStore SPI (§8.4). */
export class S3BlobStore implements BlobStore {
  private readonly client: S3Client
  private readonly bucket: string
  private readonly ownsClient: boolean

  constructor(options: S3BlobStoreOptions) {
    if (!options.bucket) throw new TypeError('S3 bucket is required')
    this.bucket = options.bucket
    this.ownsClient = options.client === undefined
    this.client =
      options.client ??
      new S3Client({
        endpoint: options.endpoint,
        region: options.region ?? 'us-east-1',
        forcePathStyle: options.forcePathStyle ?? false,
        credentials: options.credentials,
      })
  }

  /** Release the internally-created AWS SDK client. */
  destroy(): void {
    if (this.ownsClient) this.client.destroy()
  }

  /** Upload bytes or a stream to an object key. */
  async put(key: string, bytes: Buffer | Readable): Promise<void> {
    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Body: bytes,
          ...(Buffer.isBuffer(bytes) && { ContentLength: bytes.length }),
        }),
      )
    } catch (error) {
      throw toStorageError('put', key, error)
    }
  }

  /** Return object size, or null when the object does not exist. */
  async head(key: string): Promise<{ sizeBytes: number } | null> {
    try {
      const response = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }))
      if (response.ContentLength === undefined) {
        throw new Error(`S3 response omitted ContentLength for ${key}`)
      }
      return { sizeBytes: response.ContentLength }
    } catch (error) {
      if (isNotFound(error)) return null
      throw toStorageError('head', key, error)
    }
  }

  /** Stream an object without buffering the complete body. */
  async get(key: string): Promise<Readable> {
    try {
      const response = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }))
      if (!response.Body) throw new Error(`S3 returned no body for ${key}`)
      if (response.Body instanceof Readable) return response.Body
      if (isAsyncIterable(response.Body)) return Readable.from(response.Body)
      if (isWebStream(response.Body)) {
        return Readable.fromWeb(response.Body as unknown as Parameters<typeof Readable.fromWeb>[0])
      }
      throw new Error(`S3 returned an unsupported body stream for ${key}`)
    } catch (error) {
      throw toStorageError('get', key, error)
    }
  }

  /** Delete an object; S3 deletion is idempotent. */
  async delete(key: string): Promise<void> {
    if (!key.startsWith('tuddo/')) throw new TypeError('refusing to delete an object outside the tuddo/ prefix')
    try {
      await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }))
    } catch (error) {
      throw toStorageError('delete', key, error)
    }
  }

  /** List every object under a prefix, following continuation tokens. */
  async list(prefix: string): Promise<readonly BlobObject[]> {
    try {
      const objects: BlobObject[] = []
      let continuationToken: string | undefined
      do {
        const response = await this.client.send(
          new ListObjectsV2Command({
            Bucket: this.bucket,
            Prefix: prefix,
            ContinuationToken: continuationToken,
          }),
        )
        for (const object of response.Contents ?? []) {
          if (object.Key && object.LastModified) {
            objects.push({ key: object.Key, lastModified: object.LastModified })
          }
        }
        continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined
      } while (continuationToken)
      return objects
    } catch (error) {
      throw toStorageError('list', prefix, error)
    }
  }

  /**
   * Issue a SigV4 PUT URL with x-amz-checksum-sha256 as a required signed
   * header, so the object store rejects bytes with a different checksum.
   */
  async presignPut(
    key: string,
    opts: { ttlSeconds: number; checksumSha256: string },
  ): Promise<ChecksumEnforcedPresignedPut> {
    const expiresIn = validateTtl(opts.ttlSeconds)
    try {
      const url = await getSignedUrl(
        this.client,
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          ChecksumSHA256: opts.checksumSha256,
        }),
        {
          expiresIn,
          unhoistableHeaders: new Set(['x-amz-checksum-sha256']),
        },
      )
      return {
        checksumEnforced: true,
        url,
        headers: { 'x-amz-checksum-sha256': opts.checksumSha256 },
      }
    } catch (error) {
      throw toStorageError('presignPut', key, error)
    }
  }
  /** Issue a SigV4 GET URL for an object. */
  async presignGet(key: string, opts: { ttlSeconds: number }): Promise<string> {
    const expiresIn = validateTtl(opts.ttlSeconds)
    try {
      return await getSignedUrl(this.client, new GetObjectCommand({ Bucket: this.bucket, Key: key }), {
        expiresIn,
      })
    } catch (error) {
      throw toStorageError('presignGet', key, error)
    }
  }
}

/** Construct an S3-compatible BlobStore without depending on core types (§8.4). */
export function createS3BlobStore(options: S3BlobStoreOptions): S3BlobStore {
  return new S3BlobStore(options)
}

function toStorageError(operation: StorageOperation, key: string, cause: unknown): StorageError {
  if (cause instanceof StorageError) return cause
  return new StorageError(operation, key, cause)
}

function validateTtl(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 604800) {
    throw new RangeError('presigned URL ttlSeconds must be an integer from 1 through 604800')
  }
  return value
}

function isNotFound(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const candidate = error as { name?: string; $metadata?: { httpStatusCode?: number } }
  return candidate.name === 'NotFound' || candidate.name === 'NoSuchKey' || candidate.$metadata?.httpStatusCode === 404
}

function isAsyncIterable(value: object): value is AsyncIterable<Uint8Array> {
  return Symbol.asyncIterator in value
}

function isWebStream(value: object): value is ReadableStream<Uint8Array> {
  return typeof ReadableStream !== 'undefined' && value instanceof ReadableStream
}
