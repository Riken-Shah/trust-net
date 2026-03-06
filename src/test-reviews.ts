/**
 * Test client for review tools (submit_review, get_reviews).
 *
 * Usage:
 *   NVM_BUYER_API_KEY=sandbox:xxx NVM_PLAN_ID=plan-xxx npx tsx src/test-reviews.ts
 */

import { Payments, type EnvironmentName } from '@nevermined-io/payments'

const payments = Payments.getInstance({
  nvmApiKey: process.env.NVM_BUYER_API_KEY!,
  environment: (process.env.NVM_ENVIRONMENT || 'sandbox') as EnvironmentName,
})

const PLAN_ID = process.env.NVM_PLAN_ID!
const SERVER_URL = process.env.SERVER_URL || 'https://trust-net-mcp.rikenshah-02.workers.dev'

async function main(): Promise<void> {
  if (!process.env.NVM_BUYER_API_KEY || !PLAN_ID) {
    console.error('Missing NVM_BUYER_API_KEY or NVM_PLAN_ID')
    process.exit(1)
  }

  console.log(`Server: ${SERVER_URL}`)
  console.log(`Plan:   ${PLAN_ID}`)

  // 1. Get token and call list_agents to get an agent_id
  const { accessToken: token1 } = await payments.x402.getX402AccessToken(PLAN_ID)
  console.log('Got token:', token1.slice(0, 30) + '...')

  console.log('\n=== list_agents ===')
  const listResp = await fetch(`${SERVER_URL}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token1}` },
    body: JSON.stringify({
      jsonrpc: '2.0',
      method: 'tools/call',
      params: { name: 'list_agents', arguments: {} },
      id: 1,
    }),
  })
  const listResult = (await listResp.json()) as Record<string, any>
  const items = JSON.parse(listResult.result?.content?.[0]?.text || '{}').items || []
  const agentId = items[0]?.agent_id
  console.log('Status:', listResp.status)
  console.log('Agent count:', items.length)
  console.log('First agent:', agentId, '-', items[0]?.name)
  console.log('Payment:', JSON.stringify(listResult.result?._meta))

  if (!agentId) {
    console.log('No agents found, cannot test reviews.')
    return
  }

  // 2. get_reviews (payment-protected)
  const { accessToken: token2 } = await payments.x402.getX402AccessToken(PLAN_ID)
  console.log('\n=== get_reviews ===')
  const getResp = await fetch(`${SERVER_URL}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token2}` },
    body: JSON.stringify({
      jsonrpc: '2.0',
      method: 'tools/call',
      params: { name: 'get_reviews', arguments: { agent_id: agentId } },
      id: 2,
    }),
  })
  const getResult = (await getResp.json()) as Record<string, any>
  console.log('Status:', getResp.status)
  console.log('Result:', JSON.stringify(getResult.result?.content?.[0]?.text, null, 2))
  console.log('Payment:', JSON.stringify(getResult.result?._meta))
  if (getResult.error) console.log('Error:', JSON.stringify(getResult.error))

  // 3. submit_review with fake tx (should pass payment but fail tx verification)
  const { accessToken: token3 } = await payments.x402.getX402AccessToken(PLAN_ID)
  console.log('\n=== submit_review (fake tx - expect tx verification failure) ===')
  const submitResp = await fetch(`${SERVER_URL}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token3}` },
    body: JSON.stringify({
      jsonrpc: '2.0',
      method: 'tools/call',
      params: {
        name: 'submit_review',
        arguments: {
          agent_id: agentId,
          reviewer_address: '0x29Bd558D38a078572a0ae0339B02c71a2F6562c8',
          verification_tx: '0x0000000000000000000000000000000000000000000000000000000000000000',
          score: 8,
          comment: 'Test review',
        },
      },
      id: 3,
    }),
  })
  const submitResult = (await submitResp.json()) as Record<string, any>
  console.log('Status:', submitResp.status)
  if (submitResult.error) {
    console.log('Error (expected):', JSON.stringify(submitResult.error))
  } else {
    console.log('Result:', JSON.stringify(submitResult.result))
  }
}

main().catch(console.error)
