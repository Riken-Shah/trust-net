import { type CardDelegation, type PurchaseResult } from '../types.js'

interface X402PurchaseInput {
  payments: any
  planId: string
  sellerAgentId: string | null
  serviceName: string
  normalizedEndpointUrl: string
  protocolDetails: Record<string, unknown>
  timeoutMs: number
  cardDelegation: CardDelegation | null
}

function decodePaymentResponseHeader(value: string | null): Record<string, unknown> | null {
  if (!value) {
    return null
  }

  try {
    const decoded = Buffer.from(value, 'base64').toString('utf-8')
    const parsed = JSON.parse(decoded)
    if (parsed && typeof parsed === 'object') {
      return parsed as Record<string, unknown>
    }
    return null
  } catch {
    return null
  }
}

function getTextExcerpt(payload: unknown): string | null {
  if (typeof payload === 'string') {
    return payload.slice(0, 500)
  }

  if (!payload || typeof payload !== 'object') {
    return null
  }

  const record = payload as Record<string, unknown>
  const response = record.response
  if (typeof response === 'string') {
    return response.slice(0, 500)
  }

  return JSON.stringify(payload).slice(0, 500)
}

function buildPayloadFromSimpleError(errorBody: string, serviceName: string, paidUrl: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(errorBody)
    const errorMsg = typeof parsed?.error === 'string' ? parsed.error : typeof parsed?.message === 'string' ? parsed.message : null
    if (!errorMsg) {
      return null
    }

    // Match patterns like "field_name is required" or "missing field_name"
    const requiredMatch = errorMsg.match(/^(\w+)\s+is\s+required$/i)
      ?? errorMsg.match(/^missing\s+(?:required\s+)?(?:field:?\s+)?(\w+)$/i)
    if (!requiredMatch) {
      return null
    }

    const field = requiredMatch[1]
    const defaults: Record<string, string> = {
      endpoint_url: paidUrl,
      url: paidUrl,
      query: `Please provide the '${serviceName}' service output.`,
      service: serviceName,
      agent_url: paidUrl,
    }
    return { [field]: defaults[field] ?? serviceName }
  } catch {
    return null
  }
}

function buildPayloadFromValidationError(errorBody: string, serviceName: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(errorBody)
    const detail = Array.isArray(parsed?.detail) ? parsed.detail : null
    if (!detail || detail.length === 0) {
      return null
    }

    const payload: Record<string, unknown> = {}
    for (const entry of detail) {
      if (!entry || typeof entry !== 'object') {
        continue
      }
      const loc = Array.isArray(entry.loc) ? entry.loc : []
      // Only handle body fields (skip query/path params)
      if (loc[0] !== 'body') {
        continue
      }
      const fieldName = loc[loc.length - 1]
      if (typeof fieldName !== 'string') {
        continue
      }
      payload[fieldName] = `Please provide the '${serviceName}' service output.`
    }

    return Object.keys(payload).length > 0 ? payload : null
  } catch {
    return null
  }
}

function buildGetUrlFromValidationError(baseUrl: string, errorBody: string, serviceName: string): string | null {
  try {
    const parsed = JSON.parse(errorBody)
    const detail = Array.isArray(parsed?.detail) ? parsed.detail : null
    if (!detail || detail.length === 0) {
      return null
    }

    const url = new URL(baseUrl)
    for (const entry of detail) {
      if (!entry || typeof entry !== 'object') {
        continue
      }
      const loc = Array.isArray(entry.loc) ? entry.loc : []
      const fieldName = loc[loc.length - 1]
      if (typeof fieldName !== 'string') {
        continue
      }
      // Use serviceName as a sensible default value for text fields
      url.searchParams.set(fieldName, serviceName)
    }

    return url.toString()
  } catch {
    return null
  }
}

