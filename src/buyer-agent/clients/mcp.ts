import {
  parseMcpPromptOffers,
  parseMcpResourceOffers,
  parseMcpToolOffers,
} from '../protocol.js'
import { callOpenAiJson } from '../openai.js'
import {
  type DiscoveredOffer,
  type McpCapabilityKind,
  type PurchaseResult,
} from '../types.js'

interface McpPurchaseInput {
  payments: any
  planId: string
  sellerAgentId: string | null
  serviceName: string
  matchedOfferHint: DiscoveredOffer | null
  discoveredOffers: DiscoveredOffer[]
  normalizedEndpointUrl: string
  protocolDetails: Record<string, unknown>
  timeoutMs: number
  openAiApiKey: string
  model: string
  planner?: (input: McpPlannerContext) => Promise<McpPlannerDecision>
}

interface McpDiscoveryInput {
  payments: any
  planId: string
  sellerAgentId: string | null
  normalizedEndpointUrl: string
  protocolDetails: Record<string, unknown>
  timeoutMs: number
}

interface JsonRpcResponse {
  jsonrpc?: string
  id?: string | number | null
  result?: Record<string, unknown>
  error?: Record<string, unknown>
}

interface RawMcpPlannerDecision {
  action?: unknown
  capability_kind?: unknown
  capability_id?: unknown
  arguments?: unknown
  finish_reason?: unknown
}

interface McpPlannerDecision {
  action: 'call' | 'finish'
  capabilityKind: McpCapabilityKind | null
  capabilityId: string | null
  arguments: Record<string, unknown> | null
  finishReason: string | null
}

interface McpPlannerStep {
  step: number
  decision: McpPlannerDecision | null
  request: Record<string, unknown> | null
  status: number | null
  responsePayload: unknown
  responseExcerpt: string | null
  error: string | null
}

interface McpPlannerContext {
  serviceName: string
  discoveredOffers: DiscoveredOffer[]
  matchedOfferHint: DiscoveredOffer | null
  priorSteps: McpPlannerStep[]
}

interface McpRpcCallResult {
  request: Record<string, unknown>
  status: number
  payload: JsonRpcResponse | null
  rawBody: string
}

const MCP_ACCEPT_HEADER = 'application/json, text/event-stream'
const MCP_PLANNER_MAX_STEPS = 4

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
        Accept: MCP_ACCEPT_HEADER,
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

async function ensureMcpSubscriberAccess(payments: any, planId: string): Promise<void> {
  const balance = await payments.plans.getPlanBalance(planId)
  if (!balance.isSubscriber || Number(balance.balance ?? 0) <= 0) {
    await payments.plans.orderPlan(planId)
  }
}

