import assert from 'node:assert/strict'
import test from 'node:test'

import { buildServiceUnion, matchServiceToOffer, normalizeServiceName, parseServicesSoldCsv } from '../offers.js'

test('normalizeServiceName trims, lowercases, and collapses spaces', () => {
  assert.equal(normalizeServiceName('  Web   Search  '), 'web search')
})

test('parseServicesSoldCsv strips empties and dedupes', () => {
  const parsed = parseServicesSoldCsv('search, summarize, search,  ,  data analysis  ')
  assert.deepEqual(
    parsed.map((item) => item.normalized),
    ['search', 'summarize', 'data analysis'],
  )
})

test('buildServiceUnion merges db services and discovered offers', () => {
  const services = buildServiceUnion('search, market research', [
    { name: 'search_data', normalized: 'search_data', source: 'mcp_tools', capabilityKind: 'tool', capabilityId: 'search_data', metadata: null },
    { name: 'market research', normalized: 'market research', source: 'x402_pricing', capabilityKind: null, capabilityId: null, metadata: null },
  ])

  assert.deepEqual(
    services.map((item) => item.normalized),
    ['market research', 'search', 'search_data'],
  )

  const market = services.find((item) => item.normalized === 'market research')
  assert.equal(market?.matchedEndpointOffer, 'market research')
})

test('matchServiceToOffer prefers exact then containment', () => {
  const offers = [
    { name: 'search_data', normalized: 'search data', source: 'mcp_tools' as const, capabilityKind: 'tool' as const, capabilityId: 'search_data', metadata: null },
    { name: 'research_topic', normalized: 'research topic', source: 'mcp_tools' as const, capabilityKind: 'tool' as const, capabilityId: 'research_topic', metadata: null },
  ]

  const exact = matchServiceToOffer(
    {
      displayName: 'research topic',
      normalized: 'research topic',
      matchedEndpointOffer: null,
      matchedEndpointOfferKind: null,
      matchedEndpointOfferId: null,
    },
    offers,
  )
  assert.equal(exact?.name, 'research_topic')

  const contain = matchServiceToOffer(
    {
      displayName: 'search',
      normalized: 'search',
      matchedEndpointOffer: null,
      matchedEndpointOfferKind: null,
      matchedEndpointOfferId: null,
    },
    offers,
  )
  assert.equal(contain?.name, 'search_data')
})
