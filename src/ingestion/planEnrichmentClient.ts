import { mapPlanFromSdk } from './planMapper.js'
import { type PlanEnrichmentResult } from './types.js'

export type SupportedNvmEnvironment = 'sandbox' | 'live' | 'staging_sandbox'

export interface PlanEnrichmentConfig {
  nvmApiKey: string
  nvmEnvironment: SupportedNvmEnvironment
  concurrency: number
}

export type PlanGetter = (planId: string) => Promise<unknown>

async function buildPlanGetter(config: PlanEnrichmentConfig): Promise<PlanGetter> {
  const moduleName = '@nevermined-io/payments'
  const loaded = (await import(moduleName)) as { Payments?: { getInstance: (input: unknown) => unknown } }
  const Payments = loaded.Payments

  if (!Payments || typeof Payments.getInstance !== 'function') {
    throw new Error('Failed to load @nevermined-io/payments Payments.getInstance.')
  }

  const payments = Payments.getInstance({
    nvmApiKey: config.nvmApiKey,
    environment: config.nvmEnvironment,
  }) as {
    plans?: {
      getPlan?: (planId: string) => Promise<unknown>
    }
  }

  if (!payments.plans?.getPlan || typeof payments.plans.getPlan !== 'function') {
    throw new Error('Nevermined Payments SDK does not expose plans.getPlan.')
  }

  return async (planId: string): Promise<unknown> => {
    return payments.plans!.getPlan!(planId)
  }
}

export async function enrichPlans(
  planIds: string[],
  config: PlanEnrichmentConfig,
  planGetter?: PlanGetter,
): Promise<PlanEnrichmentResult> {
  const uniquePlanIds = [...new Set(planIds)]
  const byPlanId = new Map<string, ReturnType<typeof mapPlanFromSdk>>()
  const failedPlanIds: string[] = []

  if (uniquePlanIds.length === 0) {
    return {
      byPlanId,
      failedPlanIds,
    }
  }

  const getPlan = planGetter ?? (await buildPlanGetter(config))
  const queue = [...uniquePlanIds]
  const workerCount = Math.min(Math.max(config.concurrency, 1), queue.length)

  const workers = Array.from({ length: workerCount }, async () => {
    while (queue.length > 0) {
      const planId = queue.shift()
      if (!planId) {
        return
      }

      try {
        const plan = await getPlan(planId)
        byPlanId.set(planId, mapPlanFromSdk(planId, plan))
      } catch {
        failedPlanIds.push(planId)
      }
    }
  })

  await Promise.all(workers)

  return {
    byPlanId,
    failedPlanIds,
  }
}
