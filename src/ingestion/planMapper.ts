import { type PlanEnrichment } from './types.js'

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }
  return value as Record<string, unknown>
}

function getByPath(source: unknown, path: string[]): unknown {
  let current: unknown = source
  for (const key of path) {
    const record = asRecord(current)
    if (!record) {
      return undefined
    }
    current = record[key]
  }
  return current
}

function firstDefined(source: unknown, paths: string[][]): unknown {
  for (const path of paths) {
    const value = getByPath(source, path)
    if (value !== undefined && value !== null) {
      return value
    }
  }
  return null
}

function asString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null
  }
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

function asNumericString(value: unknown): string | null {
  if (typeof value === 'bigint') {
    return value.toString()
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value)
  }
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed) {
      return null
    }
    const parsed = Number(trimmed)
    if (Number.isFinite(parsed)) {
      return trimmed
    }
  }
  return null
}

function asInteger(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value)) {
    return value
  }
  if (typeof value === 'bigint') {
    const cast = Number(value)
    return Number.isSafeInteger(cast) ? cast : null
  }
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed) {
      return null
    }
    const parsed = Number.parseInt(trimmed, 10)
    return Number.isInteger(parsed) ? parsed : null
  }
  return null
}

function asBoolean(value: unknown): boolean | null {
  if (typeof value === 'boolean') {
    return value
  }
  return null
}

export function mapPlanFromSdk(nvmPlanId: string, rawPlan: unknown): PlanEnrichment {
  const network = asString(
    firstDefined(rawPlan, [
      ['network'],
      ['price', 'network'],
      ['pricingConfiguration', 'network'],
      ['pricingConfig', 'network'],
    ]),
  )

  return {
    nvmPlanId,
    name: asString(firstDefined(rawPlan, [['name'], ['planMetadata', 'name'], ['metadata', 'name']])),
    description: asString(
      firstDefined(rawPlan, [['description'], ['planMetadata', 'description'], ['metadata', 'description']]),
    ),
    planType: asString(firstDefined(rawPlan, [['planType'], ['accessType'], ['creditsConfiguration', 'type']])),
    pricingType: asString(firstDefined(rawPlan, [['pricingType'], ['price', 'type'], ['pricingConfiguration', 'type']])),
    priceAmount: asNumericString(
      firstDefined(rawPlan, [['priceAmount'], ['price'], ['pricingConfiguration', 'price'], ['price', 'amount']]),
    ),
    tokenAddress: asString(
      firstDefined(rawPlan, [['tokenAddress'], ['price', 'tokenAddress'], ['pricingConfiguration', 'tokenAddress']]),
    ),
    tokenSymbol: asString(
      firstDefined(rawPlan, [['tokenSymbol'], ['price', 'tokenSymbol'], ['pricingConfiguration', 'tokenSymbol']]),
    ),
    fiatAmountCents: asInteger(
      firstDefined(rawPlan, [['fiatAmountCents'], ['price', 'fiatAmountCents'], ['pricingConfiguration', 'fiatAmountCents']]),
    ),
    fiatCurrency: asString(
      firstDefined(rawPlan, [['fiatCurrency'], ['price', 'fiatCurrency'], ['pricingConfiguration', 'fiatCurrency']]),
    ),
    network,
    receiverAddress: asString(
      firstDefined(rawPlan, [['receiverAddress'], ['receiver'], ['price', 'receiver'], ['pricingConfiguration', 'receiver']]),
    ),
    creditsGranted: asNumericString(
      firstDefined(rawPlan, [['creditsGranted'], ['credits'], ['creditsConfiguration', 'amountOfCredits']]),
    ),
    creditsPerCall: asNumericString(
      firstDefined(rawPlan, [['creditsPerCall'], ['creditsConfiguration', 'minCreditsToCharge']]),
    ),
    creditsMin: asNumericString(
      firstDefined(rawPlan, [['creditsMin'], ['creditsConfiguration', 'minCreditsRequired']]),
    ),
    creditsMax: asNumericString(
      firstDefined(rawPlan, [['creditsMax'], ['creditsConfiguration', 'maxCreditsToCharge']]),
    ),
    durationSeconds: asInteger(firstDefined(rawPlan, [['durationSeconds'], ['duration'], ['timeConfiguration', 'duration']])),
    isActive: asBoolean(firstDefined(rawPlan, [['isActive'], ['isListed'], ['active']])),
  }
}
