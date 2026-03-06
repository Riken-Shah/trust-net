/**
 * CLI entry point — runs marketplace sync then blockchain order scan.
 *
 * Usage:
 *   npm run ingest
 *   # or: npx tsx src/ingestion/run.ts
 */

import { config as loadDotEnv } from 'dotenv'

import { closeDbPool, getDbPool, initDbPool, pingDb } from '../index.js'
import { runMarketplaceIngestion } from './service.js'
import { runOrderScan } from './ingest.js'
import { computeTrustScores } from './trustScore.js'

loadDotEnv()

function requireEnv(name: string): string {
  const value = (process.env[name] ?? '').trim()
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`)
  }
  return value
}

async function main(): Promise<void> {
  const etherscanApiKey = requireEnv('ETHERSCAN_API_KEY')

  // ── Phase 0: DB connection ──────────────────────────────────────────────
  console.log('Connecting to database...')
  await initDbPool()
  await pingDb()
  console.log('Database connected.\n')

  const pool = getDbPool()

  // ── Phase 1: Marketplace sync ───────────────────────────────────────────
  console.log('=== Phase 1: Marketplace Sync ===')
  const marketplaceResult = await runMarketplaceIngestion(pool)

  console.log('Marketplace sync completed:')
  console.log(JSON.stringify({
    fetchedSellers: marketplaceResult.fetchedSellers,
    normalizedSellers: marketplaceResult.normalizedSellers,
    rejectedSellers: marketplaceResult.rejectedSellers,
    plansEnriched: marketplaceResult.plansEnriched,
    persisted: marketplaceResult.persisted,
  }, null, 2))

  // ── Phase 2: Blockchain order scan ──────────────────────────────────────
  console.log('\n=== Phase 2: Blockchain Order Scan ===')
  const scanResult = await runOrderScan(pool, { etherscanApiKey })

  console.log('\nOrder scan completed:')
  console.log(JSON.stringify(scanResult, null, 2))

  if (scanResult.errors.length > 0) {
    console.warn(`\n${scanResult.errors.length} wallet(s) had errors (see above).`)
  }

  // ── Phase 3: Trust score computation ────────────────────────────────────
  console.log('\n=== Phase 3: Trust Score Computation ===')
  const trustResult = await computeTrustScores(pool)

  console.log('\nTrust score computation completed:')
  console.log(JSON.stringify(trustResult, null, 2))
}

void main()
  .catch(async (error) => {
    console.error('Ingestion run failed:', error)
    await closeDbPool()
    process.exit(1)
  })
  .finally(async () => {
    await closeDbPool()
  })
