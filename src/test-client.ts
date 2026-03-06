/**
 * Test client for the seller agent's MCP list_agents tool.
 *
 * Usage:
 *   NVM_BUYER_API_KEY=sandbox:xxx NVM_PLAN_ID=plan-xxx npx tsx src/test-client.ts
 */

import { Payments, type EnvironmentName } from '@nevermined-io/payments'

const payments = Payments.getInstance({
  nvmApiKey: process.env.NVM_BUYER_API_KEY!,
  environment: (process.env.NVM_ENVIRONMENT || 'sandbox') as EnvironmentName,
})

const PLAN_ID = process.env.NVM_PLAN_ID!
const SERVER_URL = process.env.SERVER_URL || 'https://trust-net.onrender.com'

async function main(): Promise<void> {
  if (!process.env.NVM_BUYER_API_KEY) {
    console.error('Missing NVM_BUYER_API_KEY (the buyer/subscriber key)')
    process.exit(1)
  }
  if (!PLAN_ID) {
    console.error('Missing NVM_PLAN_ID (the seller agent plan ID)')
    process.exit(1)
  }

  console.log(`Server: ${SERVER_URL}`)
  console.log(`Plan:   ${PLAN_ID}`)

  // 1. Get x402 access token using buyer's key + seller's plan
  const { accessToken } = await payments.x402.getX402AccessToken(PLAN_ID)
  console.log('Got access token:', accessToken.slice(0, 20) + '...')

  // 2. Call the list_agents MCP tool via JSON-RPC
  const response = await fetch(`${SERVER_URL}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      method: 'tools/call',
      params: {
        name: 'list_agents',
        arguments: {},
      },
      id: 1,
    }),
  })

  console.log('Status:', response.status)
  const result = (await response.json()) as Record<string, any>

  // Tool output
  console.log('Content:', JSON.stringify(result.result?.content, null, 2))

  // Payment metadata
  console.log('Payment:', JSON.stringify(result.result?._meta, null, 2))
}

main().catch(console.error)
