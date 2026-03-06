import postgres from 'postgres'

import { runBuyerAgentVerification } from './service.js'

async function runBuyerAgent(env: Env) {
  const sql = postgres(env.HYPERDRIVE.connectionString, {
    max: 3,
    idle_timeout: 10,
    prepare: false,
  })

  const config = {
    nvmApiKey: env.NVM_API_KEY,
    nvmEnvironment: (env.NVM_ENVIRONMENT ?? 'sandbox') as any,
    openAiApiKey: env.OPENAI_API_KEY,
    model: 'gpt-4o-mini',
    timeoutMs: 15000,
    passScore: 6,
    maxSellers: 15,
    targetSeller: null,
    includeVerifiedSellers: false,
    includeVerifiedTarget: false,
    cardDelegation: null,
  }

  try {
    const summary = await runBuyerAgentVerification(sql, config)
    return summary
  } finally {
    await sql.end()
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url)

    if (url.pathname === '/health') {
      return Response.json({ status: 'ok', service: 'trust-net-buyer' })
    }

    if (url.pathname === '/run' && request.method === 'POST') {
      const resultPromise = runBuyerAgent(env)
        .then((summary) => {
          console.log('Buyer-agent verification complete:', JSON.stringify(summary))
          return summary
        })
        .catch((err) => {
          console.error('Buyer-agent verification failed:', err)
          throw err
        })

      ctx.waitUntil(resultPromise)
      return Response.json({ status: 'started', message: 'Buyer-agent verification triggered' })
    }

    return new Response('Not found', { status: 404 })
  },

  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(
      runBuyerAgent(env)
        .then((summary) => console.log('Buyer-agent verification complete:', JSON.stringify(summary)))
        .catch((err) => console.error('Buyer-agent verification failed:', err)),
    )
  },
}
