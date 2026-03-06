/**
 * Test client for the seller agent's MCP search_agents tool.
 *
 * Usage:
 *   npx tsx src/test.ts
 */

import { config as loadDotEnv } from 'dotenv'
import { Payments, type EnvironmentName } from '@nevermined-io/payments'

loadDotEnv()

const NVM_BUYER_API_KEY = process.env.NVM_BUYER_API_KEY!
const NVM_ENVIRONMENT = (process.env.NVM_ENVIRONMENT || 'sandbox') as EnvironmentName
const PLAN_ID_USDC = '111171385715053379363820285370903002263619322296632596378198131296828952605172'
const PLAN_ID_ENV = process.env.NVM_PLAN_ID!
const SERVER_URL = process.env.SERVER_URL || 'http://localhost:8080'

async function callMcpTool(
  planId: string,
  toolName: string,
  args: Record<string, unknown>,
): Promise<void> {
  const payments = Payments.getInstance({
    nvmApiKey: NVM_BUYER_API_KEY,
    environment: NVM_ENVIRONMENT,
  })

  const { accessToken } = await payments.x402.getX402AccessToken(planId)
  console.log(`Token: ${accessToken.slice(0, 20)}...`)

  const res = await fetch(`${SERVER_URL}/mcp`, {
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
      id: 1,
    }),
  })

  console.log(`HTTP ${res.status}`)
  const text = await res.text()
  try {
    const json = JSON.parse(text)
    console.log(JSON.stringify(json, null, 2))
  } catch {
    console.log('Raw:', text.slice(0, 500))
  }
}

async function main(): Promise<void> {
  console.log(`Server: ${SERVER_URL}\n`)

  // Test 1: list_agents with .env plan (same as test-client.ts)
  console.log('=== Test 1: list_agents (.env plan) ===')
  console.log(`Plan: ${PLAN_ID_ENV}`)
  await callMcpTool(PLAN_ID_ENV, 'list_agents', {})

  // Test 2: search_agents with .env plan
  console.log('\n=== Test 2: search_agents (.env plan) ===')
  console.log(`Plan: ${PLAN_ID_ENV}`)
  await callMcpTool(PLAN_ID_ENV, 'search_agents', {
    query: 'best web search agent for market research',
    limit: 5,
  })

  // Test 3: search_agents with USDC plan
  console.log('\n=== Test 3: search_agents (USDC plan) ===')
  console.log(`Plan: ${PLAN_ID_USDC}`)
  await callMcpTool(PLAN_ID_USDC, 'search_agents', {
    query: 'best web search agent for market research',
    limit: 5,
  })
}

main().catch(console.error)
