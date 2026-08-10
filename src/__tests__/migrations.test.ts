import './test-setup.js'

import assert from 'node:assert/strict'
import test from 'node:test'

import { migrate } from '../migration.js'

test('migrate creates the package-owned kernel schema idempotently', async () => {
  const queries: string[] = []
  const pool = {
    async connect() {
      return {
        async query(text: string) {
          queries.push(text)
          return { rows: [], rowCount: 0 }
        },
        release() {},
      }
    },
  }

  await migrate(pool)
  await migrate(pool)

  assert.ok(queries.some(query => query.includes('CREATE TABLE IF NOT EXISTS afs_blobs')))
  assert.ok(queries.some(query => query.includes('CREATE TABLE IF NOT EXISTS afs_heads')))
  assert.equal(queries.filter(query => query.includes('CREATE TABLE IF NOT EXISTS afs_blobs')).length, 2)
})
