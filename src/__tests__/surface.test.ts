import assert from 'node:assert/strict'
import test from 'node:test'

import * as publicApi from '../index.js'
import { EditMatchError, createTuddoFs } from '../index.js'
import type { DeleteResult, RestoreResult, WriteResult } from '../index.js'
import { InvalidPathError } from '../internal.js'

const TIER_ONE_EXPORTS = [
  'BranchSettledError',
  'EditMatchError',
  'GrantResolverError',
  'InvalidCommitTimestampError',
  'InvalidMountKeyError',
  'InvalidPathError',
  'InvariantError',
  'MergePendingApprovalError',
  'NotFoundError',
  'PermissionDeniedError',
  'PreconditionFailedError',
  'RefConflictError',
  'SchemaDriftError',
  'StorageError',
  'createDirectAdapter',
  'createTuddoFs',
] as const

const publicResultTypes: [WriteResult?, DeleteResult?, RestoreResult?] = []

function createFs() {
  return createTuddoFs({
    pool: {
      connect: async () => {
        throw new Error('database should not be reached')
      },
    },
    grants: { resolve: async () => ({ read: false, write: 'none' }) },
  })
}
async function openVirtualSession(initial: string) {
  let contents: Buffer<ArrayBufferLike> = Buffer.from(initial)
  const paths: string[] = []
  const session = await createFs().open({
    actor: { id: 'surface-user', tenant: 'surface-tenant' },
    sessionId: 'surface-session',
    mounts: [
      {
        key: 'live:data',
        virtual: {
          async list() {
            return []
          },
          async read(path) {
            paths.push(path)
            return contents
          },
          async write(path, bytes) {
            paths.push(path)
            contents = bytes
          },
        },
      },
    ],
  })
  return { session, paths }
}

test('main entry exports exactly the Tier-1 runtime surface', () => {
  assert.deepEqual(Object.keys(publicApi).sort(), [...TIER_ONE_EXPORTS].sort())
})

test('createTuddoFs returns only the Tier-1 host operations', () => {
  assert.deepEqual(Object.keys(createFs()).sort(), ['gc', 'invalidate', 'migrate', 'open', 'verify'])
})

test('edit reports zero string matches', async () => {
  const { session } = await openVirtualSession('hello')

  await assert.rejects(
    session.mount('live:data').edit('/note.txt', [{ oldText: 'missing', newText: 'replacement' }]),
    (error: unknown) => error instanceof EditMatchError && error.matchCount === 0,
  )
})

test('edit reports multiple string matches unless replaceAll is set', async () => {
  const { session } = await openVirtualSession('repeat repeat')

  await assert.rejects(
    session.mount('live:data').edit('/note.txt', [{ oldText: 'repeat', newText: 'done' }]),
    (error: unknown) => error instanceof EditMatchError && error.matchCount === 2,
  )
})

test('edit handles an empty oldText without blocking the event loop', async () => {
  const { session } = await openVirtualSession('ab')
  const mount = session.mount('live:data')

  await assert.rejects(
    mount.edit('/note.txt', [{ oldText: '', newText: '-' }]),
    (error: unknown) => error instanceof EditMatchError && error.matchCount === 3,
  )
  await mount.edit('/note.txt', [{ oldText: '', newText: '-', replaceAll: true }])
  assert.equal(await mount.read('/note.txt'), '-a-b-')
})

test('mount handles use plain absolute paths without repairing relative paths', async () => {
  const { session, paths } = await openVirtualSession('hello')
  const mount = session.mount('live:data')

  assert.equal(await mount.read('/note.txt'), 'hello')
  assert.deepEqual(paths, ['/note.txt'])
  await assert.rejects(mount.read('note.txt'), InvalidPathError)
})
test('mount handles reject compound addresses as plain paths', async () => {
  const { session } = await openVirtualSession('hello')

  await assert.rejects(
    session.mount('live:data').read('live:data:/note.txt'),
    (error: unknown) =>
      error instanceof InvalidPathError &&
      error.message.includes('must start with /') &&
      !error.message.includes('must be addressed as mount:/path'),
  )
})

test('opened sessions do not expose compound-address file methods', async () => {
  const { session } = await openVirtualSession('hello')

  for (const operation of ['read', 'readBytes', 'write', 'edit', 'list', 'glob', 'stat', 'delete', 'history']) {
    assert.equal(operation in session, false, operation)
  }
})

test('Tier-1 result types are nameable from the main entry', () => {
  assert.equal(publicResultTypes.length, 0)
})
