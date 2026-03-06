import { config as loadDotEnv } from 'dotenv'
import express, { type Request, type Response } from 'express'
import { Payments, type EnvironmentName } from '@nevermined-io/payments'

import {
  closeDbPool,
  createIntelRouter,
  createIntelService,
  ensureIntelSchema,
  getDbPool,
  initDbPool,
  loadIntelRuntimeConfig,
  pingDb,
} from './index.js'

loadDotEnv()

const LIST_AGENTS_SQL = `
  SELECT
    a.id AS agent_id,
    a.team_name,
    a.name,
    a.description,
    a.category,
    a.keywords,
    a.marketplace_ready,
    a.endpoint_url,
    COALESCE(ts.trust_score, 0) AS trust_score,
    ts.tier,
    COALESCE(ts.review_count, 0) AS review_count
  FROM agents a
  LEFT JOIN trust_scores ts ON ts.agent_id = a.id
  WHERE a.is_active = TRUE
  ORDER BY COALESCE(ts.trust_score, 0) DESC, a.name ASC
`

async function fetchAgentList(): Promise<Record<string, unknown>[]> {
  const pool = getDbPool()
  const listResult = await pool.query<Record<string, unknown>>(LIST_AGENTS_SQL)
  return listResult.rows
}

function parseServicePort(rawPort: string | undefined): number {
  const fallback = '8080'
  const parsed = Number.parseInt(rawPort ?? fallback, 10)
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`DB service port must be a positive integer, received '${rawPort ?? fallback}'.`)
  }
  return parsed
}

const servicePort = parseServicePort(process.env.DB_SERVICE_PORT ?? process.env.PORT)

const payments = Payments.getInstance({
  nvmApiKey: process.env.NVM_API_KEY!,
  environment: (process.env.NVM_ENVIRONMENT || 'sandbox') as EnvironmentName,
})

payments.mcp.registerTool(
  'list_agents',
  {
    title: 'List Agents',
    description: 'List all agents with trust scores, payment plans, service info, and computed stats.',
  },
  async () => {
    const items = await fetchAgentList()
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({ items }, null, 2),
        },
      ],
    }
  },
  { credits: 1n },
)

function startIntelSnapshotScheduler(
  capture: () => Promise<{ snapshotAt: Date; inserted: number }>,
  intervalSeconds: number,
): NodeJS.Timeout {
  const runCycle = async (): Promise<void> => {
    try {
      const result = await capture()
      console.log(
        JSON.stringify(
          {
            message: 'Intel in-process snapshot captured',
            snapshotAt: result.snapshotAt.toISOString(),
            rowsWritten: result.inserted,
          },
          null,
          2,
        ),
      )
    } catch (error) {
      console.error('Intel in-process snapshot capture failed:', error)
    }
  }

  void runCycle()
  const intervalMs = intervalSeconds * 1000
  return setInterval(() => {
    void runCycle()
  }, intervalMs)
}

async function bootstrap(): Promise<void> {
  const intelConfig = loadIntelRuntimeConfig()

  await initDbPool()
  await pingDb()

  const pool = getDbPool()
  await ensureIntelSchema(pool)

  const intelService = createIntelService(pool, {
    windowMinutes: intelConfig.windowMinutes,
    searchResultLimit: intelConfig.searchResultLimit,
    avoidFailureThreshold: intelConfig.avoidFailureThreshold,
  })

  // Start the MCP server as the primary server on the main port.
  // It handles OAuth discovery, session management, and JSON-RPC transport.
  const { info: mcpInfo, stop: stopMcp } = await payments.mcp.start({
    port: servicePort,
    agentId: process.env.SELLER_AGENT_ID || 'seller-agent',
    serverName: 'seller-agent-service',
    baseUrl: process.env.MCP_BASE_URL || `http://localhost:${servicePort}`,
    version: '0.1.0',
    description: 'Trust-net agent directory with trust scores and marketplace data',
  })
  console.log(`MCP server running at ${mcpInfo.baseUrl}/mcp (tools: ${mcpInfo.tools.join(', ')})`)

  // Mount additional REST endpoints on a secondary Express app.
  const restApp = express()
  restApp.use(express.json())

  restApp.get('/health/live', (_request: Request, response: Response) => {
    response.status(200).json({
      status: 'alive',
      service: 'seller-agent-service',
    })
  })

  restApp.get('/health/ready', async (_request: Request, response: Response) => {
    try {
      await pingDb()
      response.status(200).json({
        status: 'ready',
        service: 'seller-agent-service',
      })
    } catch (error) {
      response.status(503).json({
        status: 'not_ready',
        service: 'seller-agent-service',
        error: error instanceof Error ? error.message : 'Unknown DB readiness failure',
      })
    }
  })

  restApp.get('/api/list', async (_request: Request, response: Response) => {
    try {
      const items = await fetchAgentList()
      response.status(200).json({ items })
    } catch (error) {
      response.status(400).json({
        error: error instanceof Error ? error.message : 'Failed to list data.',
      })
    }
  })

  restApp.use('/intel', createIntelRouter(intelService))

  const restPort = servicePort + 1
  const restServer = restApp.listen(restPort, () => {
    console.log(`REST API listening on http://localhost:${restPort}`)
  })

  const snapshotTimer = startIntelSnapshotScheduler(
    () => intelService.captureSnapshotNow(),
    intelConfig.snapshotIntervalSeconds,
  )

  let shuttingDown = false
  const gracefulShutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (shuttingDown) {
      return
    }
    shuttingDown = true

    console.log(`Received ${signal}, shutting down...`)
    clearInterval(snapshotTimer)
    await stopMcp()

    await new Promise<void>((resolve, reject) => {
      restServer.close((error) => {
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
  console.error('Failed to start seller-agent-service:', error)
  await closeDbPool()
  process.exit(1)
})
