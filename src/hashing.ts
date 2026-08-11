import { createHash } from 'node:crypto'

import { InvalidCommitTimestampError, InvalidPathError, validatePath } from './validation.js'

/**
 * A regular file entry in a canonical tree.
 */
export interface TreeEntry {
  readonly path: string
  readonly mode: number
  readonly blobSha: string
}

/**
 * Fields included in a canonical commit preimage.
 */
export interface CommitHashInput {
  readonly treeSha: string
  readonly parents: readonly string[]
  readonly authorUser: string
  readonly agentKind: string | null
  readonly threadId: string | null
  readonly runId: string | null
  readonly ts: string
  readonly op: string
}

/**
 * Hash bytes with SHA-256 and return lowercase hexadecimal.
 */
export function sha256(input: Uint8Array | string): string {
  return createHash('sha256').update(input).digest('hex')
}

/** The digest shape every CAS key, checksum header, and capture claim is measured against. */
export const CAS_SHA256 = /^[a-f0-9]{64}$/u

/**
 * The one place the content-addressed object key is spelled. Every write path —
 * inline overflow (§4.5), streamed quarantine promotion (§8.1), target-direct
 * capture upload (§8.2) — has to agree on it byte for byte or the CAS silently
 * forks into two namespaces.
 */
export function casObjectKey(tenant: string, sha256Hex: string): string {
  return `tuddo/${tenant}/${sha256Hex}`
}

/**
 * Serialize tree entries in the pinned UTF-8 byte order.
 */
export function treePreimage(entries: readonly TreeEntry[]): Buffer {
  const serialized = entries.map(entry => {
    const normalizedPath = validatePath(entry.path)
    if (normalizedPath !== entry.path) {
      throw new InvalidPathError(entry.path, 'must be NFC-normalized')
    }

    const pathBytes = Buffer.from(entry.path, 'utf8')
    const suffixBytes = Buffer.from(`\0${entry.mode}\0${entry.blobSha}\n`, 'utf8')
    const bytes = Buffer.concat([pathBytes, suffixBytes])
    return { pathBytes, bytes }
  })

  serialized.sort((left, right) => Buffer.compare(left.pathBytes, right.pathBytes))

  return Buffer.concat(serialized.map(entry => entry.bytes))
}

/**
 * Compute a content-addressed tree digest.
 */
export function hashTree(entries: readonly TreeEntry[]): string {
  return sha256(treePreimage(entries))
}

/**
 * Serialize a commit in the pinned field order and byte format.
 */
export function commitPreimage(commit: CommitHashInput): Buffer {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(commit.ts)) {
    throw new InvalidCommitTimestampError(commit.ts)
  }
  const parsedTimestamp = new Date(commit.ts)
  if (Number.isNaN(parsedTimestamp.getTime()) || parsedTimestamp.toISOString() !== commit.ts) {
    throw new InvalidCommitTimestampError(commit.ts)
  }

  let serialized = `tree\0${commit.treeSha}\n`
  for (const parent of commit.parents) {
    serialized += `parent\0${parent}\n`
  }
  serialized += `author\0${commit.authorUser}\0${commit.agentKind ?? ''}\0${commit.threadId ?? ''}\0${commit.runId ?? ''}\n`
  serialized += `ts\0${commit.ts}\n`
  serialized += `op\0${commit.op}\n`
  return Buffer.from(serialized, 'utf8')
}

/**
 * Compute a content-addressed commit digest.
 */
export function hashCommit(commit: CommitHashInput): string {
  return sha256(commitPreimage(commit))
}
