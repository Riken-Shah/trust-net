import assert from 'node:assert/strict'
import test from 'node:test'

import { getBuyerAgentUsage, parseBuyerAgentCliArgs } from '../cli.js'

test('parseBuyerAgentCliArgs enables includeVerifiedSellers when requested', () => {
  const result = parseBuyerAgentCliArgs(['--include-verified'])

  assert.equal(result.includeVerifiedSellers, true)
  assert.equal(result.help, false)
})

test('parseBuyerAgentCliArgs supports help output', () => {
  const result = parseBuyerAgentCliArgs(['-h'])

  assert.equal(result.includeVerifiedSellers, false)
  assert.equal(result.help, true)
  assert.match(getBuyerAgentUsage(), /--include-verified/)
})
