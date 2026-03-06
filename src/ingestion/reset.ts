/**
 * Reset all ingestion data — truncates orders, stats, trust scores,
 * and resets blockchain_sync checkpoints to block 0.
 *
 * Usage:
 *   npm run ingest:reset
 */

import { config as loadDotEnv } from 'dotenv'

import { closeDbPool, getDbPool, initDbPool, pingDb } from '../index.js'

loadDotEnv()

async function main(): Promise<void> {
  console.log('Connecting to database...')
  await initDbPool()
  await pingDb()

  const pool = getDbPool()

  console.log('Resetting ingestion data...')

  // Order matters due to FK constraints
  await pool.query('TRUNCATE trust_scores CASCADE')
  console.log('  Truncated trust_scores')

  await pool.query('TRUNCATE agent_computed_stats CASCADE')
  console.log('  Truncated agent_computed_stats')

  await pool.query('TRUNCATE orders CASCADE')
  console.log('  Truncated orders')

  await pool.query('UPDATE blockchain_sync SET last_block = 0, last_polled_at = NOW()')
  console.log('  Reset blockchain_sync checkpoints to block 0')

  await pool.query('TRUNCATE agent_services CASCADE')
  console.log('  Truncated agent_services')

  await pool.query('TRUNCATE blockchain_sync CASCADE')
  console.log('  Truncated blockchain_sync')

  await pool.query('TRUNCATE plans CASCADE')
  console.log('  Truncated plans')

  await pool.query('TRUNCATE agents CASCADE')
  console.log('  Truncated agents')

  console.log('\nReset complete. Run `npm run ingest` to re-populate.')
}

void main()
  .catch(async (error) => {
    console.error('Reset failed:', error)
    await closeDbPool()
    process.exit(1)
  })
  .finally(async () => {
    await closeDbPool()
  })