function buildRequestPayloadFromSchema(protocolDetails: Record<string, unknown>, serviceName: string): Record<string, unknown> | null {
  const agentCard = protocolDetails.agentCard
  if (!agentCard || typeof agentCard !== 'object') {
    return null
  }

  const skills = Array.isArray((agentCard as any).skills) ? (agentCard as any).skills : []
  // Find all unique required fields across all skills
  const requiredFields = new Map<string, string>()
  for (const skill of skills) {
    if (!skill || typeof skill !== 'object') {
      continue
    }
    const schema = skill.inputSchema
    if (!schema || typeof schema !== 'object') {
      continue
    }
    const required = Array.isArray(schema.required) ? schema.required : []
    const properties = schema.properties && typeof schema.properties === 'object' ? schema.properties : {}
    for (const field of required) {
      if (typeof field !== 'string' || requiredFields.has(field)) {
        continue
      }
      const prop = (properties as Record<string, any>)[field]
      const type = prop?.type
      if (type === 'number' || type === 'integer') {
        requiredFields.set(field, 'number')
      } else {
        requiredFields.set(field, 'string')
      }
    }
  }

  if (requiredFields.size === 0) {
    return null
  }

  const payload: Record<string, unknown> = {}
  for (const [field, type] of requiredFields) {
    payload[field] = type === 'number' ? 1 : serviceName
  }
  return payload
}

function buildGetUrl(baseUrl: string, serviceName: string): string {
  const url = new URL(baseUrl)
  // Add generic query params that many REST APIs accept
  if (!url.searchParams.has('query') && !url.searchParams.has('q')) {
    url.searchParams.set('query', serviceName)
  }
  return url.toString()
}

