import { config as loadDotEnv } from 'dotenv'
import express, { type Request, type Response } from 'express'

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

type JsonRpcId = string | number | null

interface JsonRpcRequestBody {
  jsonrpc?: unknown
  id?: JsonRpcId
  method?: unknown
  params?: unknown
}

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
    COALESCE(ts.review_count, 0) AS review_count,
    COALESCE((
      SELECT jsonb_agg(
        jsonb_build_object(
          'plan_id', p.nvm_plan_id,
          'plan_name', p.name,
          'plan_type', p.plan_type,
          'pricing_type', p.pricing_type,
          'price_amount', p.price_amount,
          'token_symbol', p.token_symbol,
          'fiat_amount_cents', p.fiat_amount_cents,
          'network', p.network,
          'credits_granted', p.credits_granted,
          'credits_per_call', p.credits_per_call,
          'duration_seconds', p.duration_seconds,
          'service_name', s.name,
          'service_description', s.description
        )
        ORDER BY COALESCE(s.name, ''), p.nvm_plan_id
      )
      FROM agent_services s
      JOIN plans p ON p.nvm_plan_id = s.nvm_plan_id
      WHERE s.agent_id = a.id
      AND s.is_active = TRUE
      AND p.is_active = TRUE
    ), '[]'::jsonb) AS offers,
    COALESCE((
      SELECT SUM(COALESCE(acs.total_orders, 0))
      FROM agent_computed_stats acs
      WHERE acs.agent_id = a.id
      AND acs.event_type = 'order'
    ), 0) AS total_orders,
    COALESCE((
      SELECT SUM(COALESCE(acs.unique_buyers, 0))
      FROM agent_computed_stats acs
      WHERE acs.agent_id = a.id
      AND acs.event_type = 'order'
    ), 0) AS unique_buyers,
    COALESCE((
      SELECT SUM(COALESCE(acs.total_requests, 0))
      FROM agent_computed_stats acs
      WHERE acs.agent_id = a.id
      AND acs.event_type = 'burn'
    ), 0) AS total_requests,
    COALESCE((
      SELECT SUM(COALESCE(acs.successful_burns, 0))
      FROM agent_computed_stats acs
      WHERE acs.agent_id = a.id
      AND acs.event_type = 'burn'
    ), 0) AS successful_burns,
    COALESCE((
      SELECT SUM(COALESCE(acs.failed_burns, 0))
      FROM agent_computed_stats acs
      WHERE acs.agent_id = a.id
      AND acs.event_type = 'burn'
    ), 0) AS failed_burns,
    COALESCE((
      SELECT SUM(COALESCE(acs.total_credits_burned, 0))
      FROM agent_computed_stats acs
      WHERE acs.agent_id = a.id
      AND acs.event_type = 'burn'
    ), 0) AS total_credits_burned,
    COALESCE((
      SELECT AVG(r.score)::numeric
      FROM reviews r
      WHERE r.agent_id = a.id
    ), 0) AS average_review_score,
    (
      SELECT MAX(acs.last_event_at)
      FROM agent_computed_stats acs
      WHERE acs.agent_id = a.id
    ) AS last_activity_at
  FROM agents a
  LEFT JOIN trust_scores ts ON ts.agent_id = a.id
  WHERE a.is_active = TRUE
  ORDER BY COALESCE(ts.trust_score, 0) DESC, a.name ASC
`

function sendJsonRpcResult(response: Response, id: JsonRpcId, result: unknown): void {
  response.status(200).json({
    jsonrpc: '2.0',
    id,
    result,
  })
}

function sendJsonRpcError(
  response: Response,
  id: JsonRpcId,
  code: number,
  message: string,
  data?: unknown,
): void {
  response.status(200).json({
    jsonrpc: '2.0',
    id,
    error: {
      code,
      message,
      ...(data === undefined ? {} : { data }),
    },
  })
}

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
    service: 'trust-net-db-service',
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

app.post('/mcp', async (request: Request, response: Response) => {
  const body = request.body as JsonRpcRequestBody
  const requestId: JsonRpcId = body?.id ?? null

  if (body?.jsonrpc !== '2.0' || typeof body?.method !== 'string') {
    sendJsonRpcError(response, requestId, -32600, 'Invalid Request')
    return
  }

  if (body.method === 'initialize') {
    sendJsonRpcResult(response, requestId, {
      protocolVersion: '2024-11-05',
      capabilities: {
        tools: {},
      },
      serverInfo: {
        name: 'trust-net-db-service',
        version: '0.1.0',
      },
    })
    return
  }

  if (body.method === 'tools/list') {
    sendJsonRpcResult(response, requestId, {
      tools: [
        {
          name: 'list_agents',
          description: 'List all agents with trust, plan, service, and computed stats data.',
          inputSchema: {
            type: 'object',
            properties: {},
            additionalProperties: false,
          },
        },
      ],
    })
    return
  }

  if (body.method === 'tools/call') {
    const params = body.params as { name?: unknown }
    if (params?.name !== 'list_agents') {
      sendJsonRpcError(response, requestId, -32602, 'Unknown tool name.')
      return
    }

    try {
      const items = await fetchAgentList()
      sendJsonRpcResult(response, requestId, {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ items }, null, 2),
          },
        ],
        structuredContent: { items },
      })
    } catch (error) {
      sendJsonRpcError(
        response,
        requestId,
        -32000,
        'Failed to execute list_agents tool.',
        error instanceof Error ? error.message : 'Unknown error',
      )
    }
    return
  }

  sendJsonRpcError(response, requestId, -32601, `Method not found: ${body.method}`)
})

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
