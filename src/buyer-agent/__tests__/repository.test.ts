import assert from 'node:assert/strict'
import test from 'node:test'

import { fetchSellerCandidates, insertSetupFailure, markSellerVerified } from '../repository.js'

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

test('insertSetupFailure retries transient write errors', async () => {
  const state = {
    insertAttempts: 0,
    rollbacks: 0,
    releases: 0,
  }

  const client = {
    async query(sql: string, values?: unknown[]) {
      if (sql === 'BEGIN' || sql.startsWith('SET LOCAL') || sql === 'COMMIT') {
        return { rowCount: null, rows: [] }
      }
      if (sql === 'ROLLBACK') {
        state.rollbacks += 1
        return { rowCount: null, rows: [] }
      }
      if (sql.includes('INSERT INTO buyer_agent_judgments')) {
        state.insertAttempts += 1
        if (state.insertAttempts === 1) {
          const error = new Error('lock timeout') as Error & { code?: string }
          error.code = '55P03'
          throw error
        }
        assert.equal(values?.[0], 'run-1')
        return { rowCount: 1, rows: [] }
      }
      throw new Error(`Unexpected SQL: ${sql}`)
    },
    release() {
      state.releases += 1
    },
  }

  const pool = {
    async connect() {
      return client
    },
  }

  await insertSetupFailure(pool as any, {
    runId: 'run-1',
    seller: {
      agentId: 'agent-1',
      marketplaceId: 'market-1',
      name: 'Seller',
      endpointUrl: 'https://seller.example/mcp',
    },
    protocol: 'unknown',
    reason: 'unknown_protocol',
    planId: 'plan-1',
  })

  assert.equal(state.insertAttempts, 2)
  assert.equal(state.rollbacks, 1)
  assert.equal(state.releases, 2)
})

test('markSellerVerified retries transient write errors and returns success', async () => {
  const state = {
    updateAttempts: 0,
    rollbacks: 0,
    releases: 0,
  }

  const client = {
    async query(sql: string) {
      if (sql === 'BEGIN' || sql.startsWith('SET LOCAL') || sql === 'COMMIT') {
        return { rowCount: null, rows: [] }
      }
      if (sql === 'ROLLBACK') {
        state.rollbacks += 1
        return { rowCount: null, rows: [] }
      }
      if (sql.includes('UPDATE agents')) {
        state.updateAttempts += 1
        if (state.updateAttempts === 1) {
          const error = new Error('statement timeout') as Error & { code?: string }
          error.code = '57014'
          throw error
        }
        return { rowCount: 1, rows: [] }
      }
      throw new Error(`Unexpected SQL: ${sql}`)
    },
    release() {
      state.releases += 1
    },
  }

  const pool = {
    async connect() {
      return client
    },
  }

  const updated = await markSellerVerified(pool as any, 'agent-1')

  assert.equal(updated, true)
  assert.equal(state.updateAttempts, 2)
  assert.equal(state.rollbacks, 1)
  assert.equal(state.releases, 2)
})
