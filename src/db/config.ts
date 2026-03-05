import { DbConfigError } from './errors.js'

const PASSWORD_PLACEHOLDERS = ['[YOUR-PASSWORD]', '<YOUR-PASSWORD>', 'YOUR-PASSWORD']
const TRUE_VALUES = new Set(['1', 'true', 't', 'yes', 'y', 'on'])
const FALSE_VALUES = new Set(['0', 'false', 'f', 'no', 'n', 'off'])

export type DbSslConfig = false | { rejectUnauthorized: boolean }

export interface DbConfig {
  connectionString: string
  ssl: DbSslConfig
  min: number
  max: number
  poolMode: string
  statementCacheSize: number
}

const DEFAULT_DB_SSL = true
const DEFAULT_DB_PORT = 5432
const DEFAULT_DB_POOL_MODE = 'transaction'

function getTrimmedEnv(name: string, env: NodeJS.ProcessEnv): string {
  return (env[name] ?? '').trim()
}

function parseBoolean(
  rawValue: string | undefined,
  variableName: string,
  defaultValue: boolean,
): boolean {
  if (rawValue === undefined) {
    return defaultValue
  }

  const normalized = rawValue.trim().toLowerCase()
  if (TRUE_VALUES.has(normalized)) {
    return true
  }
  if (FALSE_VALUES.has(normalized)) {
    return false
  }

  throw new DbConfigError(
    `Invalid boolean value '${rawValue}' for ${variableName}. Use true/false.`,
  )
}

function resolvePasswordFromUrl(
  rawDatabaseUrl: string,
  supabasePassword: string,
): string {
  let resolvedUrl = rawDatabaseUrl
  const hasPlaceholder = PASSWORD_PLACEHOLDERS.some((token) => resolvedUrl.includes(token))

  if (hasPlaceholder) {
    if (!supabasePassword) {
      throw new DbConfigError(
        'DATABASE_URL contains a password placeholder but SUPABASE_PASSWORD is not set.',
      )
    }
    const encodedPassword = encodeURIComponent(supabasePassword)
    for (const token of PASSWORD_PLACEHOLDERS) {
      resolvedUrl = resolvedUrl.replaceAll(token, encodedPassword)
    }
  }

  return resolvedUrl
}

function resolveFallbackDatabaseUrl(env: NodeJS.ProcessEnv): string {
  const required = {
    DB_HOST: getTrimmedEnv('DB_HOST', env),
    DB_PORT: getTrimmedEnv('DB_PORT', env),
    DB_NAME: getTrimmedEnv('DB_NAME', env),
    DB_USER: getTrimmedEnv('DB_USER', env),
    SUPABASE_PASSWORD: getTrimmedEnv('SUPABASE_PASSWORD', env),
  }

  const missing = Object.entries(required)
    .filter(([, value]) => value.length === 0)
    .map(([key]) => key)

  if (missing.length > 0) {
    throw new DbConfigError(
      `Missing required DB configuration. Set DATABASE_URL or all of: ${missing.join(', ')}.`,
    )
  }

  const port = Number.parseInt(required.DB_PORT, 10)
  if (!Number.isInteger(port) || port <= 0) {
    throw new DbConfigError('DB_PORT must be a valid integer.')
  }

  const user = encodeURIComponent(required.DB_USER)
  const password = encodeURIComponent(required.SUPABASE_PASSWORD)
  const dbName = encodeURIComponent(required.DB_NAME)

  return `postgresql://${user}:${password}@${required.DB_HOST}:${port}/${dbName}`
}

export function resolveDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const rawDatabaseUrl = getTrimmedEnv('DATABASE_URL', env)
  const supabasePassword = getTrimmedEnv('SUPABASE_PASSWORD', env)

  if (rawDatabaseUrl.length > 0) {
    return resolvePasswordFromUrl(rawDatabaseUrl, supabasePassword)
  }

  return resolveFallbackDatabaseUrl(env)
}

export function resolveDbSslConfig(env: NodeJS.ProcessEnv = process.env): DbSslConfig {
  const enabled = parseBoolean(env.DB_SSL, 'DB_SSL', DEFAULT_DB_SSL)
  if (!enabled) {
    return false
  }
  return { rejectUnauthorized: true }
}

export function resolveStatementCacheSize(env: NodeJS.ProcessEnv = process.env): number {
  const poolMode = getTrimmedEnv('DB_POOL_MODE', env).toLowerCase() || DEFAULT_DB_POOL_MODE
  if (poolMode === 'transaction') {
    return 0
  }
  return 100
}

export function loadDbConfig(env: NodeJS.ProcessEnv = process.env): DbConfig {
  return {
    connectionString: resolveDatabaseUrl(env),
    ssl: resolveDbSslConfig(env),
    min: 1,
    max: 10,
    poolMode: getTrimmedEnv('DB_POOL_MODE', env).toLowerCase() || DEFAULT_DB_POOL_MODE,
    statementCacheSize: resolveStatementCacheSize(env),
  }
}

export function defaultDbPort(): number {
  return DEFAULT_DB_PORT
}
