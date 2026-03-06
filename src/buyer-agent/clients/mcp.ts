import { normalizeServiceName } from '../offers.js'
import {
  parseMcpPromptOffers,
  parseMcpResourceOffers,
  parseMcpToolOffers,
} from '../protocol.js'
import { type CardDelegation, type DiscoveredOffer, type PurchaseResult } from '../types.js'

interface McpPurchaseInput {
  payments: any
  planId: string
  sellerAgentId: string | null
  serviceName: string
  matchedOffer: DiscoveredOffer | null
  normalizedEndpointUrl: string
  protocolDetails: Record<string, unknown>
  timeoutMs: number
  cardDelegation: CardDelegation | null
}

interface McpDiscoveryInput {
  payments: any
  planId: string
  sellerAgentId: string | null
  normalizedEndpointUrl: string
  protocolDetails: Record<string, unknown>
  timeoutMs: number
  cardDelegation: CardDelegation | null
}

interface JsonRpcResponse {
  jsonrpc?: string
  id?: string | number | null
  result?: Record<string, unknown>
  error?: Record<string, unknown>
}

function resolveMcpUrl(input: McpPurchaseInput): string {
  const explicit = input.protocolDetails.mcpUrl
  if (typeof explicit === 'string' && explicit.trim()) {
    return explicit
  }

  const endpoint = new URL(input.normalizedEndpointUrl)
  if (endpoint.pathname === '/mcp' || endpoint.pathname.endsWith('/mcp')) {
    return endpoint.toString()
  }

  return new URL('/mcp', endpoint.origin).toString()
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => {
    controller.abort()
  }, timeoutMs)

  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
    })
  } finally {
    clearTimeout(timer)
  }
}

async function callJsonRpc(
  mcpUrl: string,
  body: Record<string, unknown>,
  authorization: string,
  timeoutMs: number,
): Promise<{ status: number; payload: JsonRpcResponse | null; rawBody: string }> {
  const response = await fetchWithTimeout(
    mcpUrl,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: authorization,
      },
      body: JSON.stringify(body),
    },
    timeoutMs,
  )

  const rawBody = await response.text()
  let payload: JsonRpcResponse | null = null
  try {
    payload = rawBody ? (JSON.parse(rawBody) as JsonRpcResponse) : null
  } catch {
    payload = null
  }

  return {
    status: response.status,
    payload,
    rawBody,
  }
}

function listToolNames(payload: JsonRpcResponse | null): string[] {
  if (!payload || !payload.result || !Array.isArray(payload.result.tools)) {
    return []
  }

  const names: string[] = []
  for (const tool of payload.result.tools) {
    if (!tool || typeof tool !== 'object') {
      continue
    }
    const name = (tool as { name?: unknown }).name
    if (typeof name === 'string' && name.trim()) {
      names.push(name)
    }
  }

  return names
}

function getResponseExcerpt(result: Record<string, unknown> | undefined): string | null {
  const content = result?.content
  if (!Array.isArray(content) || content.length === 0) {
    const messages = result?.messages
    if (Array.isArray(messages) && messages.length > 0) {
      return JSON.stringify(messages[0]).slice(0, 500)
    }

    const contents = result?.contents
    if (Array.isArray(contents) && contents.length > 0) {
      return JSON.stringify(contents[0]).slice(0, 500)
    }

    return result ? JSON.stringify(result).slice(0, 500) : null
  }

  const first = content[0]
  if (!first || typeof first !== 'object') {
    return JSON.stringify(content[0]).slice(0, 500)
  }

  const text = (first as { text?: unknown }).text
  if (typeof text === 'string') {
    return text.slice(0, 500)
  }

  return JSON.stringify(first).slice(0, 500)
}

function parseMcpPaymentMeta(result: Record<string, unknown> | undefined): Record<string, unknown> | null {
  const meta = result?._meta
  if (!meta || typeof meta !== 'object') {
    return null
  }
  return meta as Record<string, unknown>
}

async function ensureMcpAuthorization(
  payments: any,
  planId: string,
  sellerAgentId: string | null,
  cardDelegation: CardDelegation | null = null,
): Promise<string> {
  // With card delegation, the facilitator handles charging — skip orderPlan
  if (!cardDelegation) {
    const balance = await payments.plans.getPlanBalance(planId)
    if (!balance.isSubscriber || Number(balance.balance ?? 0) <= 0) {
      const orderResult = await payments.plans.orderPlan(planId)
      if (orderResult && !orderResult.success) {
        throw new Error('mcp_plan_order_failed')
      }
    }
  }

  const tokenOptions = cardDelegation
    ? {
        scheme: 'nvm:card-delegation' as any,
        delegationConfig: {
          providerPaymentMethodId: cardDelegation.paymentMethodId,
          spendingLimitCents: cardDelegation.spendingLimitCents,
          durationSecs: cardDelegation.durationSecs,
        },
      }
    : undefined

  let token: any
  if (sellerAgentId) {
    try {
      token = await payments.x402.getX402AccessToken(
        planId, sellerAgentId, undefined, undefined, undefined, tokenOptions,
      )
    } catch {
      // Agent ID might not exist on Nevermined — retry without it
      token = await payments.x402.getX402AccessToken(
        planId, undefined, undefined, undefined, undefined, tokenOptions,
      )
    }
  } else {
    token = await payments.x402.getX402AccessToken(
      planId, undefined, undefined, undefined, undefined, tokenOptions,
    )
  }
  const accessToken = token.accessToken
  if (!accessToken || typeof accessToken !== 'string') {
    throw new Error('mcp_token_generation_failed')
  }

  return `Bearer ${accessToken}`
}

