import { type SellerPlan } from './types.js'

function toBigIntOrNull(raw: string | null): bigint | null {
  if (!raw) {
    return null
  }

  try {
    return BigInt(raw)
  } catch {
    return null
  }
}

function comparableUsdPrice(plan: SellerPlan): number | null {
  if (plan.fiatAmountCents !== null) {
    return plan.fiatAmountCents / 100
  }

  const amount = toBigIntOrNull(plan.priceAmount)
  if (amount === null) {
    return null
  }

  const symbol = (plan.tokenSymbol ?? '').toUpperCase()
  if (symbol === 'USDC' || symbol === 'USDT') {
    return Number(amount) / 1_000_000
  }

  if (symbol === 'ETH') {
    return Number(amount) / 1_000_000_000_000_000_000
  }

  return null
}

export function selectCheapestPlan(plans: SellerPlan[]): SellerPlan | null {
  if (plans.length === 0) {
    return null
  }

  const ranked = plans.map((plan) => ({
    plan,
    comparableUsdPrice: comparableUsdPrice(plan),
  }))

  ranked.sort((left, right) => {
    if (left.comparableUsdPrice !== null && right.comparableUsdPrice !== null) {
      if (left.comparableUsdPrice !== right.comparableUsdPrice) {
        return left.comparableUsdPrice - right.comparableUsdPrice
      }
      return left.plan.nvmPlanId.localeCompare(right.plan.nvmPlanId)
    }

    if (left.comparableUsdPrice !== null) {
      return -1
    }

    if (right.comparableUsdPrice !== null) {
      return 1
    }

    return left.plan.nvmPlanId.localeCompare(right.plan.nvmPlanId)
  })

  return ranked[0]?.plan ?? null
}
