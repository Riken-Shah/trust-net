export type SellerProtocol = 'a2a' | 'mcp' | 'x402_http' | 'unknown'
export type McpCapabilityKind = 'tool' | 'prompt' | 'resource'

export interface BuyerAgentConfig {
  nvmApiKey: string
  nvmEnvironment: 'sandbox' | 'staging_sandbox' | 'live'
  openAiApiKey: string
  model: string
  timeoutMs: number
  passScore: number
  maxSellers: number | null
  targetSeller: string | null
  includeVerifiedTarget: boolean
}

export interface SellerPlan {
  nvmPlanId: string
  fiatAmountCents: number | null
  tokenSymbol: string | null
  priceAmount: string | null
}

export interface SellerCandidate {
  agentId: string
  marketplaceId: string
  nvmAgentId: string | null
  name: string
  endpointUrl: string
  servicesSold: string | null
  plans: SellerPlan[]
}

export interface EndpointNormalizationResult {
  valid: boolean
  normalizedUrl: string | null
  reason: string | null
}

export interface DiscoveredOffer {
  name: string
  normalized: string
  source: 'db' | 'a2a_card' | 'mcp_tools' | 'mcp_prompts' | 'mcp_resources' | 'x402_pricing'
  capabilityKind: McpCapabilityKind | null
  capabilityId: string | null
  metadata: Record<string, unknown> | null
}

export interface ProtocolDetectionResult {
  protocol: SellerProtocol
  reason: string
  discoveredOffers: DiscoveredOffer[]
  details: Record<string, unknown>
}

export interface ServiceTarget {
  displayName: string
  normalized: string
  matchedEndpointOffer: string | null
  matchedEndpointOfferKind: McpCapabilityKind | null
  matchedEndpointOfferId: string | null
}

export interface PurchaseResult {
  purchaseSuccess: boolean
  error: string | null
  httpStatus: number | null
  latencyMs: number
  requestPayload: Record<string, unknown> | null
  responsePayload: unknown
  responseExcerpt: string | null
  txHash: string | null
  creditsRedeemed: string | null
  remainingBalance: string | null
  paymentMeta: Record<string, unknown> | null
}

export interface JudgmentResult {
  overallScore: number
  scoreAccuracy: number
  scoreSpeed: number
  scoreValue: number
  scoreReliability: number
  verdict: 'pass' | 'fail'
  rationale: string
}

export interface JudgmentContext {
  service: ServiceTarget
  protocol: SellerProtocol
  seller: Pick<SellerCandidate, 'agentId' | 'marketplaceId' | 'name'>
  purchase: PurchaseResult
}

export interface BuyerAgentRunSummary {
  sellersScanned: number
  servicesAttempted: number
  servicesSucceeded: number
  servicesFailed: number
  sellersVerified: number
  protocolCounts: Record<SellerProtocol, number>
}

export interface BuyerAgentRunRow {
  id: string
}

export interface JudgmentInsertInput {
  runId: string
  seller: Pick<SellerCandidate, 'agentId' | 'marketplaceId' | 'name' | 'endpointUrl'>
  service: ServiceTarget
  protocol: SellerProtocol
  planId: string | null
  purchase: PurchaseResult
  judgment: JudgmentResult
  passed: boolean
}

export interface SetupFailureInput {
  runId: string
  seller: Pick<SellerCandidate, 'agentId' | 'marketplaceId' | 'name' | 'endpointUrl'>
  protocol: SellerProtocol
  reason: string
  planId: string | null
}
