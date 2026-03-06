import { config as loadDotEnv } from 'dotenv'

import { closeDbPool, getDbPool, initDbPool, pingDb } from '../index.js'
import { loadIntelRuntimeConfig } from './config.js'
import { ensureIntelSchema } from './repository.js'
import { createIntelService } from './service.js'

loadDotEnv()

async function main(): Promise<void> {
  const runtimeConfig = loadIntelRuntimeConfig()

  await initDbPool()
  await pingDb()

  const pool = getDbPool()
  await ensureIntelSchema(pool)

  const service = createIntelService(pool, {
    windowMinutes: runtimeConfig.windowMinutes,
    searchResultLimit: runtimeConfig.searchResultLimit,
    avoidFailureThreshold: runtimeConfig.avoidFailureThreshold,
  })

  const result = await service.captureSnapshotNow()
  console.log(
    JSON.stringify(
      {
        message: 'Intel snapshot capture completed',
        snapshotAt: result.snapshotAt.toISOString(),
        rowsWritten: result.inserted,
      },
      null,
      2,
    ),
  )
}

void main()
  .catch(async (error) => {
    console.error('Intel snapshot run failed:', error)
    await closeDbPool()
    process.exit(1)
  })
  .finally(async () => {
    await closeDbPool()
  })
