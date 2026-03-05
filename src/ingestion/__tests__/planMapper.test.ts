import assert from 'node:assert/strict'
import test from 'node:test'

import { mapPlanFromSdk } from '../planMapper.js'

test('mapPlanFromSdk maps direct fields', () => {
  const mapped = mapPlanFromSdk('plan-1', {
    name: 'Plan One',
    description: 'Desc',
    planType: 'credits',
    pricingType: 'erc20',
    priceAmount: '1000000',
    tokenAddress: '0xToken',
    tokenSymbol: 'USDC',
    fiatAmountCents: 123,
    fiatCurrency: 'USD',
    network: 'eip155:84532',
    receiverAddress: '0xReceiver',
    creditsGranted: '100',
    creditsPerCall: '1',
    creditsMin: '1',
    creditsMax: '10',
    durationSeconds: 3600,
    isActive: true,
  })

  assert.equal(mapped.nvmPlanId, 'plan-1')
  assert.equal(mapped.name, 'Plan One')
  assert.equal(mapped.pricingType, 'erc20')
  assert.equal(mapped.tokenAddress, '0xToken')
  assert.equal(mapped.durationSeconds, 3600)
  assert.equal(mapped.isActive, true)
})

test('mapPlanFromSdk maps nested fallback fields', () => {
  const mapped = mapPlanFromSdk('plan-2', {
    planMetadata: {
      name: 'Nested Name',
      description: 'Nested Desc',
    },
    pricingConfiguration: {
      type: 'fiat',
      price: 999,
      tokenAddress: '0xNestedToken',
      tokenSymbol: 'USDT',
      network: 'stripe',
      receiver: '0xNestedReceiver',
      fiatAmountCents: 999,
      fiatCurrency: 'USD',
    },
    creditsConfiguration: {
      amountOfCredits: '100',
      minCreditsToCharge: '2',
      minCreditsRequired: '1',
      maxCreditsToCharge: '4',
    },
    isListed: false,
  })

  assert.equal(mapped.name, 'Nested Name')
  assert.equal(mapped.description, 'Nested Desc')
  assert.equal(mapped.pricingType, 'fiat')
  assert.equal(mapped.priceAmount, '999')
  assert.equal(mapped.network, 'stripe')
  assert.equal(mapped.receiverAddress, '0xNestedReceiver')
  assert.equal(mapped.creditsGranted, '100')
  assert.equal(mapped.creditsPerCall, '2')
  assert.equal(mapped.creditsMin, '1')
  assert.equal(mapped.creditsMax, '4')
  assert.equal(mapped.isActive, false)
})
