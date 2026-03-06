import { config as loadDotEnv } from 'dotenv'

import { closeDbPool, getDbPool, initDbPool, pingDb } from '../index.js'
import { loadBuyerAgentConfig } from './config.js'
import { runBuyerAgentVerification } from './service.js'

loadDotEnv()

async function main(): Promise<void> {
  const config = loadBuyerAgentConfig()

  await initDbPool()
  await pingDb()

  const summary = await runBuyerAgentVerification(getDbPool(), config)
  console.log(
    JSON.stringify(
      {
        message: 'Buyer-agent verification run completed',
        summary,
      },
      null,
      2,
    ),
  )
}

void main()
  .catch(async (error) => {
    console.error('Buyer-agent verification run failed:', error)
    await closeDbPool()
    process.exit(1)
  })
  .finally(async () => {
    await closeDbPool()
  })
