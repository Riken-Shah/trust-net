import assert from 'node:assert/strict'
import test from 'node:test'

import { purchaseViaA2A } from '../clients/a2a.js'
import { purchaseViaMcp } from '../clients/mcp.js'
import { purchaseViaX402 } from '../clients/x402.js'

function createResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers,
  })
}

test('purchaseViaX402 returns successful settlement metadata', async () => {
  const originalFetch = global.fetch

  global.fetch = async () =>
    createResponse(
      200,
      { response: 'ok' },
      {
        'payment-response': Buffer.from(
          JSON.stringify({ transaction: '0xtx', creditsRedeemed: '1', remainingBalance: '9' }),
        ).toString('base64'),
      },
    )

  const payments = {
    plans: {
      getPlanBalance: async () => ({ isSubscriber: true, balance: 10 }),
      orderPlan: async () => ({ success: true }),
    },
    x402: {
      getX402AccessToken: async () => ({ accessToken: 'token' }),
    },
  }

  try {
    const result = await purchaseViaX402({
      payments,
      planId: 'plan-1',
      sellerAgentId: 'agent-1',
      serviceName: 'search',
      normalizedEndpointUrl: 'http://localhost:3000/data',
      protocolDetails: {},
      timeoutMs: 1000,
      cardDelegation: null,
    })

    assert.equal(result.purchaseSuccess, true)
    assert.equal(result.txHash, '0xtx')
    assert.equal(result.creditsRedeemed, '1')
  } finally {
    global.fetch = originalFetch
  }
})

test('purchaseViaMcp returns explicit failure when service cannot map to a tool', async () => {
  const originalFetch = global.fetch
  const responses = [
    createResponse(200, { jsonrpc: '2.0', id: 1, result: { serverInfo: { name: 'mcp' } } }),
    createResponse(200, { jsonrpc: '2.0', id: 2, result: { tools: [{ name: 'weather' }] } }),
  ]

  global.fetch = async () => {
    const next = responses.shift()
    if (!next) {
      throw new Error('Unexpected extra fetch call in test.')
    }
    return next
  }

  const payments = {
    plans: {
      getPlanBalance: async () => ({ isSubscriber: true, balance: 10 }),
      orderPlan: async () => ({ success: true }),
    },
    x402: {
      getX402AccessToken: async () => ({ accessToken: 'token' }),
    },
  }

  try {
    const result = await purchaseViaMcp({
      payments,
      planId: 'plan-1',
      sellerAgentId: 'agent-1',
      serviceName: 'stock-price',
      matchedOffer: null,
      normalizedEndpointUrl: 'http://localhost:3000/mcp',
      protocolDetails: { mcpUrl: 'http://localhost:3000/mcp' },
      timeoutMs: 1000,
      cardDelegation: null,
    })

    assert.equal(result.purchaseSuccess, false)
    assert.equal(result.error, 'service_not_mappable_to_mcp_capability')
  } finally {
    global.fetch = originalFetch
  }
})

test('purchaseViaMcp can succeed even when initialize is rejected', async () => {
  const originalFetch = global.fetch
  const responses = [
    createResponse(400, { error: { code: -32601, message: 'initialize not supported' } }),
    createResponse(200, {
      jsonrpc: '2.0',
      id: 3,
      result: {
        content: [{ type: 'text', text: 'search result' }],
        _meta: { success: true, txHash: '0xtx', creditsRedeemed: 1, remainingBalance: 9 },
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

  const payments = {
    plans: {
      getPlanBalance: async () => ({ isSubscriber: true, balance: 10 }),
      orderPlan: async () => ({ success: true }),
    },
    x402: {
      getX402AccessToken: async () => ({ accessToken: 'token' }),
    },
  }

  try {
    const result = await purchaseViaMcp({
      payments,
      planId: 'plan-1',
      sellerAgentId: 'agent-1',
      serviceName: 'exa_search',
      matchedOffer: {
        name: 'exa_search',
        normalized: 'exa_search',
        source: 'mcp_tools',
        capabilityKind: 'tool',
        capabilityId: 'exa_search',
        metadata: null,
      },
      normalizedEndpointUrl: 'http://localhost:3000/mcp',
      protocolDetails: { mcpUrl: 'http://localhost:3000/mcp' },
      timeoutMs: 1000,
      cardDelegation: null,
    })

    assert.equal(result.purchaseSuccess, true)
    assert.equal(result.txHash, '0xtx')
    assert.equal(result.creditsRedeemed, '1')
  } finally {
    global.fetch = originalFetch
  }
})

test('purchaseViaA2A returns failure when no matching skill is available', async () => {
  const payments = {
    plans: {
      getPlanBalance: async () => ({ isSubscriber: true, balance: 10 }),
      orderPlan: async () => ({ success: true }),
    },
    a2a: {
      getClient: async () => ({
        sendA2AMessage: async () => ({ result: { ok: true } }),
      }),
    },
  }

  const result = await purchaseViaA2A({
    payments,
    planId: 'plan-1',
    sellerAgentId: 'agent-1',
    serviceName: 'financial-modeling',
    matchedSkillName: null,
    discoveredOffers: [{ name: 'search', normalized: 'search', source: 'a2a_card', capabilityKind: null, capabilityId: null, metadata: null }],
    normalizedEndpointUrl: 'http://localhost:9000/a2a/',
    protocolDetails: { a2aBaseUrl: 'http://localhost:9000/a2a/' },
    timeoutMs: 1000,
    cardDelegation: null,
  })

  assert.equal(result.purchaseSuccess, false)
  assert.equal(result.error, 'service_not_mappable_to_a2a_skill')
})
