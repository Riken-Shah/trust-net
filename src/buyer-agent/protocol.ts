import { normalizeServiceName } from './offers.js'
import { type DiscoveredOffer, type ProtocolDetectionResult } from './types.js'

interface JsonRpcResponse {
  jsonrpc?: string
  id?: number | string | null
  result?: Record<string, unknown>
  error?: Record<string, unknown>
}

interface ResponseBody {
  rawText: string
  json: unknown | null
}

function dedupeOffers(offers: DiscoveredOffer[]): DiscoveredOffer[] {
  const map = new Map<string, DiscoveredOffer>()
  for (const offer of offers) {
    const key = offer.capabilityKind && offer.capabilityId
      ? `${offer.capabilityKind}:${offer.capabilityId}`
      : offer.normalized
    if (!key) {
      continue
    }
    if (!map.has(key)) {
      map.set(key, offer)
    }
  }
  return [...map.values()]
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController()
  const timeout = setTimeout(() => {
    controller.abort()
  }, timeoutMs)

  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
    })
  } finally {
    clearTimeout(timeout)
  }
}

async function readResponseBody(response: Response): Promise<ResponseBody> {
  const rawText = await response.text()

  if (!rawText) {
    return { rawText, json: null }
  }

  try {
    return {
      rawText,
      json: JSON.parse(rawText),
    }
  } catch {
    return { rawText, json: null }
  }
}

function parseSkillOffers(agentCard: Record<string, unknown>): DiscoveredOffer[] {
  const skills = Array.isArray(agentCard.skills) ? agentCard.skills : []

  const offers: DiscoveredOffer[] = []
  for (const skill of skills) {
    if (!skill || typeof skill !== 'object') {
      continue
    }

    const maybeName = (skill as { name?: unknown; id?: unknown }).name
    const maybeId = (skill as { name?: unknown; id?: unknown }).id
    const rawName = typeof maybeName === 'string' && maybeName.trim()
      ? maybeName
      : (typeof maybeId === 'string' ? maybeId : null)

    if (!rawName) {
      continue
    }

    offers.push({
      name: rawName,
      normalized: normalizeServiceName(rawName),
      source: 'a2a_card',
      capabilityKind: null,
      capabilityId: null,
      metadata: null,
    })
  }

  return dedupeOffers(offers)
}

function parseMcpToolOffers(json: JsonRpcResponse): DiscoveredOffer[] {
  const tools = Array.isArray(json.result?.tools) ? json.result?.tools : []
  const offers: DiscoveredOffer[] = []

  for (const tool of tools) {
    if (!tool || typeof tool !== 'object') {
      continue
    }

    const name = (tool as { name?: unknown }).name
    if (typeof name !== 'string' || !name.trim()) {
      continue
    }

    offers.push({
      name,
      normalized: normalizeServiceName(name),
      source: 'mcp_tools',
      capabilityKind: 'tool',
      capabilityId: name,
      metadata:
        tool && typeof tool === 'object'
          ? ((tool as { inputSchema?: unknown }).inputSchema && typeof (tool as { inputSchema?: unknown }).inputSchema === 'object'
              ? { inputSchema: (tool as { inputSchema?: unknown }).inputSchema as Record<string, unknown> }
              : null)
          : null,
    })
  }

  return dedupeOffers(offers)
}

function parseMcpPromptOffers(json: JsonRpcResponse): DiscoveredOffer[] {
  const prompts = Array.isArray(json.result?.prompts) ? json.result?.prompts : []
  const offers: DiscoveredOffer[] = []

  for (const prompt of prompts) {
    if (!prompt || typeof prompt !== 'object') {
      continue
    }

    const name = (prompt as { name?: unknown }).name
    if (typeof name !== 'string' || !name.trim()) {
      continue
    }

    const argumentsList = Array.isArray((prompt as { arguments?: unknown }).arguments)
      ? ((prompt as { arguments?: unknown }).arguments as Array<Record<string, unknown>>)
      : null

    offers.push({
      name,
      normalized: normalizeServiceName(name),
      source: 'mcp_prompts',
      capabilityKind: 'prompt',
      capabilityId: name,
      metadata: argumentsList ? { arguments: argumentsList } : null,
    })
  }

  return dedupeOffers(offers)
}

