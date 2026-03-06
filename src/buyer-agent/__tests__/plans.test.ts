import assert from 'node:assert/strict'
import test from 'node:test'

import { selectCheapestPlan } from '../plans.js'

test('selectCheapestPlan prefers lowest fiat price', () => {
  const plan = selectCheapestPlan([
    { nvmPlanId: 'b', fiatAmountCents: 250, tokenSymbol: null, priceAmount: null },
    { nvmPlanId: 'a', fiatAmountCents: 100, tokenSymbol: null, priceAmount: null },
  ])

  assert.equal(plan?.nvmPlanId, 'a')
})

test('selectCheapestPlan compares USDC plans when fiat is absent', () => {
  const plan = selectCheapestPlan([
    { nvmPlanId: 'a', fiatAmountCents: null, tokenSymbol: 'USDC', priceAmount: '2000000' },
    { nvmPlanId: 'b', fiatAmountCents: null, tokenSymbol: 'USDC', priceAmount: '1000000' },
  ])

  assert.equal(plan?.nvmPlanId, 'b')
})

test('selectCheapestPlan falls back to deterministic plan id ordering', () => {
  const plan = selectCheapestPlan([
    { nvmPlanId: 'z', fiatAmountCents: null, tokenSymbol: null, priceAmount: null },
    { nvmPlanId: 'a', fiatAmountCents: null, tokenSymbol: null, priceAmount: null },
  ])

  assert.equal(plan?.nvmPlanId, 'a')
})
