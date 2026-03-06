import assert from 'node:assert/strict'
import test from 'node:test'

import { normalizeEndpointUrl } from '../endpoint.js'

test('normalizeEndpointUrl accepts full URL', () => {
  const result = normalizeEndpointUrl('https://example.com/api')
  assert.equal(result.valid, true)
  assert.equal(result.normalizedUrl, 'https://example.com/api')
})

test('normalizeEndpointUrl prefixes scheme for host-like values', () => {
  const result = normalizeEndpointUrl('localhost:3000/data')
  assert.equal(result.valid, true)
  assert.equal(result.normalizedUrl, 'http://localhost:3000/data')
})

test('normalizeEndpointUrl rejects method/path token', () => {
  const result = normalizeEndpointUrl('POST /data')
  assert.equal(result.valid, false)
  assert.match(result.reason ?? '', /method\/path/i)
})

test('normalizeEndpointUrl rejects non-url token', () => {
  const result = normalizeEndpointUrl('ask')
  assert.equal(result.valid, false)
})
