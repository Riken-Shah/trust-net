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

function asBoolean(value: unknown, defaultValue = false): boolean {
  if (typeof value === 'boolean') {
    return value
  }
  return defaultValue
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
  return record ? asTrimmedString(record.id) : null
}

function buildReject(rawSeller: unknown, reason: string): SellerReject {
  return {
    sellerId: getSellerIdForError(rawSeller),
    reason,
  }
}

export function normalizeSeller(rawSeller: unknown): { seller: NormalizedSeller | null; reject: SellerReject | null } {
  const record = asObject(rawSeller)
  if (!record) {
    return {
      seller: null,
      reject: buildReject(rawSeller, 'Seller is not an object.'),
    }
  }

  const marketplaceId = asTrimmedString(record.id)
  const teamId = asTrimmedString(record.teamId)
  const walletAddress = asTrimmedString(record.walletAddress)
  const name = asTrimmedString(record.name)
  const planIds = asStringList(record.planIds)

  if (!marketplaceId) {
    return { seller: null, reject: buildReject(rawSeller, 'Missing required field: id.') }
  }
  if (!teamId) {
    return { seller: null, reject: buildReject(rawSeller, 'Missing required field: teamId.') }
  }
  if (!walletAddress) {
    return { seller: null, reject: buildReject(rawSeller, 'Missing required field: walletAddress.') }
  }
  if (!name) {
    return { seller: null, reject: buildReject(rawSeller, 'Missing required field: name.') }
  }
  if (planIds.length === 0) {
    return { seller: null, reject: buildReject(rawSeller, 'Missing required field: planIds[].') }
  }

  return {
    seller: {
      marketplaceId,
      teamId,
      nvmAgentId: asOptionalString(record.nvmAgentId),
      walletAddress: walletAddress.toLowerCase(),
      teamName: asOptionalString(record.teamName),
      name,
      description: asOptionalString(record.description),
      category: asOptionalString(record.category),
      keywords: asStringList(record.keywords),
      marketplaceReady: asBoolean(record.marketplaceReady, false),
      endpointUrl: asOptionalString(record.endpointUrl),
      servicesSold: asOptionalString(record.servicesSold),
      servicesProvidedPerRequest: asOptionalString(record.servicesProvidedPerRequest),
      pricePerRequestDisplay: asOptionalString(record.pricePerRequest),
      priceMeteringUnit: asOptionalString(record.priceMeteringUnit),
      priceDisplay: asNumber(record.price),
      apiCreatedAt: asTimestamp(record.createdAt),
      apiUpdatedAt: asTimestamp(record.updatedAt),
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