async function ensureMcpAuthorization(
  payments: any,
  planId: string,
  sellerAgentId: string | null,
): Promise<string> {
  const token = await payments.x402.getX402AccessToken(
    planId,
    sellerAgentId ?? undefined,
  )
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

function getOfferSummary(offer: DiscoveredOffer): Record<string, unknown> {
  return {
    capability_kind: offer.capabilityKind,
    capability_id: offer.capabilityId,
    display_name: offer.name,
    normalized_name: offer.normalized,
    source: offer.source,
    description: offer.metadata?.description ?? null,
    title: offer.metadata?.title ?? null,
    input_schema: offer.metadata?.inputSchema ?? null,
    arguments_schema: offer.metadata?.arguments ?? null,
    uri: offer.metadata?.uri ?? null,
  }
}

function serializePlannerSteps(steps: McpPlannerStep[]): Array<Record<string, unknown>> {
  return steps.map((step) => ({
    step: step.step,
    decision: step.decision,
    request: step.request,
    status: step.status,
    response_payload: step.responsePayload,
    response_excerpt: step.responseExcerpt,
    error: step.error,
  }))
}

function buildPlannerPrompt(input: McpPlannerContext): string {
  return JSON.stringify(
    {
      instructions: [
        'You are planning the next authenticated MCP JSON-RPC call needed to buy and execute the target seller service.',
        'Use only the discovered MCP capabilities listed below. Do not invent new capabilities.',
        'Capabilities may be orchestration tools. Read descriptions and schemas carefully.',
        'If the target service is not directly exposed as a capability, use intermediary capabilities to discover the correct service_id or workflow, then call the capability that executes the target service.',
        'Return strict JSON only.',
        "For another RPC call, return: {\"action\":\"call\",\"capability_kind\":\"tool|prompt|resource\",\"capability_id\":\"...\",\"arguments\":{...}}.",
        "For completion, return: {\"action\":\"finish\",\"finish_reason\":\"...\"}.",
        'Do not finish until the target seller service itself has been executed or read and the latest result contains the final service output.',
        'When previous steps reveal exact service identifiers, reuse those exact values in later calls.',
        'The MCP client already knows JSON-RPC transport details. You are choosing only which discovered capability to invoke next and with what arguments.',
      ],
      target_service: input.serviceName,
      matched_offer_hint: input.matchedOfferHint ? getOfferSummary(input.matchedOfferHint) : null,
      discovered_capabilities: input.discoveredOffers.map(getOfferSummary),
      prior_steps: serializePlannerSteps(input.priorSteps),
    },
    null,
    2,
  )
}

function normalizePlannerDecision(raw: RawMcpPlannerDecision): McpPlannerDecision {
  const action = raw.action === 'call' || raw.action === 'finish' ? raw.action : null
  if (!action) {
    throw new Error('mcp_planner_invalid_action')
  }

  if (action === 'finish') {
    return {
      action,
      capabilityKind: null,
      capabilityId: null,
      arguments: null,
      finishReason: typeof raw.finish_reason === 'string' ? raw.finish_reason.slice(0, 500) : null,
    }
  }

  const capabilityKind =
    raw.capability_kind === 'tool' || raw.capability_kind === 'prompt' || raw.capability_kind === 'resource'
      ? raw.capability_kind
      : null
  const capabilityId = typeof raw.capability_id === 'string' && raw.capability_id.trim()
    ? raw.capability_id
    : null

  if (!capabilityKind || !capabilityId) {
    throw new Error('mcp_planner_missing_capability')
  }

  const args = raw.arguments
  if (args !== undefined && (args === null || typeof args !== 'object' || Array.isArray(args))) {
    throw new Error('mcp_planner_invalid_arguments')
  }

  return {
    action,
    capabilityKind,
    capabilityId,
    arguments: (args as Record<string, unknown> | undefined) ?? null,
    finishReason: typeof raw.finish_reason === 'string' ? raw.finish_reason.slice(0, 500) : null,
  }
}

async function planNextMcpAction(
  input: McpPurchaseInput,
  context: McpPlannerContext,
): Promise<McpPlannerDecision> {
  if (input.planner) {
    return input.planner(context)
  }

  const raw = await callOpenAiJson<RawMcpPlannerDecision>(
    input.openAiApiKey,
    input.model,
    'You are a strict MCP workflow planner. Return valid JSON only.',
    buildPlannerPrompt(context),
    input.timeoutMs,
  )

  return normalizePlannerDecision(raw)
}

function findCapabilityByDecision(
  decision: McpPlannerDecision,
  discoveredOffers: DiscoveredOffer[],
): DiscoveredOffer | null {
  return discoveredOffers.find(
    (offer) => offer.capabilityKind === decision.capabilityKind && offer.capabilityId === decision.capabilityId,
  ) ?? null
}

function buildRpcRequest(
  decision: McpPlannerDecision,
  rpcId: number,
): Record<string, unknown> | null {
  if (decision.action !== 'call' || !decision.capabilityKind || !decision.capabilityId) {
    return null
  }

  if (decision.capabilityKind === 'tool') {
    return {
      jsonrpc: '2.0',
      id: rpcId,
      method: 'tools/call',
      params: {
        name: decision.capabilityId,
        arguments: decision.arguments ?? {},
      },
    }
  }

  if (decision.capabilityKind === 'prompt') {
    return {
      jsonrpc: '2.0',
      id: rpcId,
      method: 'prompts/get',
      params: {
        name: decision.capabilityId,
        arguments: decision.arguments ?? {},
      },
    }
  }

  if (decision.capabilityKind === 'resource') {
    return {
      jsonrpc: '2.0',
      id: rpcId,
      method: 'resources/read',
      params: {
        uri: decision.capabilityId,
      },
    }
  }

  return null
}

function toPlannerStepFromCall(
  step: number,
  decision: McpPlannerDecision,
  call: McpRpcCallResult,
): McpPlannerStep {
  const result = call.payload?.result
  return {
    step,
    decision,
    request: call.request,
    status: call.status,
    responsePayload: call.payload ?? call.rawBody,
    responseExcerpt: getResponseExcerpt(result) ?? call.rawBody.slice(0, 500),
    error:
      call.status >= 400
        ? `mcp_call_http_error_${call.status}`
        : (call.payload?.error ? 'mcp_call_jsonrpc_error' : null),
  }
}

function toPlannerErrorStep(
  step: number,
  decision: McpPlannerDecision | null,
  error: string,
): McpPlannerStep {
  return {
    step,
    decision,
    request: null,
    status: null,
    responsePayload: null,
    responseExcerpt: null,
    error,
  }
}

function toPurchaseResultFromCall(
  call: McpRpcCallResult,
  plannerSteps: McpPlannerStep[],
  startedAt: number,
): PurchaseResult {
  if (call.status >= 400 || !call.payload) {
    return {
      purchaseSuccess: false,
      error: `mcp_call_http_error_${call.status}`,
      httpStatus: call.status,
      latencyMs: Date.now() - startedAt,
      requestPayload: { plannerSteps: serializePlannerSteps(plannerSteps), finalRequest: call.request },
      responsePayload: { plannerSteps: serializePlannerSteps(plannerSteps), finalResponse: call.payload ?? call.rawBody },
      responseExcerpt: call.rawBody.slice(0, 500),
      txHash: null,
      creditsRedeemed: null,
      remainingBalance: null,
      paymentMeta: null,
    }
  }

  if (call.payload.error) {
    return {
      purchaseSuccess: false,
      error: 'mcp_call_jsonrpc_error',
      httpStatus: call.status,
      latencyMs: Date.now() - startedAt,
      requestPayload: { plannerSteps: serializePlannerSteps(plannerSteps), finalRequest: call.request },
      responsePayload: { plannerSteps: serializePlannerSteps(plannerSteps), finalResponse: call.payload },
      responseExcerpt: JSON.stringify(call.payload.error).slice(0, 500),
      txHash: null,
      creditsRedeemed: null,
      remainingBalance: null,
      paymentMeta: null,
    }
  }

  const result = call.payload.result
  const paymentMeta = parseMcpPaymentMeta(result)
  const success = paymentMeta?.success !== false

  return {
    purchaseSuccess: success,
    error: success ? null : String(paymentMeta?.errorReason ?? 'mcp_payment_settlement_failed'),
    httpStatus: call.status,
    latencyMs: Date.now() - startedAt,
    requestPayload: { plannerSteps: serializePlannerSteps(plannerSteps), finalRequest: call.request },
    responsePayload: { plannerSteps: serializePlannerSteps(plannerSteps), finalResponse: call.payload },
    responseExcerpt: getResponseExcerpt(result) ?? call.rawBody.slice(0, 500),
    txHash: typeof paymentMeta?.txHash === 'string' ? paymentMeta.txHash : null,
    creditsRedeemed: paymentMeta?.creditsRedeemed !== undefined ? String(paymentMeta.creditsRedeemed) : null,
    remainingBalance: paymentMeta?.remainingBalance !== undefined ? String(paymentMeta.remainingBalance) : null,
    paymentMeta,
  }
}

export async function discoverMcpCapabilities(input: McpDiscoveryInput): Promise<DiscoveredOffer[]> {
  const mcpUrl = resolveMcpUrl(input as McpPurchaseInput)
  const authorization = await ensureMcpAuthorization(
    input.payments,
    input.planId,
    input.sellerAgentId,
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
    if (input.discoveredOffers.length === 0) {
      return {
        purchaseSuccess: false,
        error: 'mcp_no_discovered_capabilities',
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

    await ensureMcpSubscriberAccess(input.payments, input.planId)
    const authorization = await ensureMcpAuthorization(
      input.payments,
      input.planId,
      input.sellerAgentId,
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
    const plannerSteps: McpPlannerStep[] = []
    let lastCall: McpRpcCallResult | null = null

    if (!initializeSucceeded && initialize.status >= 400) {
      plannerSteps.push({
        step: 0,
        decision: null,
        request: {
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
        },
        status: initialize.status,
        responsePayload: initialize.payload ?? initialize.rawBody,
        responseExcerpt: initialize.rawBody.slice(0, 500),
        error: `mcp_initialize_error_${initialize.status}`,
      })
    }

    for (let step = 1; step <= MCP_PLANNER_MAX_STEPS; step += 1) {
      let decision: McpPlannerDecision
      try {
        decision = await planNextMcpAction(input, {
          serviceName: input.serviceName,
          discoveredOffers: input.discoveredOffers,
          matchedOfferHint: input.matchedOfferHint,
          priorSteps: plannerSteps,
        })
      } catch (error) {
        return {
          purchaseSuccess: false,
          error: `mcp_planner_error:${error instanceof Error ? error.message : 'unknown_planner_error'}`,
          httpStatus: lastCall?.status ?? initialize.status,
          latencyMs: Date.now() - startedAt,
          requestPayload: { plannerSteps: serializePlannerSteps(plannerSteps), service: input.serviceName },
          responsePayload: lastCall?.payload ?? initialize.payload ?? lastCall?.rawBody ?? initialize.rawBody,
          responseExcerpt: lastCall?.rawBody?.slice(0, 500) ?? initialize.rawBody.slice(0, 500),
          txHash: null,
          creditsRedeemed: null,
          remainingBalance: null,
          paymentMeta: null,
        }
      }

      if (decision.action === 'finish') {
        if (!lastCall) {
          return {
            purchaseSuccess: false,
            error: `mcp_planner_finished_without_call:${decision.finishReason ?? 'no_finish_reason'}`,
            httpStatus: initialize.status,
            latencyMs: Date.now() - startedAt,
            requestPayload: { plannerSteps: serializePlannerSteps(plannerSteps), service: input.serviceName },
            responsePayload: initialize.payload ?? initialize.rawBody,
            responseExcerpt: initialize.rawBody.slice(0, 500),
            txHash: null,
            creditsRedeemed: null,
            remainingBalance: null,
            paymentMeta: null,
          }
        }

        return toPurchaseResultFromCall(lastCall, plannerSteps, startedAt)
      }

      const matchedOffer = findCapabilityByDecision(decision, input.discoveredOffers)
      if (!matchedOffer) {
        plannerSteps.push(
          toPlannerErrorStep(step, decision, 'mcp_planner_selected_unknown_capability'),
        )
        continue
      }

      const request = buildRpcRequest(decision, step + 1)
      if (!request) {
        plannerSteps.push(
          toPlannerErrorStep(step, decision, 'mcp_planner_selected_unsupported_rpc_shape'),
        )
        continue
      }

      const call = await callJsonRpc(
        mcpUrl,
        request,
        authorization,
        input.timeoutMs,
      )

      lastCall = {
        request,
        status: call.status,
        payload: call.payload,
        rawBody: call.rawBody,
      }
      plannerSteps.push(toPlannerStepFromCall(step, decision, lastCall))
    }

    return {
      purchaseSuccess: false,
      error: 'mcp_planner_max_steps_exceeded',
      httpStatus: lastCall?.status ?? initialize.status,
      latencyMs: Date.now() - startedAt,
      requestPayload: { plannerSteps: serializePlannerSteps(plannerSteps), service: input.serviceName },
      responsePayload: lastCall?.payload ?? initialize.payload ?? lastCall?.rawBody ?? initialize.rawBody,
      responseExcerpt: lastCall?.rawBody?.slice(0, 500) ?? initialize.rawBody.slice(0, 500),
      txHash: null,
      creditsRedeemed: null,
      remainingBalance: null,
      paymentMeta: null,
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
