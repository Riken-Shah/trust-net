/**
 * Test client for the seller agent's MCP tools (list_agents + search_agents).
 *
 * Usage:
 *   NVM_BUYER_API_KEY=sandbox:xxx NVM_PLAN_ID=plan-xxx npx tsx src/test-client.ts
 *   NVM_BUYER_API_KEY=sandbox:xxx NVM_PLAN_ID=plan-xxx npx tsx src/test-client.ts search "web search agent"
 */

import { Payments, type EnvironmentName } from '@nevermined-io/payments'

const payments = Payments.getInstance({
  nvmApiKey: process.env.NVM_BUYER_API_KEY!,
  environment: (process.env.NVM_ENVIRONMENT || 'sandbox') as EnvironmentName,
})

const PLAN_ID = process.env.NVM_PLAN_ID!
const SERVER_URL = process.env.SERVER_URL || 'https://trust-net.onrender.com'

async function callTool(
  accessToken: string,
  toolName: string,
  args: Record<string, unknown>,
  id: number,
): Promise<void> {
  console.log(`\n--- ${toolName} ---`)

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
      params: { name: toolName, arguments: args },
      id,
    }),
  })

  console.log('Status:', response.status)
  const result = (await response.json()) as Record<string, any>
  console.log('Content:', JSON.stringify(result.result?.content, null, 2))
  console.log('Payment:', JSON.stringify(result.result?._meta, null, 2))

  if (result.error) {
    console.log('Error:', JSON.stringify(result.error, null, 2))
  }
}

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

  // Parse CLI args: "search <query>" runs only search_agents, otherwise runs both
  const cliArgs = process.argv.slice(2)
  const searchOnly = cliArgs[0] === 'search'
  const searchQuery = searchOnly ? cliArgs.slice(1).join(' ') || 'web search agent' : 'web search agent'

  // Get x402 access token
  const { accessToken } = await payments.x402.getX402AccessToken(PLAN_ID)
  console.log('Got access token:', accessToken.slice(0, 20) + '...')

  if (!searchOnly) {
    // Test list_agents
    await callTool(accessToken, 'list_agents', {}, 1)
  }

  // Test search_agents
  console.log(`\nSearch query: "${searchQuery}"`)

  // Need a fresh token for the second call
  const { accessToken: searchToken } = await payments.x402.getX402AccessToken(PLAN_ID)
  await callTool(searchOnly ? accessToken : searchToken, 'search_agents', { query: searchQuery, limit: 5 }, 2)
}

main().catch(console.error)
