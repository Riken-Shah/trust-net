import { config as loadDotEnv } from 'dotenv'
import express, { type Request, type Response } from 'express'
import { Payments, type EnvironmentName } from '@nevermined-io/payments'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'

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

const app = express()
app.use(express.json())

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

app.get('/health/live', (_request: Request, response: Response) => {
  response.status(200).json({
    status: 'alive',
    service: 'seller-agent-service',
  })
})

app.get('/health/ready', async (_request: Request, response: Response) => {
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

app.get('/health', (_request: Request, response: Response) => {
  response.status(200).json({
    status: 'ok',
    service: 'seller-agent-service',
  })
})

app.get('/api/list', async (_request: Request, response: Response) => {
  try {
    const items = await fetchAgentList()
    response.status(200).json({ items })
  } catch (error) {
    response.status(400).json({
      error: error instanceof Error ? error.message : 'Failed to list data.',
    })
  }
})

const payments = Payments.getInstance({
  nvmApiKey: process.env.NVM_API_KEY!,
  environment: (process.env.NVM_ENVIRONMENT || 'sandbox') as EnvironmentName,
})

// --- MCP server factory ---
// Creates a fresh McpServer + transport per request to support concurrent connections.
// Each request gets its own Protocol instance, avoiding "Already connected" errors.

payments.mcp.configure({
  agentId: process.env.SELLER_AGENT_ID || 'seller-agent',
  serverName: 'seller-agent-service',
})

function createMcpServerInstance(): McpServer {
  const server = new McpServer({
    name: 'seller-agent-service',
    version: '0.1.0',
  })

  const paywalledServer = payments.mcp.attach(server)

  paywalledServer.registerTool(
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
    { credits: 2n },
  )

  return server
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
  app.use('/intel', createIntelRouter(intelService))

  // MCP JSON-RPC handler — fresh McpServer per request for concurrency
  // Must be registered BEFORE the OAuth router so POST /mcp is caught here
  app.post('/mcp', async (req: Request, res: Response) => {
    try {
      if (!req.headers.accept) {
        req.headers.accept = 'application/json, text/event-stream'
      }

      const server = createMcpServerInstance()
      const transport = new StreamableHTTPServerTransport({
        enableJsonResponse: true,
      })

      await server.connect(transport as unknown as import('@modelcontextprotocol/sdk/shared/transport.js').Transport)
      await transport.handleRequest(req, res, req.body)

      // Clean up after the response is sent
      res.on('close', () => {
        void server.close().catch(() => {})
      })
    } catch (error) {
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: {
            code: -32603,
            message: error instanceof Error ? error.message : 'Internal server error',
          },
          id: req.body?.id ?? null,
        })
      }
    }
  })

  // Mount OAuth discovery routes under /mcp (well-known, health, register)
  const mcpOAuthRouter = payments.mcp.createRouter({
    baseUrl: `http://localhost:${servicePort}/mcp`,
    agentId: process.env.SELLER_AGENT_ID || 'seller-agent',
    serverName: 'seller-agent-service',
    version: '0.1.0',
    description: 'Trust-net agent directory with trust scores and marketplace data',
  })
  app.use('/mcp', mcpOAuthRouter)

  const snapshotTimer = startIntelSnapshotScheduler(
    () => intelService.captureSnapshotNow(),
    intelConfig.snapshotIntervalSeconds,
  )

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
    clearInterval(snapshotTimer)

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
