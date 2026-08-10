import { Pool } from 'pg'

import { createAgentFs } from '../src/index.js'

const connectionString = process.env.AGENT_FS_DATABASE_URL ?? process.env.DATABASE_URL
if (!connectionString) throw new Error('AGENT_FS_DATABASE_URL or DATABASE_URL is required')

const pool = new Pool({ connectionString })
const tenant = `demo-${Date.now()}`
const mount = 'project:demo'
const fs = createAgentFs({ pool })

try {
  await fs.migrate()
  const first = await fs.fork({ tenant, mount, sessionId: 'demo-session', authorUser: 'demo-user' })
  if (!first) throw new Error('demo fork was not visible')
  const second = await fs.fork({ tenant, mount, sessionId: 'demo-session', authorUser: 'demo-user' })
  if (!second) throw new Error('demo re-fork was not visible')
  const write = await fs.write({
    tenant,
    mount,
    ref: first.ref,
    path: '/hello.txt',
    bytes: Buffer.from('hello from agent-fs'),
    authorUser: 'demo-user',
  })
  const read = await fs.read({ tenant, mount, ref: first.ref, path: '/hello.txt' })

  console.log(
    JSON.stringify({
      tenant,
      ref: first.ref,
      forkCommit: first.commitSha,
      writeCommit: write.commitSha,
      read: read.bytes.toString('utf8'),
      reforkIdempotent: second.commitSha === first.commitSha,
    }),
  )
} finally {
  await pool.end()
}
