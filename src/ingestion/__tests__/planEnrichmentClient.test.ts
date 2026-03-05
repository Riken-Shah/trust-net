import assert from 'node:assert/strict'
import test from 'node:test'

import { enrichPlans } from '../planEnrichmentClient.js'

test('enrichPlans maps successful plans and tracks failures', async () => {
  const calls: string[] = []
  const result = await enrichPlans(
    ['p1', 'p2', 'p3'],
    {
      nvmApiKey: 'sandbox:key',
      nvmEnvironment: 'sandbox',
      concurrency: 2,
    },
    async (planId) => {
      calls.push(planId)
      if (planId === 'p2') {
        throw new Error('boom')
      }
      return {
        name: `Name ${planId}`,
        priceAmount: '100',
      }
    },
  )

  assert.equal(calls.length, 3)
  assert.equal(result.byPlanId.size, 2)
  assert.equal(result.byPlanId.get('p1')?.name, 'Name p1')
  assert.deepEqual(result.failedPlanIds, ['p2'])
})

test('enrichPlans deduplicates plan IDs before querying', async () => {
  let count = 0

  const result = await enrichPlans(
    ['p1', 'p1', 'p1'],
    {
      nvmApiKey: 'sandbox:key',
      nvmEnvironment: 'sandbox',
      concurrency: 5,
    },
    async () => {
      count += 1
      return { name: 'only once' }
    },
  )

  assert.equal(count, 1)
  assert.equal(result.byPlanId.size, 1)
  assert.equal(result.failedPlanIds.length, 0)
})