function dedupeOffers(offers: DiscoveredOffer[]): DiscoveredOffer[] {
  const deduped = new Map<string, DiscoveredOffer>()
  for (const offer of offers) {
    const key = offer.capabilityKind && offer.capabilityId
      ? `${offer.capabilityKind}:${offer.capabilityId}`
      : `${offer.source}:${offer.normalized}`
    if (!deduped.has(key)) {
      deduped.set(key, offer)
    }
  }
  return [...deduped.values()]
}

function buildToolArguments(offer: DiscoveredOffer, serviceName: string): Record<string, unknown> {
  const schema = offer.metadata?.inputSchema
  if (!schema || typeof schema !== 'object') {
    return { query: `Please execute '${serviceName}'.`, service: serviceName }
  }

  const properties = (schema as { properties?: unknown }).properties
  const required = Array.isArray((schema as { required?: unknown }).required)
    ? ((schema as { required?: unknown }).required as string[])
    : []

  if (!properties || typeof properties !== 'object') {
    return required.length > 0 ? Object.fromEntries(required.map((name) => [name, serviceName])) : {}
  }

  const args: Record<string, unknown> = {}
  for (const field of required) {
    const fieldSchema = (properties as Record<string, unknown>)[field]
    if (!fieldSchema || typeof fieldSchema !== 'object') {
      args[field] = serviceName
      continue
    }

    const record = fieldSchema as { type?: unknown; enum?: unknown }
    if (Array.isArray(record.enum) && record.enum.length > 0) {
      args[field] = record.enum[0]
      continue
    }

    switch (record.type) {
      case 'number':
      case 'integer':
        args[field] = 1
        break
      case 'boolean':
        args[field] = true
        break
      case 'array':
        args[field] = [serviceName]
        break
      case 'object':
        args[field] = {}
        break
      default:
        args[field] = serviceName
        break
    }
  }

  return args
}

function buildPromptArguments(offer: DiscoveredOffer, serviceName: string): Record<string, unknown> {
  const argumentsList = Array.isArray(offer.metadata?.arguments)
    ? (offer.metadata?.arguments as Array<Record<string, unknown>>)
    : []

  const args: Record<string, unknown> = {}
  for (const arg of argumentsList) {
    const name = typeof arg.name === 'string' ? arg.name : null
    const required = arg.required !== false
    if (!name || !required) {
      continue
    }
    args[name] = serviceName
  }

  return args
}

function buildCallRequest(offer: DiscoveredOffer, serviceName: string): Record<string, unknown> | null {
  if (offer.capabilityKind === 'tool') {
    return {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: {
        name: offer.capabilityId ?? offer.name,
        arguments: buildToolArguments(offer, serviceName),
      },
    }
  }

  if (offer.capabilityKind === 'prompt') {
    return {
      jsonrpc: '2.0',
      id: 3,
      method: 'prompts/get',
      params: {
        name: offer.capabilityId ?? offer.name,
        arguments: buildPromptArguments(offer, serviceName),
      },
    }
  }

  if (offer.capabilityKind === 'resource') {
    return {
      jsonrpc: '2.0',
      id: 3,
      method: 'resources/read',
      params: {
        uri: offer.capabilityId ?? offer.name,
      },
    }
  }

  return null
}

export async function discoverMcpCapabilities(input: McpDiscoveryInput): Promise<DiscoveredOffer[]> {
  const mcpUrl = resolveMcpUrl(input as McpPurchaseInput)
  const authorization = await ensureMcpAuthorization(
    input.payments,
    input.planId,
    input.sellerAgentId,
    input.cardDelegation,
  )

  await callJsonRpc(
    mcpUrl,
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'buyer-agent-verifier', version: '0.1.0' },
      },
    },
    authorization,
    input.timeoutMs,
  ).catch(() => null)

  const offers: DiscoveredOffer[] = []
  const listMethods = [
    ['tools/list', parseMcpToolOffers],
    ['prompts/list', parseMcpPromptOffers],
    ['resources/list', parseMcpResourceOffers],
  ] as const

  let rpcId = 2
  for (const [method, parser] of listMethods) {
    try {
      const response = await callJsonRpc(
        mcpUrl,
        {
          jsonrpc: '2.0',
          id: rpcId,
          method,
          params: {},
        },
        authorization,
        input.timeoutMs,
      )
      rpcId += 1

      if (response.status >= 400 || !response.payload) {
        continue
      }

      offers.push(...parser(response.payload))
    } catch {
      // Continue to next list method.
    }
  }

  return dedupeOffers(offers)
}

