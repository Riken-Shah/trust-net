export interface IntelAgentProfileRow {
  agentUuid: string
  nvmAgentId: string
  marketplaceId: string
  name: string
  description: string | null
  category: string | null
  endpointUrl: string | null
  isActive: boolean
  keywords: string[]
  servicesText: string | null
  planNamesText: string | null
  totalOrders: number
  uniqueBuyers: number
  repeatBuyers: number
  totalRequests: number
  successfulBurns: number
  failedBurns: number
  totalCreditsBurned: number
  trustScore: number | null
  trustTier: string | null
  trustReliability: number | null
  trustReviewScore: number | null
  trustReviewCount: number
  avgReviewScore: number | null
  avgScoreAccuracy: number | null
  avgScoreSpeed: number | null
  avgScoreValue: number | null
  avgScoreReliability: number | null
  minPlanPriceUsd: number | null
  minPlanId: string | null
  roiUnavailableReason: string | null
}

export interface IntelRecentReviewRow {
  comment: string
  createdAt: Date
}

export interface IntelSnapshotRow {
  snapshotAt: Date
  agentId: string
  totalOrders: number
  uniqueBuyers: number
  repeatBuyers: number
  totalRequests: number
  successfulBurns: number
  failedBurns: number
  totalCreditsBurned: number
}

export interface IntelWindowMetrics {
  agentId: string
  orderDelta30m: number
  uniqueBuyersDelta30m: number
  repeatBuyersDelta30m: number
  totalRequestsDelta30m: number
  successfulBurnsDelta30m: number
  failedBurnsDelta30m: number
  totalCreditsBurnedDelta30m: number
  latestSnapshotAt: Date
  baselineSnapshotAt: Date | null
  windowDataAvailable: boolean
}

export interface IntelQueryError {
  status: number
  code: string
  message: string
}

export interface RoiEstimate {
  expectedCostPerSuccessUsd: number | null
  minPlanPriceUsd: number | null
  sourcePlanId: string | null
  unavailableReason: string | null
}

export interface FailureWarning {
  code: string
  message: string
  severity: 'low' | 'medium' | 'high'
}

export interface IntelAgentSummary {
  id: string
  nvmAgentId: string
  marketplaceId: string
  name: string
  description: string | null
  category: string | null
  endpointUrl: string | null
  isActive: boolean
  trustScore: number | null
  trustTier: string | null
  trustReviewCount: number
}

export interface ConsistencyScore {
  score: number
  reliabilityComponent: number
  volatilityComponent: number
  confidence: number
  sampleWindows: number
}

export interface IntelAgentMetrics {
  totalOrders: number
  uniqueBuyers: number
  repeatBuyers: number
  totalRequests: number
  successfulBurns: number
  failedBurns: number
  totalCreditsBurned: number
  failureRate: number
}

export interface IntelAgentWindowMetrics {
  windowDataAvailable: boolean
  windowStart: string | null
  windowEnd: string | null
  orderDelta30m: number
  uniqueBuyersDelta30m: number
  repeatBuyersDelta30m: number
  repeatPurchases30m: number
  totalRequestsDelta30m: number
  successfulBurnsDelta30m: number
  failedBurnsDelta30m: number
  totalCreditsBurnedDelta30m: number
  failureRate30m: number | null
  dataFreshnessSeconds: number | null
  previousFailureRate30m: number | null
}

export interface IntelAgentProfileResponse {
  agent: IntelAgentSummary
  trust: {
    trustScore: number | null
    tier: string | null
    scoreReliability: number | null
    scoreReviews: number | null
    reviewCount: number
  }
  lifetimeMetrics: IntelAgentMetrics
  failureHistory: {
    lifetime: {
      failedBurns: number
      totalRequests: number
      failureRate: number
    }
    last30m: {
      windowDataAvailable: boolean
      failedBurns: number
      totalRequests: number
      failureRate: number | null
      windowStart: string | null
      windowEnd: string | null
      dataFreshnessSeconds: number | null
    }
    trend: 'improving' | 'stable' | 'worsening' | 'unknown'
  }
  consistencyScore: ConsistencyScore
  outputQualityNotes: string[]
  cheaperAlternatives: Array<{
    nvmAgentId: string
    name: string
    category: string | null
    expectedCostPerSuccessUsd: number
    deltaPercent: number
    reliability: number
    trustScore: number | null
    reason: string
  }>
}

export interface IntelSearchResultItem {
  agent: IntelAgentSummary
  rankScore: number
  confidence: number
  textRelevance: number
  roiEstimate: RoiEstimate
  consistencyScore: ConsistencyScore
  failureWarnings: FailureWarning[]
}

export interface IntelSearchResponse {
  query: string
  generatedAt: string
  resultCount: number
  results: IntelSearchResultItem[]
}

export interface IntelTrendingItem {
  agent: IntelAgentSummary
  repeatPurchases30m: number
  orders30m: number
  uniqueBuyers30m: number
  trustScore: number | null
}

export interface IntelTrendingResponse {
  windowMinutes: number
  insufficientWindowData: boolean
  windowStart: string | null
  windowEnd: string | null
  dataFreshnessSeconds: number | null
  generatedAt: string
  agents: IntelTrendingItem[]
}

export interface IntelAvoidItem {
  agent: IntelAgentSummary
  failedBurns30m: number
  totalRequests30m: number
  failureRate30m: number | null
  warning: string
}

export interface IntelAvoidResponse {
  windowMinutes: number
  threshold: number
  insufficientWindowData: boolean
  windowStart: string | null
  windowEnd: string | null
  dataFreshnessSeconds: number | null
  generatedAt: string
  agents: IntelAvoidItem[]
}

export interface IntelCompareResponse {
  generatedAt: string
  agents: Array<{
    agent: IntelAgentSummary
    trustScore: number | null
    consistencyScore: ConsistencyScore
    roiEstimate: RoiEstimate
    lifetimeFailureRate: number
    failedBurns30m: number
    failureRate30m: number | null
    reviewCount: number
  }>
  summary: {
    bestReliability: string | null
    bestRoi: string | null
    bestConsistency: string | null
    lowestRecentFailures: string | null
  }
}
