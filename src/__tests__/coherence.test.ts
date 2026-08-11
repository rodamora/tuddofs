import assert from 'node:assert/strict'
import test from 'node:test'

import * as validation from '../validation.js'

type TreeCoherenceCollision = {
  readonly path: string
  readonly collidingPath: string
}

type CoherenceValidation = {
  findPathCollision?: (path: string, paths: ReadonlySet<string>) => string | undefined
  findTreeCoherenceCollisions?: (paths: Iterable<string>) => readonly TreeCoherenceCollision[]
}

const coherence = validation as CoherenceValidation

test('tree coherence detects every ancestor-descendant collision', () => {
  const collisions = coherence.findTreeCoherenceCollisions?.(['/a/x/y.md', '/safe.md', '/a', '/a/x']) ?? []

  assert.deepEqual(collisions, [
    { path: '/a', collidingPath: '/a/x' },
    { path: '/a', collidingPath: '/a/x/y.md' },
    { path: '/a/x', collidingPath: '/a/x/y.md' },
  ])
})

test('write collision lookup names the existing colliding entry in either direction', () => {
  assert.equal(coherence.findPathCollision?.('/a/x.md', new Set(['/a'])), '/a')
  assert.equal(coherence.findPathCollision?.('/a', new Set(['/a/x.md'])), '/a/x.md')
  assert.equal(coherence.findPathCollision?.('/a', new Set(['/ab/x.md'])), undefined)
})
