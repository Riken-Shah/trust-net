import assert from 'node:assert/strict'
import test from 'node:test'

import { ensurePlanReady } from '../bootstrap.js'

test('ensurePlanReady orders crypto plans when balance is empty', async () => {
  let orderCalls = 0

  const result = await ensurePlanReady(
    {
      plans: {
        getPlanBalance: async () => ({ isSubscriber: false, balance: 0 }),
        orderPlan: async () => {
          orderCalls += 1
          return { success: true }
        },
      },
    },
    {
      nvmPlanId: 'plan-1',
      pricingType: 'erc20',
      fiatAmountCents: null,
      tokenSymbol: 'USDC',
      priceAmount: '1000000',
    },
  )

  assert.deepEqual(result, { status: 'ready' })
  assert.equal(orderCalls, 1)
})

test('ensurePlanReady blocks on fiat checkout when checkout url is returned', async () => {
  const result = await ensurePlanReady(
    {
      plans: {
        getPlanBalance: async () => ({ isSubscriber: false, balance: 0 }),
        orderFiatPlan: async () => ({ checkoutUrl: 'https://checkout.stripe.com/session' }),
      },
    },
    {
      nvmPlanId: 'plan-2',
      pricingType: 'fiat',
      fiatAmountCents: 500,
      tokenSymbol: 'USDC',
      priceAmount: '5000000',
    },
  )

  assert.equal(result.status, 'blocked')
  if (result.status !== 'blocked') {
    assert.fail('Expected fiat checkout to block verification.')
  }
  assert.equal(result.reason, 'fiat_checkout_required')
  assert.equal(result.paymentMeta?.checkoutUrl, 'https://checkout.stripe.com/session')
})

test('ensurePlanReady surfaces fiat checkout failures cleanly', async () => {
  const result = await ensurePlanReady(
    {
      plans: {
        getPlanBalance: async () => ({ isSubscriber: false, balance: 0 }),
        orderFiatPlan: async () => {
          throw new Error('Cannot POST /api/v1/stripe/checkout')
        },
      },
    },
    {
      nvmPlanId: 'plan-3',
      pricingType: 'fiat',
      fiatAmountCents: 500,
      tokenSymbol: 'USDC',
      priceAmount: '5000000',
    },
  )

  assert.equal(result.status, 'failed')
  if (result.status !== 'failed') {
    assert.fail('Expected fiat checkout failure to be surfaced.')
  }
  assert.equal(result.reason, 'fiat_checkout_error:Cannot POST /api/v1/stripe/checkout')
})
