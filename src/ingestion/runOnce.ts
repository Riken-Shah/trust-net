import { config as loadDotEnv } from 'dotenv'

import { closeDbPool, getDbPool, initDbPool, pingDb } from '../index.js'
import { runMarketplaceIngestion } from './service.js'

loadDotEnv()

function logRunResult(prefix: string, result: Awaited<ReturnType<typeof runMarketplaceIngestion>>): void {
  console.log(`${prefix} ingestion completed`) 
  console.log(
    JSON.stringify(
      {
        fetchedSellers: result.fetchedSellers,
        normalizedSellers: result.normalizedSellers,
        rejectedSellers: result.rejectedSellers,
        uniquePlansDiscovered: result.uniquePlansDiscovered,
        plansEnriched: result.plansEnriched,
        plansEnrichmentFailed: result.plansEnrichmentFailed,
        persisted: result.persisted,
        startedAt: result.startedAt.toISOString(),
        finishedAt: result.finishedAt.toISOString(),
      },
      null,
      2,
    ),
  )
}

async function main(): Promise<void> {
  await initDbPool()
  await pingDb()

  const result = await runMarketplaceIngestion(getDbPool())
  logRunResult('Marketplace', result)
}

void main()
  .catch(async (error) => {
    console.error('Marketplace ingestion run failed:', error)
    await closeDbPool()
    process.exit(1)
  })
  .finally(async () => {
    await closeDbPool()
  })
