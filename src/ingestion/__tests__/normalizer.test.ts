import assert from 'node:assert/strict'
import test from 'node:test'

import { normalizeSeller, normalizeSellers } from '../normalizer.js'

test('normalizeSeller accepts current discover seller shape', () => {
  const { seller, reject } = normalizeSeller({
    teamId: ' team-1 ',
    nvmAgentId: ' agent-1 ',
    walletAddress: '0xABCD',
    teamName: ' Team ',
    name: ' Seller Name ',
    description: ' Desc ',
    category: 'Research',
    keywords: ['foo', ' bar ', '', 'foo'],
    endpointUrl: ' https://seller.example/mcp ',
    servicesSold: ' search ',
    pricing: {
      servicesPerRequest: ' report ',
      perRequest: ' $0.10 ',
      meteringUnit: ' per request ',
    },
    createdAt: '2026-03-05T22:40:13.358Z',
    planIds: ['p1', ' p2 ', '', 'p1'],
    planPricing: [
      { planDid: 'p1', planPrice: 2 },
      { planDid: 'p2', planPrice: 10 },
    ],
  })

  assert.equal(reject, null)
  assert.ok(seller)
  assert.equal(seller.nvmAgentId, 'agent-1')
  assert.equal(seller.walletAddress, '0xabcd')
  assert.equal(seller.endpointUrl, 'https://seller.example/mcp')
  assert.deepEqual(seller.keywords, ['foo', 'bar'])
  assert.deepEqual(seller.planIds, ['p1', 'p2'])
  assert.equal(seller.pricePerRequestDisplay, '$0.10')
  assert.equal(seller.priceMeteringUnit, 'per request')
  assert.equal(seller.priceDisplay, 10)
  assert.ok(seller.apiCreatedAt)
})

test('normalizeSeller rejects when discover-required fields are missing', () => {
  const { seller, reject } = normalizeSeller({
    teamId: 'team-1',
    walletAddress: '0x1',
    name: 'name',
    endpointUrl: 'https://seller.example/mcp',
    createdAt: '2026-03-05T22:40:13.358Z',
    planIds: ['p1'],
  })

  assert.equal(seller, null)
  assert.ok(reject)
  assert.equal(reject.sellerId, 'team-1:name')
  assert.match(reject.reason, /nvmAgentId/)
})

test('normalizeSellers returns accepted and rejected sets using discover seller identifiers', () => {
  const result = normalizeSellers([
    {
      teamId: 't1',
      nvmAgentId: 'nvm-1',
      walletAddress: '0x1',
      name: 'n1',
      endpointUrl: 'https://one.example/mcp',
      createdAt: '2026-03-05T22:40:13.358Z',
      planIds: ['p1'],
    },
    {
      teamId: 't2',
      walletAddress: '0x2',
      name: 'n2',
      endpointUrl: 'https://two.example/mcp',
      createdAt: '2026-03-05T22:40:13.358Z',
      planIds: [],
    },
  ])

  assert.equal(result.sellers.length, 1)
  assert.equal(result.rejected.length, 1)
  assert.equal(result.rejected[0]?.sellerId, 't2:n2')
})
