import { type PlanEnrichment } from './types.js'

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'
const KNOWN_USDC_ADDRESSES = new Set([
  '0x036cbd53842c5426634e7929541ec2318f3dcf7e',
  '0x833589fcdd6edb6e08f4c7c32d4f71b54bda02913',
])

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

function asBigInt(value: unknown): bigint | null {
  if (typeof value === 'bigint') {
    return value
  }
  if (typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value)) {
    return BigInt(value)
  }
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed) {
      return null
    }
    try {
      return BigInt(trimmed)
    } catch {
      return null
    }
  }
  return null
}

function getStringArray(source: unknown, path: string[]): string[] {
  const value = getByPath(source, path)
  if (!Array.isArray(value)) {
    return []
  }

  const strings: string[] = []
  for (const item of value) {
    const text = asString(item)
    if (text) {
      strings.push(text)
    }
  }

  return strings
}

function sumNumericStrings(values: string[]): string | null {
  if (values.length === 0) {
    return null
  }

  let total = 0n
  let seen = false
  for (const value of values) {
    const parsed = asBigInt(value)
    if (parsed === null) {
      continue
    }
    total += parsed
    seen = true
  }

  return seen ? total.toString() : null
}

function derivePricingType(rawPlan: unknown): string | null {
  const isCrypto = asBoolean(getByPath(rawPlan, ['registry', 'price', 'isCrypto']))
  const tokenAddress = asString(
    firstDefined(rawPlan, [
      ['registry', 'price', 'tokenAddress'],
      ['tokenAddress'],
      ['price', 'tokenAddress'],
      ['pricingConfiguration', 'tokenAddress'],
    ]),
  )

  if (isCrypto === false) {
    return 'fiat'
  }

  if (isCrypto === true) {
    if (!tokenAddress || tokenAddress.toLowerCase() === ZERO_ADDRESS) {
      return 'crypto'
    }
    return 'erc20'
  }

  return asString(firstDefined(rawPlan, [['pricingType'], ['price', 'type'], ['pricingConfiguration', 'type']]))
}

function derivePriceAmount(rawPlan: unknown): string | null {
  const summedAmounts = sumNumericStrings(getStringArray(rawPlan, ['registry', 'price', 'amounts']))
  if (summedAmounts) {
    return summedAmounts
  }

  return asNumericString(
    firstDefined(rawPlan, [['priceAmount'], ['price'], ['pricingConfiguration', 'price'], ['price', 'amount']]),
  )
}

function deriveTokenSymbol(rawPlan: unknown, tokenAddress: string | null): string | null {
  const explicit = asString(
    firstDefined(rawPlan, [['tokenSymbol'], ['price', 'tokenSymbol'], ['pricingConfiguration', 'tokenSymbol']]),
  )
  if (explicit) {
    return explicit
  }

  if (!tokenAddress) {
    return null
  }

  const normalized = tokenAddress.toLowerCase()
  if (normalized === ZERO_ADDRESS) {
    return 'ETH'
  }
  if (KNOWN_USDC_ADDRESSES.has(normalized)) {
    return 'USDC'
  }
  return null
}

function deriveFiatAmountCents(rawPlan: unknown, pricingType: string | null, priceAmount: string | null): number | null {
  const explicit = asInteger(
    firstDefined(rawPlan, [['fiatAmountCents'], ['price', 'fiatAmountCents'], ['pricingConfiguration', 'fiatAmountCents']]),
  )
  if (explicit !== null) {
    return explicit
  }

  if (pricingType !== 'fiat' || !priceAmount) {
    return null
  }

  const amount = asBigInt(priceAmount)
  if (amount === null) {
    return null
  }

  const cents = amount / 10000n
  const cast = Number(cents)
  return Number.isSafeInteger(cast) ? cast : null
}

export function mapPlanFromSdk(nvmPlanId: string, rawPlan: unknown): PlanEnrichment {
  const pricingType = derivePricingType(rawPlan)
  const priceAmount = derivePriceAmount(rawPlan)
  const tokenAddress = asString(
    firstDefined(rawPlan, [['tokenAddress'], ['registry', 'price', 'tokenAddress'], ['price', 'tokenAddress'], ['pricingConfiguration', 'tokenAddress']]),
  )
  const tokenSymbol = deriveTokenSymbol(rawPlan, tokenAddress)
  const priceReceivers = getStringArray(rawPlan, ['registry', 'price', 'receivers'])
  const receiverAddress = asString(
    firstDefined(rawPlan, [['receiverAddress'], ['receiver'], ['price', 'receiver'], ['pricingConfiguration', 'receiver']]),
  ) ?? priceReceivers[0] ?? null

  const network = asString(
    firstDefined(rawPlan, [
      ['network'],
      ['metadata', 'plan', 'fiatPaymentProvider'],
      ['price', 'network'],
      ['pricingConfiguration', 'network'],
      ['pricingConfig', 'network'],
    ]),
  )

  return {
    nvmPlanId,
    name: asString(firstDefined(rawPlan, [['name'], ['planMetadata', 'name'], ['metadata', 'name'], ['metadata', 'main', 'name']])),
    description: asString(
      firstDefined(rawPlan, [['description'], ['planMetadata', 'description'], ['metadata', 'description'], ['metadata', 'main', 'description']]),
    ),
    planType: asString(firstDefined(rawPlan, [['planType'], ['accessType'], ['metadata', 'plan', 'accessLimit'], ['creditsConfiguration', 'type']])),
    pricingType,
    priceAmount,
    tokenAddress,
    tokenSymbol,
    fiatAmountCents: deriveFiatAmountCents(rawPlan, pricingType, priceAmount),
    fiatCurrency: asString(
      firstDefined(rawPlan, [['fiatCurrency'], ['price', 'fiatCurrency'], ['pricingConfiguration', 'fiatCurrency']]),
    ),
    network,
    receiverAddress,
    creditsGranted: asNumericString(
      firstDefined(rawPlan, [['creditsGranted'], ['credits'], ['registry', 'credits', 'amount'], ['creditsConfiguration', 'amountOfCredits']]),
    ),
    creditsPerCall: asNumericString(
      firstDefined(rawPlan, [['creditsPerCall'], ['registry', 'credits', 'minAmount'], ['creditsConfiguration', 'minCreditsToCharge']]),
    ),
    creditsMin: asNumericString(
      firstDefined(rawPlan, [['creditsMin'], ['registry', 'credits', 'minAmount'], ['creditsConfiguration', 'minCreditsRequired']]),
    ),
    creditsMax: asNumericString(
      firstDefined(rawPlan, [['creditsMax'], ['registry', 'credits', 'maxAmount'], ['creditsConfiguration', 'maxCreditsToCharge']]),
    ),
    durationSeconds: asInteger(firstDefined(rawPlan, [['durationSeconds'], ['duration'], ['registry', 'credits', 'durationSecs'], ['timeConfiguration', 'duration']])),
    isActive: asBoolean(firstDefined(rawPlan, [['isActive'], ['isListed'], ['metadata', 'curation', 'isListed'], ['active']])),
  }
}
