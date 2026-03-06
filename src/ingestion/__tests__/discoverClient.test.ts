import assert from 'node:assert/strict'
import test from 'node:test'

import { fetchDiscoverSnapshot } from '../marketplaceClient.js'

test('fetchDiscoverSnapshot sends x-nvm-api-key header', async () => {
  let capturedHeaders: Headers | null = null

  const snapshot = await fetchDiscoverSnapshot(
    {
      discoverApiUrl: 'https://example.invalid/discover',
      nvmApiKey: 'sandbox:key',
      timeoutMs: 1000,
      retryCount: 0,
    },
    async (_url, init) => {
      capturedHeaders = new Headers(init?.headers)
      return new Response(
        JSON.stringify({
          sellers: [],
          buyers: [],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    },
  )

  assert.deepEqual(snapshot, { sellers: [], buyers: [] })
  assert.ok(capturedHeaders)
  const headers = capturedHeaders as Headers
  assert.equal(headers.get('x-nvm-api-key'), 'sandbox:key')
  assert.equal(headers.get('accept'), 'application/json')
})

test('fetchDiscoverSnapshot retries retryable failures', async () => {
  let attempts = 0

  const snapshot = await fetchDiscoverSnapshot(
    {
      discoverApiUrl: 'https://example.invalid/discover',
      nvmApiKey: 'sandbox:key',
      timeoutMs: 1000,
      retryCount: 1,
    },
    async () => {
      attempts += 1
      if (attempts === 1) {
        return new Response('busy', { status: 429 })
      }
      return new Response(
        JSON.stringify({
          sellers: [],
          buyers: [],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    },
  )

  assert.equal(attempts, 2)
  assert.deepEqual(snapshot, { sellers: [], buyers: [] })
})
