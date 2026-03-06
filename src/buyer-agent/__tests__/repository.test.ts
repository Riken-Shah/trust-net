import assert from 'node:assert/strict'
import test from 'node:test'

import { fetchSellerCandidates } from '../repository.js'

test('fetchSellerCandidates can include verified sellers for full runs', async () => {
  const calls: Array<{ sql: string; values: Array<string | number | boolean | null> }> = []
  const pool = {
    async query(sql: string, values: Array<string | number | boolean | null>) {
      calls.push({ sql, values })
      return { rows: [] }
    },
  }

  const sellers = await fetchSellerCandidates(pool as any, {
    maxSellers: null,
    targetSeller: null,
    includeVerifiedSellers: true,
    includeVerifiedTarget: false,
  })

  assert.deepEqual(sellers, [])
  assert.equal(calls.length, 1)
  const firstCall = calls[0]
  assert.ok(firstCall)
  assert.match(firstCall.sql, /\$2::boolean = TRUE/)
  assert.deepEqual(firstCall.values, [null, true, false])
})
