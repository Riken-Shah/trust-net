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

const app = express()
app.use(express.json())

type JsonRpcId = string | number | null

interface JsonRpcRequestBody {
  jsonrpc?: unknown
  id?: JsonRpcId
  method?: unknown
  params?: unknown
}

interface SearchQueryProfile {
  inputQuery: string
  normalizedQuery: string
  terms: string[]
  usedLlm: boolean
}

const SEARCH_LLM_ENABLED = (process.env.SEARCH_LLM_ENABLED ?? 'false').trim().toLowerCase() === 'true'
const SEARCH_LLM_MODEL = (process.env.SEARCH_LLM_MODEL ?? 'gpt-4o-mini').trim()
const SEARCH_LLM_TIMEOUT_MS = Number.parseInt(process.env.SEARCH_LLM_TIMEOUT_MS ?? '4000', 10)
const OPENAI_API_KEY = (process.env.OPENAI_API_KEY ?? '').trim()

const LIST_AGENTS_SQL = `
  SELECT
    a.id AS agent_id,
    a.name,
    a.team_name,
    a.description,
    a.category,
    a.endpoint_url,
    COALESCE(ts.trust_score, 0) AS trust_score,
    ts.tier,
    COALESCE(ts.review_count, 0) AS review_count
  FROM agents a
  LEFT JOIN trust_scores ts ON ts.agent_id = a.id
  WHERE a.is_active = TRUE
  AND COALESCE(a.marketplace_ready, FALSE) = TRUE
  AND a.endpoint_url IS NOT NULL
  AND BTRIM(a.endpoint_url) <> ''
  AND a.endpoint_url ~* '^https?://'
  AND a.endpoint_url !~* '(^https?://)?(localhost|127\\.0\\.0\\.1|0\\.0\\.0\\.0)([:/]|$)'
  AND a.endpoint_url !~* '\\.local([:/]|$)'
  ORDER BY COALESCE(ts.trust_score, 0) DESC, a.name ASC
`

async function fetchAgentList(): Promise<Record<string, unknown>[]> {
  const pool = getDbPool()
  const listResult = await pool.query<Record<string, unknown>>(LIST_AGENTS_SQL)
  return listResult.rows
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function tokenizeQuery(value: string): string[] {
  return Array.from(
    new Set(
      value
        .toLowerCase()
        .split(/[^a-z0-9]+/i)
        .map((token) => token.trim())
        .filter((token) => token.length >= 2),
    ),
  )
}

async function normalizeSearchQuery(rawQuery: string): Promise<SearchQueryProfile> {
  const inputQuery = normalizeWhitespace(rawQuery)
  const fallbackTerms = tokenizeQuery(inputQuery)
  const fallbackProfile: SearchQueryProfile = {
    inputQuery,
    normalizedQuery: inputQuery,
    terms: fallbackTerms,
    usedLlm: false,
  }

  if (inputQuery.length === 0) {
    throw new Error('Search query cannot be empty.')
  }
  if (!SEARCH_LLM_ENABLED || OPENAI_API_KEY.length === 0) {
    return fallbackProfile
  }

  const controller = new AbortController()
  const timeout = Number.isInteger(SEARCH_LLM_TIMEOUT_MS) && SEARCH_LLM_TIMEOUT_MS > 0
    ? SEARCH_LLM_TIMEOUT_MS
    : 4000
  const timeoutId = setTimeout(() => {
    controller.abort()
  }, timeout)

  try {
    const completionResponse = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: SEARCH_LLM_MODEL,
        temperature: 0,
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content:
              'You normalize marketplace agent search queries. Return strict JSON with keys normalized_query (string) and terms (string[]). Keep terms concise and relevant.',
          },
          {
            role: 'user',
            content: inputQuery,
          },
        ],
      }),
      signal: controller.signal,
    })

    if (!completionResponse.ok) {
      return fallbackProfile
    }

    const completionJson = await completionResponse.json() as {
      choices?: Array<{ message?: { content?: string } }>
    }
    const content = completionJson.choices?.[0]?.message?.content
    if (typeof content !== 'string' || content.trim().length === 0) {
      return fallbackProfile
    }

    const parsed = JSON.parse(content) as {
      normalized_query?: unknown
      terms?: unknown
    }

    const normalizedQueryRaw = typeof parsed.normalized_query === 'string'
      ? normalizeWhitespace(parsed.normalized_query)
      : inputQuery
    const normalizedQuery = normalizedQueryRaw.length > 0 ? normalizedQueryRaw : inputQuery

    const termsRaw = Array.isArray(parsed.terms) ? parsed.terms : []
    const terms = Array.from(
      new Set(
        termsRaw
          .filter((value): value is string => typeof value === 'string')
          .map((value) => value.toLowerCase().trim())
          .filter((value) => value.length >= 2),
      ),
    )

    return {
      inputQuery,
      normalizedQuery,
      terms: terms.length > 0 ? terms : tokenizeQuery(normalizedQuery),
      usedLlm: true,
    }
  } catch (error) {
    return fallbackProfile
  } finally {
    clearTimeout(timeoutId)
  }
}

