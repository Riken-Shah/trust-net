import assert from 'node:assert/strict'
import { after, afterEach, before, beforeEach, test } from 'node:test'

import { config as loadDotEnv } from 'dotenv'

import { defaultDbPort } from './config.js'
import { closeDbPool, getDbPool, initDbPool, pingDb } from './pool.js'

loadDotEnv()

const DB_ENV_KEYS = [
  'DATABASE_URL',
  'SUPABASE_PASSWORD',
  'DB_HOST',
  'DB_PORT',
  'DB_NAME',
  'DB_USER',
  'DB_POOL_MODE',
  'DB_SSL',
] as const

const PASSWORD_PLACEHOLDERS = new Set(['[YOUR-PASSWORD]', '<YOUR-PASSWORD>', 'YOUR-PASSWORD'])

type DbEnvKey = (typeof DB_ENV_KEYS)[number]

interface ConnectionParts {
  host: string
  port: number
  dbName: string
  user: string
  password: string
}

let baselineEnv: Partial<Record<DbEnvKey, string | undefined>> = {}
let connectionParts: ConnectionParts

function getTrimmedValue(name: DbEnvKey): string {
  return (process.env[name] ?? '').trim()
}

function applyDbEnv(overrides: Partial<Record<DbEnvKey, string | undefined>>): void {
  for (const key of DB_ENV_KEYS) {
    const value = overrides[key]
    if (value === undefined) {
      delete process.env[key]
      continue
    }
    process.env[key] = value
  }
}

function restoreBaselineDbEnv(): void {
  const restored: Partial<Record<DbEnvKey, string | undefined>> = {}
  for (const key of DB_ENV_KEYS) {
    restored[key] = baselineEnv[key]
  }
  applyDbEnv(restored)
}

function decodePath(pathname: string): string {
  const sanitized = pathname.replace(/^\/+/, '')
  return decodeURIComponent(sanitized)
}

function deriveConnectionPartsFromEnv(): ConnectionParts {
  const databaseUrl = getTrimmedValue('DATABASE_URL')

  if (databaseUrl.length > 0) {
    const parsed = new URL(databaseUrl)
    const user = decodeURIComponent(parsed.username)
    const rawPassword = decodeURIComponent(parsed.password)
    const supabasePassword = getTrimmedValue('SUPABASE_PASSWORD')

    const password = PASSWORD_PLACEHOLDERS.has(rawPassword) ? supabasePassword : rawPassword
    const dbName = decodePath(parsed.pathname)
    const port = parsed.port.length > 0 ? Number.parseInt(parsed.port, 10) : defaultDbPort()

    if (!parsed.hostname || !user || !password || !dbName || !Number.isInteger(port) || port <= 0) {
      throw new Error(
        'Integration tests require complete DB credentials. Ensure DATABASE_URL or DB_* + SUPABASE_PASSWORD are set.',
      )
    }

    return {
      host: parsed.hostname,
      port,
      dbName,
      user,
      password,
    }
  }

  const host = getTrimmedValue('DB_HOST')
  const portRaw = getTrimmedValue('DB_PORT')
  const dbName = getTrimmedValue('DB_NAME')
  const user = getTrimmedValue('DB_USER')
  const password = getTrimmedValue('SUPABASE_PASSWORD')
  const port = portRaw.length > 0 ? Number.parseInt(portRaw, 10) : Number.NaN

  if (!host || !dbName || !user || !password || !Number.isInteger(port) || port <= 0) {
    throw new Error(
      'Integration tests require complete DB credentials. Ensure DATABASE_URL or DB_* + SUPABASE_PASSWORD are set.',
    )
  }

  return {
    host,
    port,
    dbName,
    user,
    password,
  }
}

function buildPlaceholderDatabaseUrl(parts: ConnectionParts): string {
  return `postgresql://${encodeURIComponent(parts.user)}:[YOUR-PASSWORD]@${parts.host}:${parts.port}/${encodeURIComponent(parts.dbName)}`
}

before(async () => {
  for (const key of DB_ENV_KEYS) {
    baselineEnv[key] = process.env[key]
  }
  connectionParts = deriveConnectionPartsFromEnv()
  await closeDbPool()
})

beforeEach(async () => {
  restoreBaselineDbEnv()
  await closeDbPool()
})

afterEach(async () => {
  await closeDbPool()
})

after(async () => {
  restoreBaselineDbEnv()
  await closeDbPool()
})

test('initDbPool resolves DATABASE_URL password placeholders and pings Supabase', async () => {
  applyDbEnv({
    DATABASE_URL: buildPlaceholderDatabaseUrl(connectionParts),
    SUPABASE_PASSWORD: connectionParts.password,
    DB_HOST: undefined,
    DB_PORT: undefined,
    DB_NAME: undefined,
    DB_USER: undefined,
    DB_POOL_MODE: 'transaction',
    DB_SSL: 'true',
  })

  const pool = await initDbPool()
  assert.equal(pool, getDbPool())
  await pingDb()
})

test('pingDb verifies SELECT 1 result', async () => {
  applyDbEnv({
    DATABASE_URL: buildPlaceholderDatabaseUrl(connectionParts),
    SUPABASE_PASSWORD: connectionParts.password,
    DB_POOL_MODE: 'transaction',
    DB_SSL: 'true',
  })

  await initDbPool()
  await pingDb()
  const result = await getDbPool().query<{ one: number }>('SELECT 1 AS one')
  assert.equal(result.rows[0]?.one, 1)
})

test('concurrent initDbPool calls return one shared pool instance', async () => {
  applyDbEnv({
    DATABASE_URL: buildPlaceholderDatabaseUrl(connectionParts),
    SUPABASE_PASSWORD: connectionParts.password,
    DB_POOL_MODE: 'transaction',
    DB_SSL: 'true',
  })

  const pools = await Promise.all(Array.from({ length: 20 }, () => initDbPool()))
  const firstPool = pools[0]
  assert.ok(firstPool)
  for (const pool of pools) {
    assert.equal(pool, firstPool)
  }
})

test('closeDbPool shuts down the pool and allows re-initialization', async () => {
  applyDbEnv({
    DATABASE_URL: buildPlaceholderDatabaseUrl(connectionParts),
    SUPABASE_PASSWORD: connectionParts.password,
    DB_POOL_MODE: 'transaction',
    DB_SSL: 'true',
  })

  const firstPool = await initDbPool()
  await pingDb()

  await closeDbPool()
  assert.throws(() => getDbPool(), /DB pool is not initialized/)

  const secondPool = await initDbPool()
  await pingDb()
  assert.notEqual(secondPool, firstPool)
})

test('fallback DB_* env configuration connects successfully', async () => {
  applyDbEnv({
    DATABASE_URL: undefined,
    SUPABASE_PASSWORD: connectionParts.password,
    DB_HOST: connectionParts.host,
    DB_PORT: String(connectionParts.port),
    DB_NAME: connectionParts.dbName,
    DB_USER: connectionParts.user,
    DB_POOL_MODE: 'transaction',
    DB_SSL: 'true',
  })

  const pool = await initDbPool()
  assert.equal(pool, getDbPool())
  await pingDb()
})
