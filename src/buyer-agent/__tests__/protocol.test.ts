import assert from 'node:assert/strict'
import test from 'node:test'

import { detectSellerProtocol, parseMcpToolOffers, parsePricingOffers } from '../protocol.js'

function createResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers,
  })
}

test('parsePricingOffers handles array tiers format', () => {
  const offers = parsePricingOffers({
    tiers: [
      { tool: 'search_data', credits: 1 },
      { name: 'summarize_data', credits: 5 },
    ],
  })

  assert.deepEqual(
    offers.map((item) => item.normalized),
    ['search_data', 'summarize_data'],
  )
})

test('parsePricingOffers handles object tiers format', () => {
  const offers = parsePricingOffers({
    tiers: {
      basic: { tool: 'search_data' },
      premium: { description: 'research' },
    },
  })

  assert.deepEqual(
    offers.map((item) => item.name),
    ['search_data', 'premium'],
  )
})

test('parseMcpToolOffers reads tools list response', () => {
  const offers = parseMcpToolOffers({
    jsonrpc: '2.0',
    result: {
      tools: [
        { name: 'weather.today' },
        { name: 'summarize' },
      ],
    },
  })

  assert.deepEqual(
    offers.map((item) => item.normalized),
    ['weather.today', 'summarize'],
  )
  assert.deepEqual(
    offers.map((item) => item.capabilityKind),
    ['tool', 'tool'],
  )
})

test('detectSellerProtocol recognizes auth-protected MCP endpoints', async () => {
  const originalFetch = global.fetch
  const responses = [
    createResponse(404, { detail: 'not found' }),
    createResponse(404, { detail: 'not found' }),
    createResponse(401, { detail: { error: 'unauthorized', error_description: 'Authorization header required' } }),
    createResponse(200, {
      authorization_servers: ['https://nevermined.dev'],
      scopes_supported: ['openid', 'mcp:tools'],
    }),
    createResponse(200, {
      issuer: 'https://nevermined.dev',
      token_endpoint: 'https://api.sandbox.nevermined.dev/oauth/token',
    }),
  ]

  global.fetch = async () => {
    const next = responses.shift()
    if (!next) {
      throw new Error('Unexpected extra fetch call in test.')
    }
    return next
  }

  try {
    const result = await detectSellerProtocol('https://example.com/mcp', 1000)
    assert.equal(result.protocol, 'mcp')
    assert.equal(result.reason, 'mcp_auth_protected_resource_detected')
    assert.equal(result.details.mcpUrl, 'https://example.com/mcp')
    assert.equal(result.details.authProtected, true)
  } finally {
    global.fetch = originalFetch
  }
})

test('detectSellerProtocol rejects generic well-known JSON without A2A payment extension', async () => {
  const originalFetch = global.fetch
  const responses = [
    createResponse(200, {
      name: 'Generic Seller',
      description: 'Not actually A2A',
      skills: [{ name: 'lead-search' }],
    }),
    createResponse(404, { detail: 'not found' }),
    createResponse(404, { detail: 'not found' }),
    createResponse(405, { detail: 'not found' }),
    createResponse(404, { detail: 'not found' }),
  ]

  global.fetch = async () => {
    const next = responses.shift()
    if (!next) {
      throw new Error('Unexpected extra fetch call in test.')
    }
    return next
  }

  try {
    const result = await detectSellerProtocol('https://example.com/leads', 1000)
    assert.equal(result.protocol, 'unknown')
    assert.equal(result.reason, 'unknown_protocol')
  } finally {
    global.fetch = originalFetch
  }
})

test('detectSellerProtocol accepts Nevermined A2A payment cards with skills', async () => {
  const originalFetch = global.fetch
  const responses = [
    createResponse(200, {
      name: 'Weather Agent',
      description: 'A2A seller',
      skills: [{ name: 'weather.today' }],
      capabilities: {
        extensions: [
          {
            uri: 'urn:nevermined:payment',
            params: {
              planId: 'plan-1',
              agentId: 'agent-1',
            },
          },
        ],
      },
    }),
  ]

  global.fetch = async () => {
    const next = responses.shift()
    if (!next) {
      throw new Error('Unexpected extra fetch call in test.')
    }
    return next
  }

  try {
    const result = await detectSellerProtocol('https://example.com/a2a', 1000)
    assert.equal(result.protocol, 'a2a')
    assert.equal(result.reason, 'a2a_agent_card_detected')
    assert.equal(result.details.a2aBaseUrl, 'https://example.com/')
    assert.equal((result.details.paymentParams as { planId?: string }).planId, 'plan-1')
  } finally {
    global.fetch = originalFetch
  }
})
