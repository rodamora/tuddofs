import assert from 'node:assert/strict'
import test from 'node:test'

import { createDirectAdapter } from '../index.js'

test('direct adapter forwards in-process file tools to a session', async () => {
  const calls: string[] = []
  const session = {
    actor: { id: 'user', tenant: 'tenant' },
    mount(key: string) {
      calls.push(`mount:${key}`)
      return {
        async read(path: string) {
          calls.push(`read:${path}`)
          return 'content'
        },
        async write(path: string, bytes: string) {
          calls.push(`write:${path}:${bytes}`)
          return { path, sha256: 'sha', sizeBytes: 7n, commitSha: 'commit' }
        },
        async list(path: string) {
          calls.push(`list:${path}`)
          return []
        },
      }
    },
  }
  const tools = createDirectAdapter(session as never)
  assert.equal(await tools.read_file({ path: 'project:docs:/a' }), 'content')
  assert.equal((await tools.write_file({ path: 'project:docs:/a', content: 'content' })).commitSha, 'commit')
  assert.deepEqual(await tools.list_files({ dir: 'project:docs:/' }), [])
  assert.deepEqual(calls, [
    'mount:project:docs',
    'read:/a',
    'mount:project:docs',
    'write:/a:content',
    'mount:project:docs',
    'list:/',
  ])
})
