import assert from 'node:assert/strict'
import test from 'node:test'

import { NotFoundError, PermissionDeniedError, createAgentFs } from '../index.js'

test('virtual session reads and lists through the executing actor', async () => {
  const calls: string[] = []
  const fs = createAgentFs({
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

  assert.equal((await session.read('team:roster:/alice.md')).toString(), 'alice')
  assert.deepEqual(await session.list('team:roster:/'), [{ path: '/alice.md', type: 'file', sizeBytes: 5, mode: 420 }])
  assert.deepEqual(calls, ['/alice.md:user-1', '/:user-1'])
})

test('virtual mounts are read-only when handler write is absent and have no history surfaces', async () => {
  const fs = createAgentFs({
    pool: {
      connect: async () => {
        throw new Error('not expected')
      },
    },
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

  await assert.rejects(session.write('live:data:/x', 'x'), PermissionDeniedError)
  await assert.rejects(session.history('live:data:/x'), NotFoundError)
  await assert.rejects(session.diff('live:data:/x', 'live:data:/y'), NotFoundError)
  await assert.rejects(session.restore('live:data', 'tag/live'), NotFoundError)
  await assert.rejects(session.tag('live:data', 'snapshot'), NotFoundError)
  assert.deepEqual(await session.merge(), {})
  await assert.rejects(session.resolveMerge('live:data'), NotFoundError)
})
test('virtual glob entries use UTF-16 code-unit ordering', async () => {
  const fs = createAgentFs({
    pool: {
      connect: async () => {
        throw new Error('not expected')
      },
    },
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
    (await session.glob('live:data:/*')).map(entry => entry.path),
    ['/z', '/😀'],
  )
})
