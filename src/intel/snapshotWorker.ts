import { config as loadDotEnv } from 'dotenv'

import { closeDbPool, getDbPool, initDbPool, pingDb } from '../index.js'
import { loadIntelRuntimeConfig } from './config.js'
import { ensureIntelSchema } from './repository.js'
import { createIntelService } from './service.js'

loadDotEnv()

async function main(): Promise<void> {
  const config = loadIntelRuntimeConfig()

  await initDbPool()
  await pingDb()

  const pool = getDbPool()
  await ensureIntelSchema(pool)

  const service = createIntelService(pool, {
    windowMinutes: config.windowMinutes,
    searchResultLimit: config.searchResultLimit,
    avoidFailureThreshold: config.avoidFailureThreshold,
  })

  let isRunning = false
  let shuttingDown = false

  const runCycle = async (): Promise<void> => {
    if (shuttingDown || isRunning) {
      return
    }

    isRunning = true
    try {
      const result = await service.captureSnapshotNow()
      console.log(
        JSON.stringify(
          {
            message: 'Intel snapshot captured',
            snapshotAt: result.snapshotAt.toISOString(),
            rowsWritten: result.inserted,
          },
          null,
          2,
        ),
      )
    } catch (error) {
      console.error('Intel snapshot capture failed:', error)
    } finally {
      isRunning = false
    }
  }

  await runCycle()

  const intervalMs = config.snapshotIntervalSeconds * 1000
  const timer = setInterval(() => {
    void runCycle()
  }, intervalMs)

  console.log(`Intel snapshot worker started. Interval=${config.snapshotIntervalSeconds}s`)

  const gracefulShutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (shuttingDown) {
      return
    }

    shuttingDown = true
    clearInterval(timer)
    console.log(`Received ${signal}. Shutting down intel snapshot worker...`)

    while (isRunning) {
      await new Promise((resolve) => {
        setTimeout(resolve, 250)
      })
    }

    await closeDbPool()
    process.exit(0)
  }

  process.once('SIGINT', () => {
    void gracefulShutdown('SIGINT')
  })
  process.once('SIGTERM', () => {
    void gracefulShutdown('SIGTERM')
  })
}

void main().catch(async (error) => {
  console.error('Failed to start intel snapshot worker:', error)
  await closeDbPool()
  process.exit(1)
})
