import assert from 'node:assert/strict'
import test from 'node:test'

import { parseMcpPaymentMeta } from '../clients/mcp.js'
import { decodePaymentResponseHeader } from '../clients/x402.js'

test('decodePaymentResponseHeader decodes valid base64 JSON', () => {
  const encoded = Buffer.from(JSON.stringify({ creditsRedeemed: '2', transaction: '0xtx' })).toString('base64')
  const decoded = decodePaymentResponseHeader(encoded)
  assert.equal(decoded?.creditsRedeemed, '2')
  assert.equal(decoded?.transaction, '0xtx')
})

test('decodePaymentResponseHeader returns null on malformed value', () => {
  assert.equal(decodePaymentResponseHeader('not-base64'), null)
})

test('parseMcpPaymentMeta extracts _meta object', () => {
  const meta = parseMcpPaymentMeta({
    _meta: {
      success: true,
      txHash: '0xabc',
      creditsRedeemed: '1',
    },
  })

  assert.equal(meta?.txHash, '0xabc')
})
