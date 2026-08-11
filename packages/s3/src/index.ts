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
export interface BlobStore {
  put(key: string, bytes: Buffer): Promise<void>
  head(key: string): Promise<{ sizeBytes: number } | null>
  get(key: string): Promise<Readable>
  delete(key: string): Promise<void>
  list?(prefix: string): Promise<readonly BlobObject[]>
  presignPut?(key: string, opts: { ttlSeconds: number; checksumSha256: string }): Promise<string>
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
 * S3-compatible implementation of the structural BlobStore SPI (§8.4).
 *
 * The adapter accepts AWS S3, MinIO, and Cloudflare R2 endpoints. It does not
 * import or peer-depend on the tuddofs core package.
 */
export class S3BlobStore implements BlobStore {
  private readonly client: S3Client
  private readonly bucket: string

  constructor(options: S3BlobStoreOptions) {
    if (!options.bucket) throw new TypeError('S3 bucket is required')
    this.bucket = options.bucket
    this.client =
      options.client ??
      new S3Client({
        endpoint: options.endpoint,
        region: options.region ?? 'us-east-1',
        forcePathStyle: options.forcePathStyle ?? false,
        credentials: options.credentials,
      })
  }

  /** Upload bytes to an object key. */
  async put(key: string, bytes: Buffer): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: bytes,
        ContentLength: bytes.length,
      }),
    )
  }

  /** Return object size, or null when the object does not exist. */
  async head(key: string): Promise<{ sizeBytes: number } | null> {
    try {
      const response = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }))
      return response.ContentLength === undefined ? { sizeBytes: 0 } : { sizeBytes: response.ContentLength }
    } catch (error) {
      if (isNotFound(error)) return null
      throw error
    }
  }

  /** Stream an object without buffering the complete body. */
  async get(key: string): Promise<Readable> {
    const response = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }))
    if (!response.Body) throw new Error(`S3 returned no body for ${key}`)
    if (response.Body instanceof Readable) return response.Body
    if (isAsyncIterable(response.Body)) return Readable.from(response.Body)
    if (isWebStream(response.Body)) {
      return Readable.fromWeb(response.Body as unknown as Parameters<typeof Readable.fromWeb>[0])
    }
    throw new Error(`S3 returned an unsupported body stream for ${key}`)
  }

  /** Delete an object; S3 deletion is idempotent. */
  async delete(key: string): Promise<void> {
    if (!key.startsWith('tuddo/')) throw new TypeError('refusing to delete an object outside the tuddo/ prefix')
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }))
  }

  /** List every object under a prefix, following continuation tokens. */
  async list(prefix: string): Promise<readonly BlobObject[]> {
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
  }

  /**
   * Issue a SigV4 PUT URL with x-amz-checksum-sha256 as a required signed
   * header, so the object store rejects bytes with a different checksum.
   */
  async presignPut(key: string, opts: { ttlSeconds: number; checksumSha256: string }): Promise<string> {
    const expiresIn = validateTtl(opts.ttlSeconds)
    return getSignedUrl(
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
  }

  /** Issue a SigV4 GET URL for an object. */
  async presignGet(key: string, opts: { ttlSeconds: number }): Promise<string> {
    return getSignedUrl(this.client, new GetObjectCommand({ Bucket: this.bucket, Key: key }), {
      expiresIn: validateTtl(opts.ttlSeconds),
    })
  }
}

/** Construct an S3-compatible BlobStore without depending on core types (§8.4). */
export function createS3BlobStore(options: S3BlobStoreOptions): S3BlobStore {
  return new S3BlobStore(options)
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
