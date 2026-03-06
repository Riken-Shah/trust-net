export interface DiscoverSnapshot {
  sellers: unknown[]
  buyers: unknown[]
}

export interface NormalizedSeller {
  teamId: string
  nvmAgentId: string
  walletAddress: string
  teamName: string | null
  name: string
  description: string | null
  category: string | null
  keywords: string[]
  endpointUrl: string
  servicesSold: string | null
  servicesProvidedPerRequest: string | null
  pricePerRequestDisplay: string | null
  priceMeteringUnit: string | null
  priceDisplay: number | null
  apiCreatedAt: Date
  planIds: string[]
}

export interface SellerReject {
  sellerId: string | null
  reason: string
}

export interface NormalizationResult {
  sellers: NormalizedSeller[]
  rejected: SellerReject[]
}

export interface PlanEnrichment {
  nvmPlanId: string
  name: string | null
  description: string | null
  planType: string | null
  pricingType: string | null
  priceAmount: string | null
  tokenAddress: string | null
  tokenSymbol: string | null
  fiatAmountCents: number | null
  fiatCurrency: string | null
  network: string | null
  receiverAddress: string | null
  creditsGranted: string | null
  creditsPerCall: string | null
  creditsMin: string | null
  creditsMax: string | null
  durationSeconds: number | null
  isActive: boolean | null
}

export interface PlanEnrichmentResult {
  byPlanId: Map<string, PlanEnrichment>
  failedPlanIds: string[]
}

export interface PersistResult {
  agentsUpserted: number
  plansUpserted: number
  agentServicesUpserted: number
  orderCheckpointsInserted: number
  burnCheckpointsInserted: number
  agentsDeactivated: number
  plansDeactivated: number
  agentServicesDeactivated: number
}

export interface IngestionRunResult {
  fetchedSellers: number
  normalizedSellers: number
  rejectedSellers: number
  uniquePlansDiscovered: number
  plansEnriched: number
  plansEnrichmentFailed: number
  persisted: PersistResult
  startedAt: Date
  finishedAt: Date
}
