import { type Pool } from 'pg'
import { Payments } from '@nevermined-io/payments'

import { purchaseViaA2A } from './clients/a2a.js'
import { discoverMcpCapabilities, purchaseViaMcp } from './clients/mcp.js'
import { purchaseViaX402 } from './clients/x402.js'
import { normalizeEndpointUrl } from './endpoint.js'
import { scoreServiceResult } from './judge.js'
import {
  buildDiscoveredServiceTargets,
  buildServiceUnion,
  matchServiceToOffer,
  normalizeServiceName,
} from './offers.js'
import { selectCheapestPlan } from './plans.js'
import { detectSellerProtocol } from './protocol.js'
import {
  completeRun,
  createRun,
  failRun,
  fetchSellerCandidates,
  insertJudgment,
  insertSetupFailure,
  markSellerVerified,
} from './repository.js'
import { ensureBuyerAgentSchema } from './schema.js'
import {
  type BuyerAgentConfig,
  type BuyerAgentRunSummary,
  type CardDelegation,
  type DiscoveredOffer,
  type PurchaseResult,
  type SellerCandidate,
  type SellerProtocol,
  type ServiceTarget,
} from './types.js'

function createEmptySummary(): BuyerAgentRunSummary {
  return {
    sellersScanned: 0,
    servicesAttempted: 0,
    servicesSucceeded: 0,
    servicesFailed: 0,
    sellersVerified: 0,
    protocolCounts: {
      a2a: 0,
      mcp: 0,
      x402_http: 0,
      unknown: 0,
    },
  }
}

function extractA2AAgentId(details: Record<string, unknown>): string | null {
  const card = details.agentCard
  if (!card || typeof card !== 'object') {
    return null
  }

  const capabilities = (card as { capabilities?: unknown }).capabilities
  if (!capabilities || typeof capabilities !== 'object') {
    return null
  }

  const extensions = (capabilities as { extensions?: unknown }).extensions
  if (!Array.isArray(extensions)) {
    return null
  }

  for (const extension of extensions) {
    if (!extension || typeof extension !== 'object') {
      continue
    }

    const uri = (extension as { uri?: unknown }).uri
    if (uri !== 'urn:nevermined:payment') {
      continue
    }

    const params = (extension as { params?: unknown }).params
    if (!params || typeof params !== 'object') {
      continue
    }

    const agentId = (params as { agentId?: unknown }).agentId
    if (typeof agentId === 'string' && agentId.trim()) {
      return agentId
    }
  }

  return null
}

async function resolveNvmAgentIdFromPlans(payments: any, plans: { nvmPlanId: string }[]): Promise<string | null> {
  for (const plan of plans) {
    try {
      const result = await payments.plans.getAgentsAssociatedToAPlan(plan.nvmPlanId)
      const agents = result?.agents
      if (Array.isArray(agents) && agents.length > 0) {
        const agentId = agents[0].id
        if (typeof agentId === 'string' && agentId.trim()) {
          return agentId
        }
      }
    } catch {
      // Plan lookup failed — try next plan
    }
  }
  return null
}

function buildUnknownProtocolPurchase(reason: string): PurchaseResult {
  return {
    purchaseSuccess: false,
    error: reason,
    httpStatus: null,
    latencyMs: 0,
    requestPayload: null,
    responsePayload: null,
    responseExcerpt: null,
    txHash: null,
    creditsRedeemed: null,
    remainingBalance: null,
    paymentMeta: null,
  }
}

