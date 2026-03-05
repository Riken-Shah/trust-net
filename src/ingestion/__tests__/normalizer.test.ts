import assert from 'node:assert/strict'
import test from 'node:test'

import { normalizeSeller, normalizeSellers } from '../normalizer.js'

test('normalizeSeller accepts valid seller and sanitizes optional fields', () => {
  const { seller, reject } = normalizeSeller({
    id: ' seller-1 ',
    teamId: ' team-1 ',
    nvmAgentId: ' agent-1 ',
    walletAddress: '0xABCD',
    teamName: ' Team ',
    name: ' Seller Name ',
    description: ' Desc ',
    category: 'Research',
    keywords: ['foo', ' bar ', '', 'foo'],
    marketplaceReady: true,
    endpointUrl: ' POST /data ',
    servicesSold: ' search ',
    servicesProvidedPerRequest: ' report ',
    pricePerRequest: ' $0.10 ',
    priceMeteringUnit: 'per request',
    price: '10',
    createdAt: '2026-03-05T22:40:13.358Z',
    updatedAt: '2026-03-05T22:54:38.843Z',
    planIds: ['p1', ' p2 ', '', 'p1'],
  })

  assert.equal(reject, null)
  assert.ok(seller)
  assert.equal(seller.marketplaceId, 'seller-1')
  assert.equal(seller.walletAddress, '0xabcd')
  assert.deepEqual(seller.keywords, ['foo', 'bar'])
  assert.deepEqual(seller.planIds, ['p1', 'p2'])
  assert.equal(seller.priceDisplay, 10)
  assert.ok(seller.apiCreatedAt)
  assert.ok(seller.apiUpdatedAt)
})

test('normalizeSeller rejects when required fields are missing', () => {
  const { seller, reject } = normalizeSeller({
    id: 'seller-1',
    teamId: 'team-1',
    walletAddress: '',
    name: 'name',
    planIds: ['p1'],
  })

  assert.equal(seller, null)
  assert.ok(reject)
  assert.match(reject.reason, /walletAddress/)
})

test('normalizeSellers returns accepted and rejected sets', () => {
  const result = normalizeSellers([
    {
      id: 'ok',
      teamId: 't1',
      walletAddress: '0x1',
      name: 'n1',
      planIds: ['p1'],
    },
    {
      id: 'bad',
      teamId: 't2',
      walletAddress: '0x2',
      name: 'n2',
      planIds: [],
    },
  ])

  assert.equal(result.sellers.length, 1)
  assert.equal(result.rejected.length, 1)
  assert.equal(result.rejected[0]?.sellerId, 'bad')
})
