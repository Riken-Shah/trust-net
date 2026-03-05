import { config as loadDotEnv } from 'dotenv'
import express, { type Request, type Response } from 'express'

import { closeDbPool, initDbPool, pingDb } from './index.js'

loadDotEnv()

const app = express()

function parseServicePort(rawPort: string | undefined): number {
  const fallback = '8080'
  const parsed = Number.parseInt(rawPort ?? fallback, 10)
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`DB service port must be a positive integer, received '${rawPort ?? fallback}'.`)
  }
  return parsed
}

const servicePort = parseServicePort(process.env.DB_SERVICE_PORT ?? process.env.PORT)

app.get('/health/live', (_request: Request, response: Response) => {
  response.status(200).json({
    status: 'alive',
    service: 'trust-net-db-service',
  })
})

app.get('/health/ready', async (_request: Request, response: Response) => {
  try {
    await pingDb()
    response.status(200).json({
      status: 'ready',
      service: 'trust-net-db-service',
    })
  } catch (error) {
    response.status(503).json({
      status: 'not_ready',
      service: 'trust-net-db-service',
      error: error instanceof Error ? error.message : 'Unknown DB readiness failure',
    })
  }
})

async function bootstrap(): Promise<void> {
  await initDbPool()
  await pingDb()

  const server = app.listen(servicePort, () => {
    console.log(`trust-net DB service listening on http://localhost:${servicePort}`)
  })

  let shuttingDown = false
  const gracefulShutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (shuttingDown) {
      return
    }
    shuttingDown = true

    console.log(`Received ${signal}, shutting down DB service...`)

    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error)
          return
        }
        resolve()
      })
    })

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

void bootstrap().catch(async (error) => {
  console.error('Failed to start trust-net DB service:', error)
  await closeDbPool()
  process.exit(1)
})
