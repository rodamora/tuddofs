import { createHash } from 'node:crypto'

import { InvalidCommitTimestampError, InvalidPathError, validatePath } from './validation.js'

/**
 * A regular file entry in a canonical tree.
 * @see spec §4.2
 */
export interface TreeEntry {
  readonly path: string
  readonly mode: number
  readonly blobSha: string
}

/**
 * Fields included in a canonical commit preimage.
 * @see spec §4.2
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
 * @see spec §4.2
 */
export function sha256(input: Uint8Array | string): string {
  return createHash('sha256').update(input).digest('hex')
}

/**
 * Serialize tree entries in the pinned UTF-8 byte order.
 * @see spec §4.2
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
 * @see spec §4.2
 */
export function hashTree(entries: readonly TreeEntry[]): string {
  return sha256(treePreimage(entries))
}

/**
 * Serialize a commit in the pinned field order and byte format.
 * @see spec §4.2
 */
export function commitPreimage(commit: CommitHashInput): Buffer {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(commit.ts)) {
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
 * @see spec §4.2
 */
export function hashCommit(commit: CommitHashInput): string {
  return sha256(commitPreimage(commit))
}
