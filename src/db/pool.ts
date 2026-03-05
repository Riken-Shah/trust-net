import { Pool, type PoolConfig } from 'pg'

import { loadDbConfig, type DbConfig } from './config.js'

let dbPool: Pool | null = null
let initPromise: Promise<Pool> | null = null

function toPoolConfig(config: DbConfig): PoolConfig {
  return {
    connectionString: config.connectionString,
    ssl: config.ssl,
    min: config.min,
    max: config.max,
  }
}

export async function initDbPool(): Promise<Pool> {
  if (dbPool !== null) {
    return dbPool
  }
  if (initPromise !== null) {
    return initPromise
  }

  initPromise = (async () => {
    const config = loadDbConfig()
    const pool = new Pool(toPoolConfig(config))

    pool.on('error', (error: Error) => {
      // Keep errors visible for operators; this should never terminate the process silently.
      console.error('Unexpected error from PostgreSQL pool:', error)
    })

    dbPool = pool
    return pool
  })()

  try {
    return await initPromise
  } catch (error) {
    dbPool = null
    throw error
  } finally {
    initPromise = null
  }
}

export function getDbPool(): Pool {
  if (dbPool === null) {
    throw new Error('DB pool is not initialized. Call initDbPool() during app startup.')
  }
  return dbPool
}

export async function closeDbPool(): Promise<void> {
  if (initPromise !== null) {
    try {
      await initPromise
    } catch {
      // Ignore init failures here; close should be best-effort cleanup.
    }
  }

  if (dbPool === null) {
    return
  }

  const pool = dbPool
  dbPool = null
  await pool.end()
}

export async function pingDb(): Promise<void> {
  const pool = getDbPool()
  const result = await pool.query<{ one: number }>('SELECT 1 AS one')
  const value = result.rows[0]?.one
  if (value !== 1) {
    throw new Error('Database ping failed: SELECT 1 did not return 1.')
  }
}