async function searchAgents(rawQuery: string): Promise<{
  items: Record<string, unknown>[]
}> {
  const profile = await normalizeSearchQuery(rawQuery)
  const wildcardQuery = `%${profile.normalizedQuery}%`

  const searchSql = `
    WITH scored AS (
      SELECT
        a.id AS agent_id,
        a.name,
        a.team_name,
        a.description,
        a.category,
        a.endpoint_url,
        COALESCE(ts.trust_score, 0) AS trust_score,
        ts.tier,
        COALESCE(ts.review_count, 0) AS review_count,
        (
          CASE WHEN a.name ILIKE $1 THEN 8 ELSE 0 END
          + CASE WHEN COALESCE(a.description, '') ILIKE $1 THEN 4 ELSE 0 END
          + CASE WHEN COALESCE(a.category, '') ILIKE $1 THEN 5 ELSE 0 END
          + CASE WHEN COALESCE(a.team_name, '') ILIKE $1 THEN 3 ELSE 0 END
          + CASE WHEN COALESCE(array_to_string(a.keywords, ' '), '') ILIKE $1 THEN 6 ELSE 0 END
          + COALESCE((
              SELECT SUM(
                CASE WHEN a.name ILIKE '%' || t || '%' THEN 3 ELSE 0 END
                + CASE WHEN COALESCE(a.description, '') ILIKE '%' || t || '%' THEN 2 ELSE 0 END
                + CASE WHEN COALESCE(a.category, '') ILIKE '%' || t || '%' THEN 2 ELSE 0 END
                + CASE WHEN COALESCE(a.team_name, '') ILIKE '%' || t || '%' THEN 1 ELSE 0 END
                + CASE WHEN COALESCE(array_to_string(a.keywords, ' '), '') ILIKE '%' || t || '%' THEN 2 ELSE 0 END
              )
              FROM unnest($2::text[]) AS t
            ), 0)
        )::numeric AS match_score
      FROM agents a
      LEFT JOIN trust_scores ts ON ts.agent_id = a.id
      WHERE a.is_active = TRUE
      AND COALESCE(a.marketplace_ready, FALSE) = TRUE
      AND a.endpoint_url IS NOT NULL
      AND BTRIM(a.endpoint_url) <> ''
      AND a.endpoint_url ~* '^https?://'
      AND a.endpoint_url !~* '(^https?://)?(localhost|127\\.0\\.0\\.1|0\\.0\\.0\\.0)([:/]|$)'
      AND a.endpoint_url !~* '\\.local([:/]|$)'
    )
    SELECT
      agent_id,
      name,
      team_name,
      description,
      category,
      endpoint_url,
      trust_score,
      tier,
      review_count
    FROM scored
    WHERE match_score > 0
    ORDER BY match_score DESC, trust_score DESC, review_count DESC, name ASC
  `

  const pool = getDbPool()
  const queryTerms = profile.terms.length > 0 ? profile.terms : tokenizeQuery(profile.normalizedQuery)
  const searchResult = await pool.query<Record<string, unknown>>(searchSql, [wildcardQuery, queryTerms])

  return { items: searchResult.rows }
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

app.get('/api/search', async (request: Request, response: Response) => {
  const q = typeof request.query.q === 'string' ? normalizeWhitespace(request.query.q) : ''
  if (q.length === 0) {
    response.status(400).json({ error: 'Missing required query param: q' })
    return
  }

  try {
    const result = await searchAgents(q)
    response.status(200).json(result)
  } catch (error) {
    response.status(400).json({
      error: error instanceof Error ? error.message : 'Failed to search agents.',
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
          description: 'List active hackathon agents with summary metadata and trust score.',
          inputSchema: {
            type: 'object',
            properties: {},
            additionalProperties: false,
          },
        },
        {
          name: 'search_agents',
          description:
            'Search agents from a natural language query using optional LLM normalization and deterministic ranking.',
          inputSchema: {
            type: 'object',
            properties: {
              q: {
                type: 'string',
                description: 'Natural language query, e.g. "weather agent for market research"',
              },
            },
            required: ['q'],
            additionalProperties: false,
          },
        },
      ],
    })
    return
  }

  if (body.method === 'tools/call') {
    const params = body.params as { name?: unknown; arguments?: unknown }
    if (params?.name !== 'list_agents' && params?.name !== 'search_agents') {
      sendJsonRpcError(response, requestId, -32602, 'Unknown tool name.')
      return
    }

    if (params?.name === 'list_agents') {
      try {
        const items = await fetchAgentList()
        sendJsonRpcResult(response, requestId, {
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

    if (params?.name === 'search_agents') {
      const args = (params.arguments ?? {}) as { q?: unknown }
      const q = typeof args.q === 'string' ? normalizeWhitespace(args.q) : ''
      if (q.length === 0) {
        sendJsonRpcError(response, requestId, -32602, 'search_agents requires a non-empty q.')
        return
      }

      try {
        const result = await searchAgents(q)
        sendJsonRpcResult(response, requestId, {
          structuredContent: result,
        })
      } catch (error) {
        sendJsonRpcError(
          response,
          requestId,
          -32000,
          'Failed to execute search_agents tool.',
          error instanceof Error ? error.message : 'Unknown error',
        )
      }
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

  restApp.get('/api/search', async (request: Request, response: Response) => {
    const q = typeof request.query.q === 'string' ? normalizeWhitespace(request.query.q) : ''
    if (q.length === 0) {
      response.status(400).json({ error: 'Missing required query param: q' })
      return
    }

    try {
      const result = await searchAgents(q)
      response.status(200).json(result)
    } catch (error) {
      response.status(400).json({
        error: error instanceof Error ? error.message : 'Failed to search agents.',
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
