import assert from 'node:assert/strict'
import { execFile as execFileCallback } from 'node:child_process'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFile = promisify(execFileCallback)

test('demo runs through the string-replace adapter contract', async () => {
  const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))))
  const { stdout } = await execFile(process.execPath, ['--import', 'tsx', join(root, 'scripts/demo.ts')], {
    cwd: root,
    env: process.env,
  })

  assert.match(stdout, /"mount":"project:demo"/u)
  assert.match(stdout, /"text":"# Plan\\nWrite through the governed session\.\\n"/u)
  assert.match(stdout, /"files":\["\/notes\/plan\.md"\]/u)
  assert.match(stdout, /"confined":true/u)
})