function parseMcpResourceOffers(json: JsonRpcResponse): DiscoveredOffer[] {
  const resources = Array.isArray(json.result?.resources) ? json.result?.resources : []
  const offers: DiscoveredOffer[] = []

  for (const resource of resources) {
    if (!resource || typeof resource !== 'object') {
      continue
    }

    const uri = (resource as { uri?: unknown }).uri
    if (typeof uri !== 'string' || !uri.trim()) {
      continue
    }

    const explicitName = (resource as { name?: unknown; title?: unknown }).name
    const title = (resource as { name?: unknown; title?: unknown }).title
    const displayName = typeof explicitName === 'string' && explicitName.trim()
      ? explicitName
      : (typeof title === 'string' && title.trim() ? title : uri)

    offers.push({
      name: displayName,
      normalized: normalizeServiceName(displayName),
      source: 'mcp_resources',
      capabilityKind: 'resource',
      capabilityId: uri,
      metadata: { uri },
    })
  }

  return dedupeOffers(offers)
}

function parsePricingOffers(payload: unknown): DiscoveredOffer[] {
  if (!payload || typeof payload !== 'object') {
    return []
  }

  const record = payload as { tiers?: unknown }
  const tiers = record.tiers
  const offers: DiscoveredOffer[] = []

  if (Array.isArray(tiers)) {
    for (const tier of tiers) {
      if (!tier || typeof tier !== 'object') {
        continue
      }
      const tool = (tier as { tool?: unknown; name?: unknown }).tool
      const name = (tier as { tool?: unknown; name?: unknown }).name
      const candidate = typeof tool === 'string' && tool.trim()
        ? tool
        : (typeof name === 'string' ? name : null)
      if (!candidate) {
        continue
      }
      offers.push({
        name: candidate,
        normalized: normalizeServiceName(candidate),
        source: 'x402_pricing',
        capabilityKind: null,
        capabilityId: null,
        metadata: null,
      })
    }

    return dedupeOffers(offers)
  }

  if (!tiers || typeof tiers !== 'object') {
    return []
  }

  for (const [tierName, tierValue] of Object.entries(tiers)) {
    if (!tierValue || typeof tierValue !== 'object') {
      continue
    }

    const tool = (tierValue as { tool?: unknown }).tool
    const candidate = typeof tool === 'string' && tool.trim() ? tool : tierName
    if (!candidate) {
      continue
    }

    offers.push({
      name: candidate,
      normalized: normalizeServiceName(candidate),
      source: 'x402_pricing',
      capabilityKind: null,
      capabilityId: null,
      metadata: null,
    })
  }

  return dedupeOffers(offers)
}

function getPathBasedCardUrl(endpoint: URL): string | null {
  if (endpoint.pathname === '/') {
    return null
  }

  const basePath = endpoint.pathname.endsWith('/') ? endpoint.pathname : `${endpoint.pathname}/`
  return new URL(`${basePath}.well-known/agent.json`, endpoint.origin).toString()
}

function getPathBasedWellKnownUrl(endpoint: URL, suffix: string): string | null {
  if (endpoint.pathname === '/') {
    return null
  }

  const basePath = endpoint.pathname.endsWith('/') ? endpoint.pathname : `${endpoint.pathname}/`
  return new URL(`${basePath}.well-known/${suffix}`, endpoint.origin).toString()
}

function getMcpCandidates(endpoint: URL): string[] {
  const candidates: string[] = []

  if (endpoint.pathname === '/mcp' || endpoint.pathname.endsWith('/mcp')) {
    candidates.push(endpoint.toString())
  }

  candidates.push(new URL('/mcp', endpoint.origin).toString())

  return [...new Set(candidates)]
}

function getX402PaidProbeUrl(endpoint: URL): string {
  if (endpoint.pathname !== '/') {
    return endpoint.toString()
  }

  return new URL('/data', endpoint.origin).toString()
}

