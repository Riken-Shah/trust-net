import assert from 'node:assert/strict'
import test from 'node:test'

import { loadBuyerAgentConfig } from '../config.js'

function createEnv(): NodeJS.ProcessEnv {
  return {
    NVM_API_KEY: 'sandbox:test-key',
    NVM_ENVIRONMENT: 'sandbox',
    OPENAI_API_KEY: 'test-openai-key',
  }
}

test('loadBuyerAgentConfig defaults includeVerifiedSellers to false', () => {
  const config = loadBuyerAgentConfig(createEnv())

  assert.equal(config.includeVerifiedSellers, false)
})

test('loadBuyerAgentConfig accepts includeVerifiedSellers override', () => {
  const config = loadBuyerAgentConfig(createEnv(), { includeVerifiedSellers: true })

  assert.equal(config.includeVerifiedSellers, true)
})