export async function purchaseViaMcp(input: McpPurchaseInput): Promise<PurchaseResult> {
  const startedAt = Date.now()
  const mcpUrl = resolveMcpUrl(input)

  try {
    if (!input.matchedOffer) {
      return {
        purchaseSuccess: false,
        error: 'service_not_mappable_to_mcp_capability',
        httpStatus: null,
        latencyMs: Date.now() - startedAt,
        requestPayload: { mcpUrl, service: input.serviceName },
        responsePayload: null,
        responseExcerpt: null,
        txHash: null,
        creditsRedeemed: null,
        remainingBalance: null,
        paymentMeta: null,
      }
    }

    const authorization = await ensureMcpAuthorization(
      input.payments,
      input.planId,
      input.sellerAgentId,
      input.cardDelegation,
    )

    const initialize = await callJsonRpc(
      mcpUrl,
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'buyer-agent-verifier', version: '0.1.0' },
        },
      },
      authorization,
      input.timeoutMs,
    )

    const initializeSucceeded = initialize.status < 400 && initialize.payload?.jsonrpc === '2.0'
    const callRequest = buildCallRequest(input.matchedOffer, input.serviceName)
    if (!callRequest) {
      return {
        purchaseSuccess: false,
        error: 'unsupported_mcp_capability_kind',
        httpStatus: initialize.status,
        latencyMs: Date.now() - startedAt,
        requestPayload: { mcpUrl, service: input.serviceName, matchedOffer: input.matchedOffer },
        responsePayload: initialize.payload ?? initialize.rawBody,
        responseExcerpt: initialize.rawBody.slice(0, 500),
        txHash: null,
        creditsRedeemed: null,
        remainingBalance: null,
        paymentMeta: null,
      }
    }

    if (!initializeSucceeded && initialize.status >= 400) {
      const method = typeof callRequest.method === 'string' ? callRequest.method : 'unknown'
      if (method !== 'tools/call' && method !== 'prompts/get' && method !== 'resources/read') {
        return {
          purchaseSuccess: false,
          error: `mcp_initialize_error_${initialize.status}`,
          httpStatus: initialize.status,
          latencyMs: Date.now() - startedAt,
          requestPayload: callRequest,
          responsePayload: initialize.payload ?? initialize.rawBody,
          responseExcerpt: initialize.rawBody.slice(0, 500),
          txHash: null,
          creditsRedeemed: null,
          remainingBalance: null,
          paymentMeta: null,
        }
      }
    }

    const callResponse = await callJsonRpc(
      mcpUrl,
      callRequest,
      authorization,
      input.timeoutMs,
    )

    if (callResponse.status >= 400 || !callResponse.payload) {
      return {
        purchaseSuccess: false,
        error: `mcp_tool_call_http_error_${callResponse.status}`,
        httpStatus: callResponse.status,
        latencyMs: Date.now() - startedAt,
        requestPayload: callRequest,
        responsePayload: callResponse.payload ?? callResponse.rawBody,
        responseExcerpt: callResponse.rawBody.slice(0, 500),
        txHash: null,
        creditsRedeemed: null,
        remainingBalance: null,
        paymentMeta: null,
      }
    }

    if (callResponse.payload.error) {
      return {
        purchaseSuccess: false,
        error: 'mcp_tool_call_jsonrpc_error',
        httpStatus: callResponse.status,
        latencyMs: Date.now() - startedAt,
        requestPayload: callRequest,
        responsePayload: callResponse.payload,
        responseExcerpt: JSON.stringify(callResponse.payload.error).slice(0, 500),
        txHash: null,
        creditsRedeemed: null,
        remainingBalance: null,
        paymentMeta: null,
      }
    }

    const result = callResponse.payload.result
    const paymentMeta = parseMcpPaymentMeta(result)
    const success = paymentMeta?.success !== false

    return {
      purchaseSuccess: success,
      error: success ? null : String(paymentMeta?.errorReason ?? 'mcp_payment_settlement_failed'),
      httpStatus: callResponse.status,
      latencyMs: Date.now() - startedAt,
      requestPayload: callRequest,
      responsePayload: callResponse.payload,
      responseExcerpt: getResponseExcerpt(result),
      txHash: typeof paymentMeta?.txHash === 'string' ? paymentMeta.txHash : null,
      creditsRedeemed: paymentMeta?.creditsRedeemed !== undefined ? String(paymentMeta.creditsRedeemed) : null,
      remainingBalance: paymentMeta?.remainingBalance !== undefined ? String(paymentMeta.remainingBalance) : null,
      paymentMeta,
    }
  } catch (error) {
    return {
      purchaseSuccess: false,
      error: error instanceof Error ? `mcp_exception:${error.message}` : 'mcp_exception',
      httpStatus: null,
      latencyMs: Date.now() - startedAt,
      requestPayload: { mcpUrl, service: input.serviceName },
      responsePayload: null,
      responseExcerpt: null,
      txHash: null,
      creditsRedeemed: null,
      remainingBalance: null,
      paymentMeta: null,
    }
  }
}

export { parseMcpPaymentMeta }
