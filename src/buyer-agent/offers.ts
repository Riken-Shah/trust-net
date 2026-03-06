import { type DiscoveredOffer, type ServiceTarget } from './types.js'

const SPACE_PATTERN = /\s+/g

export function normalizeServiceName(raw: string): string {
  return raw.trim().toLowerCase().replace(SPACE_PATTERN, ' ')
}

export function parseServicesSoldCsv(rawServicesSold: string | null): DiscoveredOffer[] {
  if (!rawServicesSold) {
    return []
  }

  const deduped = new Map<string, DiscoveredOffer>()
  for (const piece of rawServicesSold.split(',')) {
    const trimmed = piece.trim()
    if (!trimmed) {
      continue
    }

    const normalized = normalizeServiceName(trimmed)
    if (!normalized) {
      continue
    }

    if (!deduped.has(normalized)) {
      deduped.set(normalized, {
        name: trimmed,
        normalized,
        source: 'db',
        capabilityKind: null,
        capabilityId: null,
        metadata: null,
      })
    }
  }

  return [...deduped.values()]
}

export function buildServiceUnion(
  dbServicesSold: string | null,
  discoveredOffers: DiscoveredOffer[],
): ServiceTarget[] {
  const deduped = new Map<string, ServiceTarget>()

  for (const offer of parseServicesSoldCsv(dbServicesSold)) {
    deduped.set(offer.normalized, {
      displayName: offer.name,
      normalized: offer.normalized,
      matchedEndpointOffer: null,
      matchedEndpointOfferKind: null,
      matchedEndpointOfferId: null,
    })
  }

  for (const offer of discoveredOffers) {
    if (!deduped.has(offer.normalized)) {
      deduped.set(offer.normalized, {
        displayName: offer.name,
        normalized: offer.normalized,
        matchedEndpointOffer: offer.name,
        matchedEndpointOfferKind: offer.capabilityKind,
        matchedEndpointOfferId: offer.capabilityId,
      })
      continue
    }

    const existing = deduped.get(offer.normalized)
    if (existing && existing.matchedEndpointOffer === null) {
      existing.matchedEndpointOffer = offer.name
      existing.matchedEndpointOfferKind = offer.capabilityKind
      existing.matchedEndpointOfferId = offer.capabilityId
    }
  }

  return [...deduped.values()].sort((a, b) => a.normalized.localeCompare(b.normalized))
}

export function buildDiscoveredServiceTargets(discoveredOffers: DiscoveredOffer[]): ServiceTarget[] {
  const deduped = new Map<string, ServiceTarget>()

  for (const offer of discoveredOffers) {
    const key = offer.capabilityKind && offer.capabilityId
      ? `${offer.capabilityKind}:${offer.capabilityId}`
      : `${offer.source}:${offer.normalized}`

    if (!deduped.has(key)) {
      deduped.set(key, {
        displayName: offer.name,
        normalized: offer.normalized,
        matchedEndpointOffer: offer.name,
        matchedEndpointOfferKind: offer.capabilityKind,
        matchedEndpointOfferId: offer.capabilityId,
      })
    }
  }

  return [...deduped.values()].sort((a, b) => a.displayName.localeCompare(b.displayName))
}

export function matchServiceToOffer(
  service: ServiceTarget,
  discoveredOffers: DiscoveredOffer[],
): DiscoveredOffer | null {
  if (service.matchedEndpointOfferKind && service.matchedEndpointOfferId) {
    const exactCapability = discoveredOffers.find(
      (offer) =>
        offer.capabilityKind === service.matchedEndpointOfferKind
        && offer.capabilityId === service.matchedEndpointOfferId,
    )
    if (exactCapability) {
      return exactCapability
    }
  }

  const exact = discoveredOffers.find((offer) => offer.normalized === service.normalized)
  if (exact) {
    return exact
  }

  const contains = discoveredOffers.find(
    (offer) => offer.normalized.includes(service.normalized) || service.normalized.includes(offer.normalized),
  )

  return contains ?? null
}
