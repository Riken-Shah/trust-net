export interface IntelRuntimeConfig {
  snapshotIntervalSeconds: number
  windowMinutes: number
  searchResultLimit: number
  avoidFailureThreshold: number
}

const DEFAULT_SNAPSHOT_INTERVAL_SECONDS = 60
const DEFAULT_WINDOW_MINUTES = 30
const DEFAULT_SEARCH_RESULT_LIMIT = 50
const DEFAULT_AVOID_FAILURE_THRESHOLD = 3

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

export function loadIntelRuntimeConfig(env: NodeJS.ProcessEnv = process.env): IntelRuntimeConfig {
  const snapshotIntervalSeconds = parsePositiveInt(
    asTrimmedEnv('INTEL_SNAPSHOT_INTERVAL_SECONDS', env),
    'INTEL_SNAPSHOT_INTERVAL_SECONDS',
    DEFAULT_SNAPSHOT_INTERVAL_SECONDS,
  )

  const windowMinutes = parsePositiveInt(
    asTrimmedEnv('INTEL_WINDOW_MINUTES', env),
    'INTEL_WINDOW_MINUTES',
    DEFAULT_WINDOW_MINUTES,
  )

  const searchResultLimit = parsePositiveInt(
    asTrimmedEnv('INTEL_SEARCH_RESULT_LIMIT', env),
    'INTEL_SEARCH_RESULT_LIMIT',
    DEFAULT_SEARCH_RESULT_LIMIT,
  )

  const avoidFailureThreshold = parsePositiveInt(
    asTrimmedEnv('INTEL_AVOID_FAILURE_THRESHOLD', env),
    'INTEL_AVOID_FAILURE_THRESHOLD',
    DEFAULT_AVOID_FAILURE_THRESHOLD,
  )

  return {
    snapshotIntervalSeconds,
    windowMinutes,
    searchResultLimit,
    avoidFailureThreshold,
  }
}
