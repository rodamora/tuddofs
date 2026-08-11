import { Pool } from 'pg'

import { createAgentFs, createDirectAdapter } from '../src/index.js'

const connectionString = process.env.TUDDOFS_DATABASE_URL ?? process.env.DATABASE_URL
if (!connectionString) throw new Error('TUDDOFS_DATABASE_URL or DATABASE_URL is required')

const pool = new Pool({ connectionString })
const tenant = `demo-${Date.now()}`
const mount = 'project:demo'
const fs = createAgentFs({
  pool,
  grants: {
    async resolve(actor, mountRef) {
      return actor.id === 'demo-user' && actor.tenant === tenant && mountRef.key === mount
        ? { read: true, write: 'direct' }
        : { read: false, write: 'none' }
    },
  },
})

try {
  await fs.migrate()
  const session = await fs.open({
    actor: { id: 'demo-user', tenant },
    sessionId: 'demo-session',
    attribution: {
      agentKind: 'demo-agent',
      threadId: 'demo-thread',
      runId: 'demo-run',
    },
    mounts: [{ key: mount }],
  })
  const tools = createDirectAdapter(session)

  // A tiny in-process agent loop: each turn only receives the session tools.
  await tools.write_file({
    path: `${mount}:/notes/plan.md`,
    content: '# Plan\n',
  })
  const stat = await tools.stat_file({ path: `${mount}:/notes/plan.md` })
  await tools.edit_file({
    path: `${mount}:/notes/plan.md`,
    edits: [{ start: 7, end: 7, text: 'Write through the governed session.\n' }],
    ifSha: stat.sha256,
  })
  const text = await tools.read_file({ path: `${mount}:/notes/plan.md` })
  const files = await tools.glob_files({ pattern: `${mount}:/**/*.md` })
  let confined = false
  try {
    await tools.read_file({ path: 'project:outside:/secret.txt' })
  } catch {
    confined = true
  }

  console.log(
    JSON.stringify({
      tenant,
      mount,
      text,
      files: files.map(file => file.path),
      confined,
    }),
  )
} finally {
  await pool.end()
}
