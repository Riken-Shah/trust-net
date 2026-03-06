/**
 * Submit a real review using an actual on-chain burn tx.
 *
 * Usage:
 *   NVM_BUYER_API_KEY=sandbox:xxx NVM_PLAN_ID=plan-xxx npx tsx src/test-review-submit.ts
 */

import { Payments, type EnvironmentName } from '@nevermined-io/payments'

const payments = Payments.getInstance({
  nvmApiKey: process.env.NVM_BUYER_API_KEY!,
  environment: (process.env.NVM_ENVIRONMENT || 'sandbox') as EnvironmentName,
})

const PLAN_ID = process.env.NVM_PLAN_ID!
const SERVER_URL = process.env.SERVER_URL || 'https://trust-net-mcp.rikenshah-02.workers.dev'

// Real on-chain tx from previous settlement (get_reviews call)
const BURN_TX = '0xb26f303b86d457fef4dd68db30cdb1dc3b50d79e570651d70c9c087082172310'
const BURN_TX_FROM = '0x433705768549b21d1e681fe454a7d2ff26a22e1c'

async function main(): Promise<void> {
  console.log(`Server: ${SERVER_URL}`)

  // 1. Get an agent_id from list_agents
  const { accessToken: token1 } = await payments.x402.getX402AccessToken(PLAN_ID)
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
  const agent = items[0]
  console.log('Target agent:', agent?.agent_id, '-', agent?.name)

  if (!agent) {
    console.error('No agents found')
    return
  }

  // 2. Submit a real review
  const { accessToken: token2 } = await payments.x402.getX402AccessToken(PLAN_ID)
  console.log('\n=== submit_review ===')
  const submitResp = await fetch(`${SERVER_URL}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token2}` },
    body: JSON.stringify({
      jsonrpc: '2.0',
      method: 'tools/call',
      params: {
        name: 'submit_review',
        arguments: {
          agent_id: agent.agent_id,
          reviewer_address: BURN_TX_FROM,
          verification_tx: BURN_TX,
          score: 8,
          score_accuracy: 7,
          score_speed: 9,
          score_value: 8,
          score_reliability: 8,
          comment: 'Solid agent with fast responses and good accuracy. Great value for credits.',
        },
      },
      id: 2,
    }),
  })
  const submitResult = (await submitResp.json()) as Record<string, any>
  console.log('Status:', submitResp.status)
  if (submitResult.error) {
    console.log('Error:', JSON.stringify(submitResult.error, null, 2))
  } else {
    console.log('Review created:', submitResult.result?.content?.[0]?.text)
    console.log('Payment:', JSON.stringify(submitResult.result?._meta, null, 2))
  }

  // 3. Verify by fetching reviews
  const { accessToken: token3 } = await payments.x402.getX402AccessToken(PLAN_ID)
  console.log('\n=== get_reviews (verify) ===')
  const getResp = await fetch(`${SERVER_URL}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token3}` },
    body: JSON.stringify({
      jsonrpc: '2.0',
      method: 'tools/call',
      params: { name: 'get_reviews', arguments: { agent_id: agent.agent_id } },
      id: 3,
    }),
  })
  const getResult = (await getResp.json()) as Record<string, any>
  console.log('Status:', getResp.status)
  console.log('Reviews:', getResult.result?.content?.[0]?.text)
  console.log('Payment:', JSON.stringify(getResult.result?._meta, null, 2))
}

main().catch(console.error)
