import { type SellerPlan } from './types.js'

export interface PlanBootstrapReady {
  status: 'ready'
}

export interface PlanBootstrapBlocked {
  status: 'blocked'
  reason: string
  requestPayload: Record<string, unknown> | null
  responsePayload: unknown
  responseExcerpt: string | null
  paymentMeta: Record<string, unknown> | null
  httpStatus: number | null
  latencyMs: number
}

export interface PlanBootstrapFailed {
  status: 'failed'
  reason: string
  requestPayload: Record<string, unknown> | null
  responsePayload: unknown
  responseExcerpt: string | null
  paymentMeta: Record<string, unknown> | null
  httpStatus: number | null
  latencyMs: number
}

export type PlanBootstrapResult = PlanBootstrapReady | PlanBootstrapBlocked | PlanBootstrapFailed

function buildNonReadyResult(
  status: 'blocked' | 'failed',
  reason: string,
  startedAt: number,
  fields: Partial<Omit<PlanBootstrapBlocked, 'status' | 'reason' | 'latencyMs'>> = {},
): PlanBootstrapBlocked | PlanBootstrapFailed {
  return {
    status,
    reason,
    requestPayload: fields.requestPayload ?? null,
    responsePayload: fields.responsePayload ?? null,
    responseExcerpt: fields.responseExcerpt ?? null,
    paymentMeta: fields.paymentMeta ?? null,
    httpStatus: fields.httpStatus ?? null,
    latencyMs: Date.now() - startedAt,
  }
}

function isFiatPlan(plan: SellerPlan): boolean {
  return (plan.pricingType ?? '').toLowerCase() === 'fiat'
}

export async function ensurePlanReady(
  payments: any,
  plan: SellerPlan,
): Promise<PlanBootstrapResult> {
  const startedAt = Date.now()

  try {
    const balance = await payments.plans.getPlanBalance(plan.nvmPlanId)
    if (balance.isSubscriber && Number(balance.balance ?? 0) > 0) {
      return { status: 'ready' }
    }

    if (isFiatPlan(plan)) {
      const requestPayload = {
        planId: plan.nvmPlanId,
        pricingType: plan.pricingType,
        action: 'orderFiatPlan',
      }

      try {
        const responsePayload = await payments.plans.orderFiatPlan(plan.nvmPlanId)
        const checkoutUrl = responsePayload?.checkoutUrl

        if (typeof checkoutUrl === 'string' && checkoutUrl.trim()) {
          return buildNonReadyResult(
            'blocked',
            'fiat_checkout_required',
            startedAt,
            {
              requestPayload,
              responsePayload,
              responseExcerpt: checkoutUrl,
              paymentMeta: { checkoutUrl },
            },
          )
        }

        return buildNonReadyResult(
          'failed',
          'fiat_checkout_missing_url',
          startedAt,
          {
            requestPayload,
            responsePayload,
            responseExcerpt: JSON.stringify(responsePayload).slice(0, 500),
          },
        )
      } catch (error) {
        return buildNonReadyResult(
          'failed',
          error instanceof Error ? `fiat_checkout_error:${error.message}` : 'fiat_checkout_error',
          startedAt,
          {
            requestPayload,
            responsePayload: null,
          },
        )
      }
    }

    await payments.plans.orderPlan(plan.nvmPlanId)
    return { status: 'ready' }
  } catch (error) {
    return buildNonReadyResult(
      'failed',
      error instanceof Error ? `plan_bootstrap_error:${error.message}` : 'plan_bootstrap_error',
      startedAt,
    )
  }
}
