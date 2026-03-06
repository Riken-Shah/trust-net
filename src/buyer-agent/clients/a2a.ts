import { randomUUID } from 'node:crypto'

import { normalizeServiceName } from '../offers.js'
import { type CardDelegation, type DiscoveredOffer, type PurchaseResult } from '../types.js'

interface A2APurchaseInput {
  payments: any
  planId: string
  sellerAgentId: string | null
  serviceName: string
  matchedSkillName: string | null
  discoveredOffers: DiscoveredOffer[]
  normalizedEndpointUrl: string
  protocolDetails: Record<string, unknown>
  timeoutMs: number
  cardDelegation: CardDelegation | null
}

function resolveA2ABaseUrl(input: A2APurchaseInput): string {
  const explicit = input.protocolDetails.a2aBaseUrl
  if (typeof explicit === 'string' && explicit.trim()) {
    return explicit
  }

  const endpoint = new URL(input.normalizedEndpointUrl)
  return endpoint.toString()
}

function pickSkillName(input: A2APurchaseInput): string | null {
  if (input.matchedSkillName) {
    return input.matchedSkillName
  }

  const normalizedService = normalizeServiceName(input.serviceName)
  const exact = input.discoveredOffers.find((offer) => offer.normalized === normalizedService)
  if (exact) {
    return exact.name
  }

  const contains = input.discoveredOffers.find(
    (offer) => offer.normalized.includes(normalizedService) || normalizedService.includes(offer.normalized),
  )
  return contains?.name ?? null
}

function extractText(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') {
    return null
  }

  const record = payload as Record<string, unknown>
  const result = record.result
  if (!result || typeof result !== 'object') {
    return JSON.stringify(payload).slice(0, 500)
  }

  const status = (result as { status?: unknown }).status
  if (!status || typeof status !== 'object') {
    return JSON.stringify(result).slice(0, 500)
  }

  const message = (status as { message?: unknown }).message
  if (!message || typeof message !== 'object') {
    return JSON.stringify(status).slice(0, 500)
  }

  const parts = (message as { parts?: unknown }).parts
  if (!Array.isArray(parts)) {
    return JSON.stringify(message).slice(0, 500)
  }

  const textParts: string[] = []
  for (const part of parts) {
    if (!part || typeof part !== 'object') {
      continue
    }
    const kind = (part as { kind?: unknown }).kind
    const text = (part as { text?: unknown }).text
    if (kind === 'text' && typeof text === 'string') {
      textParts.push(text)
    }
  }

  if (textParts.length === 0) {
    return JSON.stringify(parts).slice(0, 500)
  }

  return textParts.join('\n').slice(0, 500)
}

function extractCreditsUsed(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') {
    return null
  }

  const record = payload as Record<string, unknown>
  const result = record.result
  if (!result || typeof result !== 'object') {
    return null
  }

  const metadata = (result as { metadata?: unknown }).metadata
  if (metadata && typeof metadata === 'object') {
    const credits = (metadata as { creditsUsed?: unknown }).creditsUsed
    if (credits !== undefined) {
      return String(credits)
    }
  }

  const status = (result as { status?: unknown }).status
  if (!status || typeof status !== 'object') {
    return null
  }

  const statusMetadata = (status as { metadata?: unknown }).metadata
  if (statusMetadata && typeof statusMetadata === 'object') {
    const credits = (statusMetadata as { creditsUsed?: unknown }).creditsUsed
    if (credits !== undefined) {
      return String(credits)
    }
  }

  return null
}

export async function purchaseViaA2A(input: A2APurchaseInput): Promise<PurchaseResult> {
  const startedAt = Date.now()
  const a2aBaseUrl = resolveA2ABaseUrl(input)

  try {
    // With card delegation, the facilitator handles charging — skip orderPlan
    if (!input.cardDelegation) {
      const balance = await input.payments.plans.getPlanBalance(input.planId)
      if (!balance.isSubscriber || Number(balance.balance ?? 0) <= 0) {
        const orderResult = await input.payments.plans.orderPlan(input.planId)
        if (orderResult && !orderResult.success) {
          return {
            purchaseSuccess: false,
            error: 'a2a_plan_order_failed',
            httpStatus: null,
            latencyMs: Date.now() - startedAt,
            requestPayload: { planId: input.planId, service: input.serviceName },
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

    const resolvedAgentId = input.sellerAgentId ?? null
    if (!resolvedAgentId) {
      return {
        purchaseSuccess: false,
        error: 'a2a_missing_agent_id',
        httpStatus: null,
        latencyMs: Date.now() - startedAt,
        requestPayload: { a2aBaseUrl, service: input.serviceName },
        responsePayload: null,
        responseExcerpt: null,
        txHash: null,
        creditsRedeemed: null,
        remainingBalance: null,
        paymentMeta: null,
      }
    }

    const selectedSkill = pickSkillName(input)
    if (!selectedSkill) {
      return {
        purchaseSuccess: false,
        error: 'service_not_mappable_to_a2a_skill',
        httpStatus: null,
        latencyMs: Date.now() - startedAt,
        requestPayload: { a2aBaseUrl, service: input.serviceName },
        responsePayload: null,
        responseExcerpt: null,
        txHash: null,
        creditsRedeemed: null,
        remainingBalance: null,
        paymentMeta: null,
      }
    }

    const clientOptions: Record<string, unknown> = {
      agentBaseUrl: a2aBaseUrl,
      agentId: resolvedAgentId,
      planId: input.planId,
    }
    if (input.cardDelegation) {
      clientOptions.cardDelegation = {
        providerPaymentMethodId: input.cardDelegation.paymentMethodId,
        spendingLimitCents: input.cardDelegation.spendingLimitCents,
        durationSecs: input.cardDelegation.durationSecs,
      }
    }
    const client = await input.payments.a2a.getClient(clientOptions)

    const requestPayload = {
      message: {
        messageId: randomUUID(),
        role: 'user',
        kind: 'message',
        parts: [
          {
            kind: 'text',
            text: `Execute skill '${selectedSkill}' for service '${input.serviceName}'.`,
          },
        ],
      },
    }

    const responsePayload = await client.sendA2AMessage(requestPayload)

    const hasError =
      responsePayload &&
      typeof responsePayload === 'object' &&
      (responsePayload as { error?: unknown }).error !== undefined

    return {
      purchaseSuccess: !hasError,
      error: hasError ? 'a2a_jsonrpc_error' : null,
      httpStatus: null,
      latencyMs: Date.now() - startedAt,
      requestPayload,
      responsePayload,
      responseExcerpt: extractText(responsePayload),
      txHash: null,
      creditsRedeemed: extractCreditsUsed(responsePayload),
      remainingBalance: null,
      paymentMeta: null,
    }
  } catch (error) {
    return {
      purchaseSuccess: false,
      error: error instanceof Error ? `a2a_exception:${error.message}` : 'a2a_exception',
      httpStatus: null,
      latencyMs: Date.now() - startedAt,
      requestPayload: { a2aBaseUrl, service: input.serviceName },
      responsePayload: null,
      responseExcerpt: null,
      txHash: null,
      creditsRedeemed: null,
      remainingBalance: null,
      paymentMeta: null,
    }
  }
}
