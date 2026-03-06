import { type SupportedNvmEnvironment } from './planEnrichmentClient.js'

const DEFAULT_DISCOVER_API_URL = 'https://nevermined.ai/hackathon/register/api/discover?side=all'
const DEFAULT_INGEST_INTERVAL_SECONDS = 300
const DEFAULT_INGEST_HTTP_TIMEOUT_MS = 15000
const DEFAULT_INGEST_RETRY_COUNT = 2
const DEFAULT_PLAN_ENRICH_CONCURRENCY = 5

export interface IngestionConfig {
  discoverApiUrl: string
  intervalSeconds: number
  httpTimeoutMs: number
  retryCount: number
  planEnrichConcurrency: number
  nvmApiKey: string
  nvmEnvironment: SupportedNvmEnvironment
  chainNetwork: string
}

function asTrimmedEnv(name: string, env: NodeJS.ProcessEnv): string {
  return (env[name] ?? '').trim()
}

function parsePositiveInt(raw: string, envName: string, fallback: number): number {
  if (!raw) {
    return fallback
  }

  const parsed = Number.parseInt(raw, 10)
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${envName} must be a positive integer. Received '${raw}'.`)
  }

  return parsed
}

function parseNonNegativeInt(raw: string, envName: string, fallback: number): number {
  if (!raw) {
    return fallback
  }

  const parsed = Number.parseInt(raw, 10)
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${envName} must be a non-negative integer. Received '${raw}'.`)
  }

  return parsed
}

function parseNvmEnvironment(raw: string): SupportedNvmEnvironment {
  if (raw === 'sandbox' || raw === 'live' || raw === 'staging_sandbox') {
    return raw
  }
  throw new Error("NVM_ENVIRONMENT must be one of: 'sandbox', 'staging_sandbox', 'live'.")
}

function resolveChainNetwork(env: SupportedNvmEnvironment): string {
  if (env === 'live') {
    return 'eip155:8453'
  }
  return 'eip155:84532'
}

export function loadIngestionConfig(env: NodeJS.ProcessEnv = process.env): IngestionConfig {
  const discoverApiUrl = asTrimmedEnv('DISCOVER_API_URL', env) || DEFAULT_DISCOVER_API_URL
  const intervalSeconds = parsePositiveInt(
    asTrimmedEnv('INGEST_INTERVAL_SECONDS', env),
    'INGEST_INTERVAL_SECONDS',
    DEFAULT_INGEST_INTERVAL_SECONDS,
  )
  const httpTimeoutMs = parsePositiveInt(
    asTrimmedEnv('INGEST_HTTP_TIMEOUT_MS', env),
    'INGEST_HTTP_TIMEOUT_MS',
    DEFAULT_INGEST_HTTP_TIMEOUT_MS,
  )
  const retryCount = parseNonNegativeInt(
    asTrimmedEnv('INGEST_RETRY_COUNT', env),
    'INGEST_RETRY_COUNT',
    DEFAULT_INGEST_RETRY_COUNT,
  )
  const planEnrichConcurrency = parsePositiveInt(
    asTrimmedEnv('INGEST_PLAN_ENRICH_CONCURRENCY', env),
    'INGEST_PLAN_ENRICH_CONCURRENCY',
    DEFAULT_PLAN_ENRICH_CONCURRENCY,
  )

  const nvmApiKey = asTrimmedEnv('NVM_API_KEY', env)
  if (!nvmApiKey) {
    throw new Error('NVM_API_KEY is required for discover fetch and plan enrichment.')
  }

  const nvmEnvironment = parseNvmEnvironment(asTrimmedEnv('NVM_ENVIRONMENT', env))

  return {
    discoverApiUrl,
    intervalSeconds,
    httpTimeoutMs,
    retryCount,
    planEnrichConcurrency,
    nvmApiKey,
    nvmEnvironment,
    chainNetwork: resolveChainNetwork(nvmEnvironment),
  }
}
