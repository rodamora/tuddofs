import './test-setup.js'

import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { commitPreimage, hashCommit, hashTree, sha256, treePreimage } from '../hashing.js'
import type { CommitHashInput, TreeEntry } from '../hashing.js'
import { InvalidCommitTimestampError, InvalidPathError } from '../validation.js'

type GoldenFixture = {
  blobs: Record<string, { content: string; sha: string }>
  trees: Array<{
    name: string
    entries: TreeEntry[]
    preimageBase64: string
    treeSha: string
  }>
  commits: Array<CommitHashInput & { name: string; preimageBase64: string; commitSha: string }>
}

const fixture = JSON.parse(
  readFileSync(new URL('../../fixtures/golden-hashes.json', import.meta.url), 'utf8'),
) as GoldenFixture

describe('sha256', () => {
  it('reproduces every blob digest in the golden fixture', () => {
    for (const vector of Object.values(fixture.blobs)) {
      assert.equal(sha256(Buffer.from(vector.content, 'utf8')), vector.sha)
    }
  })
})

describe('tree hashing', () => {
  for (const vector of fixture.trees) {
    it(`reproduces the ${vector.name} tree digest and preimage`, () => {
      const preimage = treePreimage(vector.entries)
      assert.equal(preimage.toString('base64'), vector.preimageBase64)
      assert.equal(hashTree(vector.entries), vector.treeSha)
    })
  }

  it('rejects non-NFC paths instead of hashing a silently normalized path', () => {
    assert.throws(
      () =>
        treePreimage([
          {
            path: '/cafe\u0301.md',
            mode: 0o100644,
            blobSha: 'a'.repeat(64),
          },
        ]),
      InvalidPathError,
    )
  })

  it('rejects invalid paths before hashing', () => {
    assert.throws(
      () =>
        treePreimage([
          {
            path: 'notes.md',
            mode: 0o100644,
            blobSha: 'a'.repeat(64),
          },
        ]),
      InvalidPathError,
    )
  })
})

describe('commit hashing', () => {
  for (const vector of fixture.commits) {
    it(`reproduces the ${vector.name} commit digest and preimage`, () => {
      const preimage = commitPreimage(vector)
      assert.equal(preimage.toString('base64'), vector.preimageBase64)
      assert.equal(hashCommit(vector), vector.commitSha)
    })
  }

  it('hashes null and empty optional attribution identically', () => {
    const base: CommitHashInput = {
      treeSha: fixture.trees[0].treeSha,
      parents: [],
      authorUser: 'user_1',
      agentKind: null,
      threadId: null,
      runId: null,
      ts: '2026-08-10T12:00:00.000Z',
      op: 'import',
    }
    const empty = { ...base, agentKind: '', threadId: '', runId: '' }

    assert.equal(hashCommit(base), hashCommit(empty))
  })

  it('rejects timestamps without UTC millisecond precision', () => {
    const base: CommitHashInput = {
      treeSha: fixture.trees[0].treeSha,
      parents: [],
      authorUser: 'user_1',
      agentKind: null,
      threadId: null,
      runId: null,
      ts: '2026-08-10T12:00:00.000Z',
      op: 'import',
    }
    assert.throws(() => commitPreimage({ ...base, ts: '2026-08-10T12:00:00Z' }), InvalidCommitTimestampError)
    assert.throws(() => commitPreimage({ ...base, ts: '2026-08-10T14:00:00.000+02:00' }), InvalidCommitTimestampError)
    assert.throws(() => commitPreimage({ ...base, ts: '2026-13-45T99:99:99.999Z' }), InvalidCommitTimestampError)
  })
  it('accepts valid UTC millisecond timestamps', () => {
    const commit: CommitHashInput = {
      treeSha: fixture.trees[0].treeSha,
      parents: [],
      authorUser: 'user_1',
      agentKind: null,
      threadId: null,
      runId: null,
      ts: '2026-08-10T12:00:00.123Z',
      op: 'import',
    }

    assert.doesNotThrow(() => commitPreimage(commit))
  })
})
