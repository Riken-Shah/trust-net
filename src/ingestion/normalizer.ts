import { type NormalizationResult, type NormalizedSeller, type SellerReject } from './types.js'

function asObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }
  return value as Record<string, unknown>
}

function asTrimmedString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null
  }
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

function asOptionalString(value: unknown): string | null {
  return asTrimmedString(value)
}

function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value
  }
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed) {
      return null
    }
    const parsed = Number.parseFloat(trimmed)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

function asTimestamp(value: unknown): Date | null {
  const text = asTrimmedString(value)
  if (!text) {
    return null
  }
  const date = new Date(text)
  return Number.isNaN(date.getTime()) ? null : date
}

function asStringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return []
  }

  const deduped = new Set<string>()
  for (const item of value) {
    const text = asTrimmedString(item)
    if (text) {
      deduped.add(text)
    }
  }

  return [...deduped]
}

function getSellerIdForError(rawSeller: unknown): string | null {
  const record = asObject(rawSeller)
  if (!record) {
    return null
  }

  const nvmAgentId = asTrimmedString(record.nvmAgentId)
  if (nvmAgentId) {
    return nvmAgentId
  }

  const teamId = asTrimmedString(record.teamId)
  const name = asTrimmedString(record.name)
  if (teamId && name) {
    return `${teamId}:${name}`
  }

  return teamId ?? name
}

function buildReject(rawSeller: unknown, reason: string): SellerReject {
  return {
    sellerId: getSellerIdForError(rawSeller),
    reason,
  }
}

function maxPlanPriceFromPlanPricing(value: unknown): number | null {
  if (!Array.isArray(value)) {
    return null
  }

  let maxPrice: number | null = null
  for (const item of value) {
    const record = asObject(item)
    const planPrice = record ? asNumber(record.planPrice) : null
    if (planPrice === null) {
      continue
    }
    if (maxPrice === null || planPrice > maxPrice) {
      maxPrice = planPrice
    }
  }

  return maxPrice
}

export function normalizeSeller(rawSeller: unknown): { seller: NormalizedSeller | null; reject: SellerReject | null } {
  const record = asObject(rawSeller)
  if (!record) {
    return {
      seller: null,
      reject: buildReject(rawSeller, 'Seller is not an object.'),
    }
  }

  const pricing = asObject(record.pricing)
  const teamId = asTrimmedString(record.teamId)
  const nvmAgentId = asTrimmedString(record.nvmAgentId)
  const walletAddress = asTrimmedString(record.walletAddress)
  const name = asTrimmedString(record.name)
  const endpointUrl = asTrimmedString(record.endpointUrl)
  const createdAt = asTimestamp(record.createdAt)
  const planIds = asStringList(record.planIds)

  if (!teamId) {
    return { seller: null, reject: buildReject(rawSeller, 'Missing required field: teamId.') }
  }
  if (!nvmAgentId) {
    return { seller: null, reject: buildReject(rawSeller, 'Missing required field: nvmAgentId.') }
  }
  if (!walletAddress) {
    return { seller: null, reject: buildReject(rawSeller, 'Missing required field: walletAddress.') }
  }
  if (!name) {
    return { seller: null, reject: buildReject(rawSeller, 'Missing required field: name.') }
  }
  if (!endpointUrl) {
    return { seller: null, reject: buildReject(rawSeller, 'Missing required field: endpointUrl.') }
  }
  if (!createdAt) {
    return { seller: null, reject: buildReject(rawSeller, 'Missing required field: createdAt.') }
  }
  if (planIds.length === 0) {
    return { seller: null, reject: buildReject(rawSeller, 'Missing required field: planIds[].') }
  }

  return {
    seller: {
      teamId,
      nvmAgentId,
      walletAddress: walletAddress.toLowerCase(),
      teamName: asOptionalString(record.teamName),
      name,
      description: asOptionalString(record.description),
      category: asOptionalString(record.category),
      keywords: asStringList(record.keywords),
      endpointUrl,
      servicesSold: asOptionalString(record.servicesSold),
      servicesProvidedPerRequest: asOptionalString(pricing?.servicesPerRequest),
      pricePerRequestDisplay: asOptionalString(pricing?.perRequest),
      priceMeteringUnit: asOptionalString(pricing?.meteringUnit),
      priceDisplay: maxPlanPriceFromPlanPricing(record.planPricing),
      apiCreatedAt: createdAt,
      planIds,
    },
    reject: null,
  }
}

export function normalizeSellers(rawSellers: unknown[]): NormalizationResult {
  const sellers: NormalizedSeller[] = []
  const rejected: SellerReject[] = []

  for (const rawSeller of rawSellers) {
    const { seller, reject } = normalizeSeller(rawSeller)
    if (seller) {
      sellers.push(seller)
      continue
    }
    if (reject) {
      rejected.push(reject)
    }
  }

  return {
    sellers,
    rejected,
  }
}
