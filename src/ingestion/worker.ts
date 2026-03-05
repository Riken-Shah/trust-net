import { config as loadDotEnv } from 'dotenv'

import { closeDbPool, getDbPool, initDbPool, pingDb } from '../index.js'
import { loadIngestionConfig } from './config.js'
import { runMarketplaceIngestion } from './service.js'

loadDotEnv()

async function main(): Promise<void> {
  const config = loadIngestionConfig()
  await initDbPool()
  await pingDb()

  let isRunning = false
  let shuttingDown = false

  const runCycle = async (): Promise<void> => {
    if (shuttingDown || isRunning) {
      return
    }

    isRunning = true
    const cycleStartedAt = new Date().toISOString()

    try {
      const result = await runMarketplaceIngestion(getDbPool(), { config })
      console.log(
        JSON.stringify(
          {
            message: 'Marketplace ingestion cycle finished',
            cycleStartedAt,
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
    } catch (error) {
      console.error('Marketplace ingestion cycle failed:', error)
    } finally {
      isRunning = false
    }
  }

  await runCycle()

  const intervalMs = config.intervalSeconds * 1000
  const timer = setInterval(() => {
    void runCycle()
  }, intervalMs)

  console.log(`Marketplace ingestion worker started. Interval=${config.intervalSeconds}s`) 

  const gracefulShutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (shuttingDown) {
      return
    }

    shuttingDown = true
    clearInterval(timer)
    console.log(`Received ${signal}. Shutting down ingestion worker...`)

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
  console.error('Failed to start marketplace ingestion worker:', error)
  await closeDbPool()
  process.exit(1)
})
