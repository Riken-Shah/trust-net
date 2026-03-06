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

test('mapPlanFromSdk maps current Nevermined fiat plan payloads', () => {
  const mapped = mapPlanFromSdk('plan-3', {
    metadata: {
      main: {
        name: 'Leads',
        description: 'Lead seller plan',
      },
      plan: {
        accessLimit: 'credits',
        fiatPaymentProvider: 'stripe',
      },
      curation: {
        isListed: true,
      },
    },
    registry: {
      price: {
        isCrypto: false,
        tokenAddress: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
        amounts: ['9800000', '200000'],
        receivers: ['0xReceiver', '0xFeeController'],
      },
      credits: {
        amount: '100',
        minAmount: '10',
        maxAmount: '10',
        durationSecs: '0',
      },
    },
  })

  assert.equal(mapped.name, 'Leads')
  assert.equal(mapped.pricingType, 'fiat')
  assert.equal(mapped.priceAmount, '10000000')
  assert.equal(mapped.tokenAddress, '0x036CbD53842c5426634e7929541eC2318f3dCF7e')
  assert.equal(mapped.tokenSymbol, 'USDC')
  assert.equal(mapped.fiatAmountCents, 1000)
  assert.equal(mapped.network, 'stripe')
  assert.equal(mapped.receiverAddress, '0xReceiver')
  assert.equal(mapped.creditsGranted, '100')
  assert.equal(mapped.creditsPerCall, '10')
  assert.equal(mapped.creditsMin, '10')
  assert.equal(mapped.creditsMax, '10')
  assert.equal(mapped.durationSeconds, 0)
})

test('mapPlanFromSdk infers crypto vs erc20 from current registry price', () => {
  const mapped = mapPlanFromSdk('plan-4', {
    metadata: {
      main: {
        name: 'USDC Plan',
      },
    },
    registry: {
      price: {
        isCrypto: true,
        tokenAddress: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
        amounts: ['1000000'],
      },
      credits: {
        amount: '5',
        minAmount: '1',
        maxAmount: '1',
        durationSecs: '0',
      },
    },
  })

  assert.equal(mapped.pricingType, 'erc20')
  assert.equal(mapped.priceAmount, '1000000')
  assert.equal(mapped.tokenSymbol, 'USDC')
  assert.equal(mapped.fiatAmountCents, null)
})