function isMcpAuthorizationRequired(response: Response, body: ResponseBody): boolean {
  if (response.status !== 401 && response.status !== 403) {
    return false
  }

  const wwwAuthenticate = response.headers.get('www-authenticate')?.toLowerCase() ?? ''
  if (wwwAuthenticate.includes('bearer')) {
    return true
  }

  const bodyText = body.rawText.toLowerCase()
  return bodyText.includes('authorization') || bodyText.includes('unauthorized') || bodyText.includes('bearer')
}

async function fetchWellKnownJson(
  candidates: string[],
  timeoutMs: number,
): Promise<Record<string, unknown> | null> {
  for (const candidate of [...new Set(candidates)]) {
    try {
      const response = await fetchWithTimeout(candidate, { method: 'GET' }, timeoutMs)
      if (!response.ok) {
        continue
      }

      const body = await response.json()
      if (body && typeof body === 'object') {
        return body as Record<string, unknown>
      }
    } catch {
      // Continue to next candidate.
    }
  }

  return null
}

async function probeMcpAuthMetadata(
  endpoint: URL,
  timeoutMs: number,
): Promise<Record<string, unknown> | null> {
  const protectedResource = await fetchWellKnownJson(
    [
      new URL('/.well-known/oauth-protected-resource', endpoint.origin).toString(),
      getPathBasedWellKnownUrl(endpoint, 'oauth-protected-resource'),
    ].filter((value): value is string => value !== null),
    timeoutMs,
  )

  const authorizationServer = await fetchWellKnownJson(
    [new URL('/.well-known/oauth-authorization-server', endpoint.origin).toString()],
    timeoutMs,
  )

  if (!protectedResource && !authorizationServer) {
    return null
  }

  const scopesSupported = Array.isArray(protectedResource?.scopes_supported)
    ? protectedResource.scopes_supported
    : []
  const hasMcpScope = scopesSupported.some(
    (scope) => typeof scope === 'string' && scope.toLowerCase().startsWith('mcp:'),
  )
  const hasAuthorizationServers = Array.isArray(protectedResource?.authorization_servers)
    && protectedResource.authorization_servers.length > 0
  const hasTokenEndpoint = typeof authorizationServer?.token_endpoint === 'string'

  if (!hasMcpScope && !hasAuthorizationServers && !hasTokenEndpoint) {
    return null
  }

  return {
    authProtected: true,
    oauthProtectedResource: protectedResource,
    oauthAuthorizationServer: authorizationServer,
  }
}

async function probeA2A(endpoint: URL, timeoutMs: number): Promise<ProtocolDetectionResult | null> {
  const candidates = [
    new URL('/.well-known/agent.json', endpoint.origin).toString(),
    getPathBasedCardUrl(endpoint),
  ].filter((value): value is string => value !== null)

  for (const cardUrl of [...new Set(candidates)]) {
    try {
      const response = await fetchWithTimeout(cardUrl, { method: 'GET' }, timeoutMs)
      if (!response.ok) {
        continue
      }

      const body = await response.json()
      if (!body || typeof body !== 'object') {
        continue
      }

      const agentCard = body as Record<string, unknown>
      const hasIdentity = typeof agentCard.name === 'string' || typeof agentCard.description === 'string'
      if (!hasIdentity) {
        continue
      }

      const discoveredOffers = parseSkillOffers(agentCard)
      const cardBaseUrl = cardUrl.replace(/\.well-known\/agent\.json$/, '')

      return {
        protocol: 'a2a',
        reason: 'a2a_agent_card_detected',
        discoveredOffers,
        details: {
          a2aBaseUrl: cardBaseUrl,
          agentCard,
        },
      }
    } catch {
      // Continue to next candidate.
    }
  }

  return null
}

