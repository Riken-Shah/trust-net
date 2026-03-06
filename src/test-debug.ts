import { Payments, type EnvironmentName } from '@nevermined-io/payments'

const payments = Payments.getInstance({
  nvmApiKey: process.env.NVM_BUYER_API_KEY!,
  environment: (process.env.NVM_ENVIRONMENT || 'sandbox') as EnvironmentName,
})

async function main() {
  const { accessToken } = await payments.x402.getX402AccessToken(process.env.NVM_PLAN_ID!)
  console.log('Token:', accessToken.slice(0, 40) + '...')

  const res = await fetch(
    (process.env.SERVER_URL || 'https://trust-net-mcp.rikenshah-02.workers.dev') + '/mcp',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'tools/call',
        params: { name: 'list_agents', arguments: {} },
        id: 1,
      }),
    },
  )

  console.log('Status:', res.status)
  console.log('Headers:', Object.fromEntries(res.headers.entries()))
  const body = await res.text()
  console.log('Body:', body)
}

main().catch(console.error)
