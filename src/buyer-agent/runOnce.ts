import { config as loadDotEnv } from 'dotenv'

import { closeDbPool, getDbPool, initDbPool, pingDb } from '../index.js'
import { getBuyerAgentUsage, parseBuyerAgentCliArgs } from './cli.js'
import { loadBuyerAgentConfig } from './config.js'
import { runBuyerAgentVerification } from './service.js'

loadDotEnv()

async function main(): Promise<void> {
  const cliOptions = parseBuyerAgentCliArgs(process.argv.slice(2))
  if (cliOptions.help) {
    console.log(getBuyerAgentUsage())
    return
  }

  const config = loadBuyerAgentConfig(process.env, {
    includeVerifiedSellers: cliOptions.includeVerifiedSellers,
  })

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
  .then(async () => {
    await closeDbPool()
    process.exit(0)
  })
  .catch(async (error) => {
    console.error('Buyer-agent verification run failed:', error)
    await closeDbPool()
    process.exit(1)
  })
