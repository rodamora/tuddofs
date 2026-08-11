import assert from 'node:assert/strict'
import test from 'node:test'

import { NotFoundError, PermissionDeniedError, createTuddoFs } from '../index.js'

test('virtual session reads and lists through the executing actor', async () => {
  const calls: string[] = []
  const fs = createTuddoFs({
    pool: {
      connect: async () => {
        throw new Error('not expected')
      },
    },
    grants: { resolve: async () => ({ read: false, write: 'none' }) },
  })
  const session = await fs.open({
    actor: { id: 'user-1', tenant: 'tenant-1' },
    sessionId: 'session-1',
    mounts: [
      {
        key: 'team:roster',
        virtual: {
          async list(dir, actor) {
            calls.push(`${dir}:${actor.id}`)
            return [{ path: '/alice.md', type: 'file', sizeBytes: 5, mode: 420 }]
          },
          async read(path, actor) {
            calls.push(`${path}:${actor.id}`)
            return Buffer.from('alice')
          },
        },
      },
    ],
  })

  const roster = session.mount('team:roster')
  assert.equal((await roster.read('/alice.md')).toString(), 'alice')
  assert.deepEqual(await roster.list('/'), [{ path: '/alice.md', type: 'file', sizeBytes: 5, mode: 420 }])
  assert.deepEqual(calls, ['/alice.md:user-1', '/:user-1'])
})

test('virtual mounts are read-only when handler write is absent and have no history surfaces', async () => {
  const fs = createTuddoFs({
    pool: {
      connect: async () => {
        throw new Error('not expected')
      },
    },
    grants: { resolve: async () => ({ read: false, write: 'none' }) },
  })
  const session = await fs.open({
    actor: { id: 'user-1', tenant: 'tenant-1' },
    sessionId: 'session-1',
    mounts: [
      {
        key: 'live:data',
        virtual: {
          async list() {
            return []
          },
          async read() {
            return null
          },
        },
      },
    ],
  })

  const live = session.mount('live:data')
  await assert.rejects(live.write('/x', 'x'), PermissionDeniedError)
  await assert.rejects(live.history('/x'), NotFoundError)
  await assert.rejects(session.diff('live:data:/x', 'live:data:/y'), NotFoundError)
  await assert.rejects(session.restore('live:data', 'tag/live'), NotFoundError)
  await assert.rejects(session.tag('live:data', 'snapshot'), NotFoundError)
  assert.deepEqual(await session.merge(), {})
  assert.deepEqual(await session.merge({ mounts: ['live:data'] }), {})
})
test('virtual glob entries use UTF-16 code-unit ordering', async () => {
  const fs = createTuddoFs({
    pool: {
      connect: async () => {
        throw new Error('not expected')
      },
    },
    grants: { resolve: async () => ({ read: false, write: 'none' }) },
  })
  const session = await fs.open({
    actor: { id: 'user-1', tenant: 'tenant-1' },
    sessionId: 'session-glob-order',
    mounts: [
      {
        key: 'live:data',
        virtual: {
          async list(dir) {
            return dir === '/'
              ? [
                  { path: '/😀', type: 'file' },
                  { path: '/z', type: 'file' },
                ]
              : []
          },
          async read() {
            return Buffer.from('value')
          },
        },
      },
    ],
  })

  assert.deepEqual(
    (await session.mount('live:data').glob('/*')).map(entry => entry.path),
    ['/z', '/😀'],
  )
})
