import { type PurchaseResult } from '../types.js'

interface X402PurchaseInput {
  payments: any
  planId: string
  sellerAgentId: string | null
  serviceName: string
  normalizedEndpointUrl: string
  protocolDetails: Record<string, unknown>
  timeoutMs: number
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
    const balance = await input.payments.plans.getPlanBalance(input.planId)
    if (!balance.isSubscriber || Number(balance.balance ?? 0) <= 0) {
      await input.payments.plans.orderPlan(input.planId)
    }

    const token = await input.payments.x402.getX402AccessToken(
      input.planId,
      input.sellerAgentId ?? undefined,
    )

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

    const requestPayload = {
      query: `Please provide the '${input.serviceName}' service output.`,
      service: input.serviceName,
    }

    const response = await fetchWithTimeout(
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