function resolvePaidUrl(input: X402PurchaseInput): string {
  const explicit = input.protocolDetails.paidUrl
  if (typeof explicit === 'string' && explicit.trim()) {
    return explicit
  }

  const endpoint = new URL(input.normalizedEndpointUrl)
  if (endpoint.pathname === '/') {
    return new URL('/data', endpoint.origin).toString()
  }

  return endpoint.toString()
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

export async function purchaseViaX402(input: X402PurchaseInput): Promise<PurchaseResult> {
  const paidUrl = resolvePaidUrl(input)
  const startedAt = Date.now()

  try {
    // With card delegation, the facilitator handles charging — skip orderPlan
    if (!input.cardDelegation) {
      const balance = await input.payments.plans.getPlanBalance(input.planId)
      if (!balance.isSubscriber || Number(balance.balance ?? 0) <= 0) {
        const orderResult = await input.payments.plans.orderPlan(input.planId)
        if (orderResult && !orderResult.success) {
          return {
            purchaseSuccess: false,
            error: 'x402_plan_order_failed',
            httpStatus: null,
            latencyMs: Date.now() - startedAt,
            requestPayload: { paidUrl, planId: input.planId, service: input.serviceName },
            responsePayload: orderResult,
            responseExcerpt: null,
            txHash: null,
            creditsRedeemed: null,
            remainingBalance: null,
            paymentMeta: null,
          }
        }
      }
    }

    const tokenOptions = input.cardDelegation
      ? {
          scheme: 'nvm:card-delegation' as any,
          delegationConfig: {
            providerPaymentMethodId: input.cardDelegation.paymentMethodId,
            spendingLimitCents: input.cardDelegation.spendingLimitCents,
            durationSecs: input.cardDelegation.durationSecs,
          },
        }
      : undefined

    let token: any
    if (input.sellerAgentId) {
      try {
        token = await input.payments.x402.getX402AccessToken(
          input.planId, input.sellerAgentId, undefined, undefined, undefined, tokenOptions,
        )
      } catch {
        token = await input.payments.x402.getX402AccessToken(
          input.planId, undefined, undefined, undefined, undefined, tokenOptions,
        )
      }
    } else {
      token = await input.payments.x402.getX402AccessToken(
        input.planId, undefined, undefined, undefined, undefined, tokenOptions,
      )
    }

    const accessToken = token.accessToken
    if (!accessToken || typeof accessToken !== 'string') {
      return {
        purchaseSuccess: false,
        error: 'x402_token_generation_failed',
        httpStatus: null,
        latencyMs: Date.now() - startedAt,
        requestPayload: { paidUrl, service: input.serviceName },
        responsePayload: null,
        responseExcerpt: null,
        txHash: null,
        creditsRedeemed: null,
        remainingBalance: null,
        paymentMeta: null,
      }
    }

    // Build request payload — prefer schema-derived fields from agent card, fallback to generic
    const schemaPayload = buildRequestPayloadFromSchema(input.protocolDetails, input.serviceName)
    const requestPayload = schemaPayload ?? {
      query: `Please provide the '${input.serviceName}' service output.`,
      service: input.serviceName,
    }

    let response = await fetchWithTimeout(
      paidUrl,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'payment-signature': accessToken,
        },
        body: JSON.stringify(requestPayload),
      },
      input.timeoutMs,
    )

    // If POST 422, the endpoint may need a different body shape — retry with common field names
    if (response.status === 422) {
      const errorText = await response.text()
      const altPayload = buildPayloadFromValidationError(errorText, input.serviceName)
      if (altPayload) {
        response = await fetchWithTimeout(
          paidUrl,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'payment-signature': accessToken,
            },
            body: JSON.stringify(altPayload),
          },
          input.timeoutMs,
        )
      } else {
        response = new Response(errorText, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        })
      }
    }

    // If POST 400 with a simple "X is required" error, retry with the required field
    if (response.status === 400) {
      const errorText = await response.text()
      const altPayload = buildPayloadFromSimpleError(errorText, input.serviceName, paidUrl)
      if (altPayload) {
        response = await fetchWithTimeout(
          paidUrl,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'payment-signature': accessToken,
            },
            body: JSON.stringify(altPayload),
          },
          input.timeoutMs,
        )
      } else {
        response = new Response(errorText, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        })
      }
    }

    // Retry as GET if POST is not allowed (some x402 endpoints are GET-only)
    if (response.status === 405) {
      const getUrl = buildGetUrl(paidUrl, input.serviceName)
      response = await fetchWithTimeout(
        getUrl,
        {
          method: 'GET',
          headers: {
            'payment-signature': accessToken,
          },
        },
        input.timeoutMs,
      )

      // If 422 with validation details, retry with required fields as query params
      if (response.status === 422) {
        const errorText = await response.text()
        const retryUrl = buildGetUrlFromValidationError(paidUrl, errorText, input.serviceName)
        if (retryUrl) {
          response = await fetchWithTimeout(
            retryUrl,
            {
              method: 'GET',
              headers: {
                'payment-signature': accessToken,
              },
            },
            input.timeoutMs,
          )
        } else {
          // Re-wrap the already-consumed body so downstream code can use it
          response = new Response(errorText, {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
          })
        }
      }
    }

    let responsePayload: unknown = null
    const responseText = await response.text()
    try {
      responsePayload = responseText ? JSON.parse(responseText) : null
    } catch {
      responsePayload = responseText
    }

    if (!response.ok) {
      return {
        purchaseSuccess: false,
        error: `x402_http_error_${response.status}`,
        httpStatus: response.status,
        latencyMs: Date.now() - startedAt,
        requestPayload,
        responsePayload,
        responseExcerpt: getTextExcerpt(responsePayload),
        txHash: null,
        creditsRedeemed: null,
        remainingBalance: null,
        paymentMeta: null,
      }
    }

    const paymentMeta = decodePaymentResponseHeader(response.headers.get('payment-response'))
    return {
      purchaseSuccess: true,
      error: null,
      httpStatus: response.status,
      latencyMs: Date.now() - startedAt,
      requestPayload,
      responsePayload,
      responseExcerpt: getTextExcerpt(responsePayload),
      txHash:
        typeof paymentMeta?.transaction === 'string'
          ? paymentMeta.transaction
          : (typeof paymentMeta?.transactionHash === 'string' ? paymentMeta.transactionHash : null),
      creditsRedeemed:
        paymentMeta?.creditsRedeemed !== undefined
          ? String(paymentMeta.creditsRedeemed)
          : null,
      remainingBalance:
        paymentMeta?.remainingBalance !== undefined
          ? String(paymentMeta.remainingBalance)
          : null,
      paymentMeta,
    }
  } catch (error) {
    return {
      purchaseSuccess: false,
      error: error instanceof Error ? `x402_exception:${error.message}` : 'x402_exception',
      httpStatus: null,
      latencyMs: Date.now() - startedAt,
      requestPayload: { paidUrl, service: input.serviceName },
      responsePayload: null,
      responseExcerpt: null,
      txHash: null,
      creditsRedeemed: null,
      remainingBalance: null,
      paymentMeta: null,
    }
  }
}

export { decodePaymentResponseHeader }
