import assert from 'node:assert/strict'
import test from 'node:test'

import { selectCheapestPlan } from '../plans.js'

test('selectCheapestPlan prefers lowest fiat price', () => {
  const plan = selectCheapestPlan([
    { nvmPlanId: 'b', pricingType: 'fiat', fiatAmountCents: 250, tokenSymbol: null, priceAmount: null },
    { nvmPlanId: 'a', pricingType: 'fiat', fiatAmountCents: 100, tokenSymbol: null, priceAmount: null },
  ])

  assert.equal(plan?.nvmPlanId, 'a')
})

test('selectCheapestPlan compares USDC plans when fiat is absent', () => {
  const plan = selectCheapestPlan([
    { nvmPlanId: 'a', pricingType: 'erc20', fiatAmountCents: null, tokenSymbol: 'USDC', priceAmount: '2000000' },
    { nvmPlanId: 'b', pricingType: 'erc20', fiatAmountCents: null, tokenSymbol: 'USDC', priceAmount: '1000000' },
  ])

  assert.equal(plan?.nvmPlanId, 'b')
})

test('selectCheapestPlan falls back to deterministic plan id ordering', () => {
  const plan = selectCheapestPlan([
    { nvmPlanId: 'z', pricingType: null, fiatAmountCents: null, tokenSymbol: null, priceAmount: null },
    { nvmPlanId: 'a', pricingType: null, fiatAmountCents: null, tokenSymbol: null, priceAmount: null },
  ])

  assert.equal(plan?.nvmPlanId, 'a')
})
