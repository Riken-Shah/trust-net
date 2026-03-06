import { type BuyerAgentConfig } from './types.js'

const DEFAULT_MODEL = 'gpt-4o-mini'
const DEFAULT_TIMEOUT_MS = 15000
const DEFAULT_PASS_SCORE = 6

export interface BuyerAgentConfigOverrides {
  includeVerifiedSellers?: boolean
}

function getTrimmedEnv(name: string, env: NodeJS.ProcessEnv): string {
  return (env[name] ?? '').trim()
}

function parsePositiveInt(raw: string, name: string, fallback: number): number {
  if (!raw) {
    return fallback
  }

  const value = Number.parseInt(raw, 10)
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer. Received '${raw}'.`)
  }

  return value
}

function parseNullablePositiveInt(raw: string, name: string): number | null {
  if (!raw) {
    return null
  }

  const value = Number.parseInt(raw, 10)
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer when set. Received '${raw}'.`)
  }

  return value
}

function parsePassScore(raw: string): number {
  if (!raw) {
    return DEFAULT_PASS_SCORE
  }

  const value = Number.parseInt(raw, 10)
  if (!Number.isInteger(value) || value < 1 || value > 10) {
    throw new Error(`BUYER_AGENT_PASS_SCORE must be an integer between 1 and 10. Received '${raw}'.`)
  }

  return value
}

function parseBoolean(raw: string, envName: string, fallback: boolean): boolean {
  if (!raw) {
    return fallback
  }

  const normalized = raw.toLowerCase()
  if (normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'on') {
    return true
  }
  if (normalized === 'false' || normalized === '0' || normalized === 'no' || normalized === 'off') {
    return false
  }

  throw new Error(`${envName} must be a boolean value (true/false). Received '${raw}'.`)
}

function parseEnvironment(raw: string): BuyerAgentConfig['nvmEnvironment'] {
  if (raw === 'sandbox' || raw === 'staging_sandbox' || raw === 'live') {
    return raw
  }

  throw new Error("NVM_ENVIRONMENT must be one of: 'sandbox', 'staging_sandbox', 'live'.")
}

export function loadBuyerAgentConfig(
  env: NodeJS.ProcessEnv = process.env,
  overrides: BuyerAgentConfigOverrides = {},
): BuyerAgentConfig {
  const nvmApiKey = getTrimmedEnv('NVM_API_KEY', env) || getTrimmedEnv('NVM_BUYER_API_KEY', env)
  if (!nvmApiKey) {
    throw new Error('NVM_BUYER_API_KEY (or NVM_API_KEY) is required.')
  }

  const nvmEnvironment = parseEnvironment(getTrimmedEnv('NVM_ENVIRONMENT', env) || 'sandbox')

  const openAiApiKey = getTrimmedEnv('OPENAI_API_KEY', env)
  if (!openAiApiKey) {
    throw new Error('OPENAI_API_KEY is required for buyer-agent judgment.')
  }

  return {
    nvmApiKey,
    nvmEnvironment,
    openAiApiKey,
    model: getTrimmedEnv('BUYER_AGENT_MODEL', env) || DEFAULT_MODEL,
    timeoutMs: parsePositiveInt(getTrimmedEnv('BUYER_AGENT_TIMEOUT_MS', env), 'BUYER_AGENT_TIMEOUT_MS', DEFAULT_TIMEOUT_MS),
    passScore: parsePassScore(getTrimmedEnv('BUYER_AGENT_PASS_SCORE', env)),
    maxSellers: parseNullablePositiveInt(getTrimmedEnv('BUYER_AGENT_MAX_SELLERS', env), 'BUYER_AGENT_MAX_SELLERS'),
    targetSeller: getTrimmedEnv('BUYER_AGENT_TARGET_SELLER', env) || null,
    includeVerifiedSellers: overrides.includeVerifiedSellers ?? false,
    includeVerifiedTarget: parseBoolean(
      getTrimmedEnv('BUYER_AGENT_INCLUDE_VERIFIED_TARGET', env),
      'BUYER_AGENT_INCLUDE_VERIFIED_TARGET',
      false,
    ),
    cardDelegation: null,
  }
}