async function purchaseService(
  protocol: SellerProtocol,
  payments: any,
  config: BuyerAgentConfig,
  seller: SellerCandidate,
  planId: string,
  normalizedEndpointUrl: string,
  protocolDetails: Record<string, unknown>,
  service: ServiceTarget,
  discoveredOffers: DiscoveredOffer[],
  cardDelegation: CardDelegation | null,
): Promise<PurchaseResult> {
  if (protocol === 'x402_http') {
    return purchaseViaX402({
      payments,
      planId,
      sellerAgentId: seller.nvmAgentId,
      serviceName: service.displayName,
      normalizedEndpointUrl,
      protocolDetails,
      timeoutMs: config.timeoutMs,
      cardDelegation,
    })
  }

  if (protocol === 'mcp') {
    const matchedOffer = matchServiceToOffer(
        {
          displayName: service.displayName,
          normalized: normalizeServiceName(service.displayName),
          matchedEndpointOffer: service.matchedEndpointOffer,
          matchedEndpointOfferKind: service.matchedEndpointOfferKind,
          matchedEndpointOfferId: service.matchedEndpointOfferId,
        },
        discoveredOffers,
      )

    return purchaseViaMcp({
      payments,
      planId,
      sellerAgentId: seller.nvmAgentId,
      serviceName: service.displayName,
      matchedOffer,
      normalizedEndpointUrl,
      protocolDetails,
      timeoutMs: config.timeoutMs,
      cardDelegation,
    })
  }

  if (protocol === 'a2a') {
    const matchedOffer = matchServiceToOffer(
        {
          displayName: service.displayName,
          normalized: normalizeServiceName(service.displayName),
          matchedEndpointOffer: service.matchedEndpointOffer,
          matchedEndpointOfferKind: service.matchedEndpointOfferKind,
          matchedEndpointOfferId: service.matchedEndpointOfferId,
        },
        discoveredOffers,
      )

    let a2aAgentId = extractA2AAgentId(protocolDetails) ?? seller.nvmAgentId
    if (!a2aAgentId) {
      a2aAgentId = await resolveNvmAgentIdFromPlans(payments, seller.plans)
    }

    return purchaseViaA2A({
      payments,
      planId,
      sellerAgentId: a2aAgentId,
      serviceName: service.displayName,
      matchedSkillName: matchedOffer?.name ?? null,
      discoveredOffers,
      normalizedEndpointUrl,
      protocolDetails,
      timeoutMs: config.timeoutMs,
      cardDelegation,
    })
  }

  return buildUnknownProtocolPurchase('unknown_protocol')
}