async function probeMcp(endpoint: URL, timeoutMs: number): Promise<ProtocolDetectionResult | null> {
  const candidates = getMcpCandidates(endpoint)
  for (const mcpUrl of candidates) {
    try {
      const initializeResponse = await fetchWithTimeout(
        mcpUrl,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'initialize',
            params: {
              protocolVersion: '2025-03-26',
              capabilities: {},
              clientInfo: { name: 'buyer-agent-verifier', version: '0.1.0' },
            },
          }),
        },
        timeoutMs,
      )

      const initializeBody = await readResponseBody(initializeResponse)

      if (!initializeResponse.ok) {
        if (isMcpAuthorizationRequired(initializeResponse, initializeBody)) {
          const authMetadata = await probeMcpAuthMetadata(endpoint, timeoutMs)
          if (authMetadata) {
            return {
              protocol: 'mcp',
              reason: 'mcp_auth_protected_resource_detected',
              discoveredOffers: [],
              details: {
                mcpUrl,
                ...authMetadata,
              },
            }
          }
        }

        continue
      }

      const initializeJson = initializeBody.json as JsonRpcResponse | null
      if (!initializeJson || initializeJson.jsonrpc !== '2.0') {
        continue
      }

      const listMethods = ['tools/list', 'prompts/list', 'resources/list'] as const
      const discoveredOffers: DiscoveredOffer[] = []
      let rpcId = 2

      for (const method of listMethods) {
        const listResponse = await fetchWithTimeout(
          mcpUrl,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              jsonrpc: '2.0',
              id: rpcId,
              method,
              params: {},
            }),
          },
          timeoutMs,
        )

        rpcId += 1
        if (!listResponse.ok) {
          continue
        }

        const listJson = (await listResponse.json()) as JsonRpcResponse
        if (method === 'tools/list') {
          discoveredOffers.push(...parseMcpToolOffers(listJson))
        }
        if (method === 'prompts/list') {
          discoveredOffers.push(...parseMcpPromptOffers(listJson))
        }
        if (method === 'resources/list') {
          discoveredOffers.push(...parseMcpResourceOffers(listJson))
        }
      }

      return {
        protocol: 'mcp',
        reason: 'mcp_initialize_detected',
        discoveredOffers: dedupeOffers(discoveredOffers),
        details: {
          mcpUrl,
        },
      }
    } catch {
      // Continue to next candidate.
    }
  }

  return null
}

async function probePricing(url: string, timeoutMs: number): Promise<DiscoveredOffer[]> {
  try {
    const response = await fetchWithTimeout(url, { method: 'GET' }, timeoutMs)
    if (!response.ok) {
      return []
    }
    const body = await response.json()
    return parsePricingOffers(body)
  } catch {
    return []
  }
}

async function probeX402(endpoint: URL, timeoutMs: number): Promise<ProtocolDetectionResult | null> {
  const paidProbeUrl = getX402PaidProbeUrl(endpoint)
  const pricingUrl = new URL('/pricing', endpoint.origin).toString()

  try {
    const response = await fetchWithTimeout(
      paidProbeUrl,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: 'protocol probe' }),
      },
      timeoutMs,
    )

    if (response.status === 402 && response.headers.get('payment-required')) {
      const discoveredOffers = await probePricing(pricingUrl, timeoutMs)
      return {
        protocol: 'x402_http',
        reason: 'x402_402_payment_required_detected',
        discoveredOffers,
        details: {
          paidUrl: paidProbeUrl,
          pricingUrl,
        },
      }
    }
  } catch {
    // Continue to pricing probe.
  }

  const discoveredOffers = await probePricing(pricingUrl, timeoutMs)
  if (discoveredOffers.length > 0) {
    return {
      protocol: 'x402_http',
      reason: 'x402_pricing_contract_detected',
      discoveredOffers,
      details: {
        paidUrl: paidProbeUrl,
        pricingUrl,
      },
    }
  }

  return null
}

export async function detectSellerProtocol(
  normalizedEndpointUrl: string,
  timeoutMs: number,
): Promise<ProtocolDetectionResult> {
  const endpoint = new URL(normalizedEndpointUrl)

  const a2a = await probeA2A(endpoint, timeoutMs)
  if (a2a) {
    return a2a
  }

  const mcp = await probeMcp(endpoint, timeoutMs)
  if (mcp) {
    return mcp
  }

  const x402 = await probeX402(endpoint, timeoutMs)
  if (x402) {
    return x402
  }

  return {
    protocol: 'unknown',
    reason: 'unknown_protocol',
    discoveredOffers: [],
    details: {},
  }
}

export { parsePricingOffers, parseMcpPromptOffers, parseMcpResourceOffers, parseMcpToolOffers }
