import { type Pool } from 'pg'

import { loadIngestionConfig, type IngestionConfig } from './config.js'
import { fetchDiscoverSnapshot } from './marketplaceClient.js'
import { normalizeSellers } from './normalizer.js'
import { enrichPlans, type PlanGetter } from './planEnrichmentClient.js'
import { persistMarketplaceSnapshot } from './repository.js'
import { type IngestionRunResult } from './types.js'

export interface RunMarketplaceIngestionOptions {
  config?: IngestionConfig
  fetchImpl?: typeof fetch
  planGetter?: PlanGetter
  now?: () => Date
}

export async function runMarketplaceIngestion(
  pool: Pool,
  options: RunMarketplaceIngestionOptions = {},
): Promise<IngestionRunResult> {
  const startedAt = options.now?.() ?? new Date()
  const config = options.config ?? loadIngestionConfig()

  const snapshot = await fetchDiscoverSnapshot(
    {
      discoverApiUrl: config.discoverApiUrl,
      nvmApiKey: config.nvmApiKey,
      timeoutMs: config.httpTimeoutMs,
      retryCount: config.retryCount,
    },
    options.fetchImpl,
  )

  const normalization = normalizeSellers(snapshot.sellers)

  const uniquePlanIds = [...new Set(normalization.sellers.flatMap((seller) => seller.planIds))]

  const planEnrichment = await enrichPlans(
    uniquePlanIds,
    {
      nvmApiKey: config.nvmApiKey,
      nvmEnvironment: config.nvmEnvironment,
      concurrency: config.planEnrichConcurrency,
    },
    options.planGetter,
  )

  const persisted = await persistMarketplaceSnapshot(pool, {
    sellers: normalization.sellers,
    planEnrichments: planEnrichment.byPlanId,
    chainNetwork: config.chainNetwork,
  })

  const finishedAt = options.now?.() ?? new Date()

  return {
    fetchedSellers: snapshot.sellers.length,
    normalizedSellers: normalization.sellers.length,
    rejectedSellers: normalization.rejected.length,
    uniquePlansDiscovered: uniquePlanIds.length,
    plansEnriched: planEnrichment.byPlanId.size,
    plansEnrichmentFailed: planEnrichment.failedPlanIds.length,
    persisted,
    startedAt,
    finishedAt,
  }
}