export async function runBuyerAgentVerification(pool: Pool, config: BuyerAgentConfig): Promise<BuyerAgentRunSummary> {
  await ensureBuyerAgentSchema(pool)
  const run = await createRun(pool, config)
  const summary = createEmptySummary()

  const payments = Payments.getInstance({
    nvmApiKey: config.nvmApiKey,
    environment: config.nvmEnvironment,
  } as any)

  // Auto-detect card delegation
  let cardDelegation = config.cardDelegation
  if (!cardDelegation) {
    try {
      const methods = await payments.delegation.listPaymentMethods()
      const firstMethod = methods[0]
      if (firstMethod) {
        cardDelegation = {
          paymentMethodId: firstMethod.id,
          spendingLimitCents: 1000,
          durationSecs: 3600,
        }
        console.log(`Card delegation enabled: ${firstMethod.brand} ****${firstMethod.last4}`)
      }
    } catch {
      // No card enrolled — continue with crypto-only
    }
  }

  try {
    const sellers = await fetchSellerCandidates(pool, {
      maxSellers: config.maxSellers,
      targetSeller: config.targetSeller,
      includeVerifiedSellers: config.includeVerifiedSellers,
      includeVerifiedTarget: config.includeVerifiedTarget,
    })

    console.log(`Buyer-agent: ${sellers.length} seller(s) to scan`)

    for (const seller of sellers) {
      summary.sellersScanned += 1
      console.log(`[${summary.sellersScanned}/${sellers.length}] ${seller.name} — ${seller.endpointUrl}`)

      const endpoint = normalizeEndpointUrl(seller.endpointUrl)
      if (!endpoint.valid || !endpoint.normalizedUrl) {
        await insertSetupFailure(pool, {
          runId: run.id,
          seller,
          protocol: 'unknown',
          reason: endpoint.reason ?? 'invalid_endpoint',
          planId: null,
        })
        continue
      }

      const selectedPlan = selectCheapestPlan(seller.plans, !!cardDelegation)
      if (!selectedPlan) {
        await insertSetupFailure(pool, {
          runId: run.id,
          seller,
          protocol: 'unknown',
          reason: 'no_active_plan',
          planId: null,
        })
        continue
      }

      const detection = await detectSellerProtocol(endpoint.normalizedUrl, config.timeoutMs)
      summary.protocolCounts[detection.protocol] += 1
      console.log(`  protocol: ${detection.protocol}${detection.protocol === 'unknown' ? ` (${detection.reason})` : ''}`)

      if (detection.protocol === 'unknown') {
        await insertSetupFailure(pool, {
          runId: run.id,
          seller,
          protocol: 'unknown',
          reason: detection.reason,
          planId: selectedPlan.nvmPlanId,
        })
        continue
      }

      let discoveredOffers = detection.discoveredOffers
      if (detection.protocol === 'mcp') {
        try {
          discoveredOffers = await discoverMcpCapabilities({
            payments,
            planId: selectedPlan.nvmPlanId,
            sellerAgentId: seller.nvmAgentId,
            normalizedEndpointUrl: endpoint.normalizedUrl,
            protocolDetails: detection.details,
            timeoutMs: config.timeoutMs,
            cardDelegation,
          })
        } catch (mcpError) {
          const reason = mcpError instanceof Error ? mcpError.message : 'mcp_discovery_error'
          console.log(`  mcp discovery failed: ${reason}`)
          await insertSetupFailure(pool, {
            runId: run.id,
            seller,
            protocol: detection.protocol,
            reason: `mcp_discovery_error: ${reason}`.slice(0, 500),
            planId: selectedPlan.nvmPlanId,
          })
          continue
        }

        if (discoveredOffers.length === 0) {
          await insertSetupFailure(pool, {
            runId: run.id,
            seller,
            protocol: detection.protocol,
            reason: 'mcp_no_discoverable_capabilities',
            planId: selectedPlan.nvmPlanId,
          })
          continue
        }
      }

      const services = detection.protocol === 'mcp'
        ? buildDiscoveredServiceTargets(discoveredOffers)
        : buildServiceUnion(seller.servicesSold, discoveredOffers)
      if (services.length === 0) {
        await insertSetupFailure(pool, {
          runId: run.id,
          seller,
          protocol: detection.protocol,
          reason: 'no_services',
          planId: selectedPlan.nvmPlanId,
        })
        continue
      }

      let sellerHasPassingService = false

      for (const service of services) {
        summary.servicesAttempted += 1
        console.log(`  service: ${service.displayName} (via ${detection.protocol})`)

        const purchase = await purchaseService(
          detection.protocol,
          payments,
          config,
          seller,
          selectedPlan.nvmPlanId,
          endpoint.normalizedUrl,
          detection.details,
          service,
          discoveredOffers,
          cardDelegation,
        )

        if (purchase.purchaseSuccess) {
          summary.servicesSucceeded += 1
        } else {
          summary.servicesFailed += 1
        }

        const judgment = await scoreServiceResult(config, {
          service,
          protocol: detection.protocol,
          seller,
          purchase,
        })

        const passed =
          purchase.purchaseSuccess &&
          (judgment.verdict === 'pass' || judgment.overallScore >= config.passScore)

        console.log(`    purchase: ${purchase.purchaseSuccess ? 'OK' : `FAIL (${purchase.error})`}, score: ${judgment.overallScore}, verdict: ${judgment.verdict}, passed: ${passed}`)

        if (passed) {
          sellerHasPassingService = true
        }

        await insertJudgment(pool, {
          runId: run.id,
          seller,
          service,
          protocol: detection.protocol,
          planId: selectedPlan.nvmPlanId,
          purchase,
          judgment,
          passed,
        })
      }

      if (sellerHasPassingService) {
        const wasUpdated = await markSellerVerified(pool, seller.agentId)
        if (wasUpdated) {
          summary.sellersVerified += 1
        }
      }
    }

    await completeRun(pool, run.id, summary)
    return summary
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown buyer-agent failure'
    await failRun(pool, run.id, message)
    throw error
  }
}
