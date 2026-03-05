import assert from 'node:assert/strict'
import test from 'node:test'

import { config as loadDotEnv } from 'dotenv'

import { closeDbPool, getDbPool, initDbPool } from '../index.js'
import { type IngestionConfig } from './config.js'
import { runMarketplaceIngestion } from './service.js'

loadDotEnv()

const RUN_FLAG = (process.env.RUN_INGESTION_INTEGRATION_TESTS ?? '').trim().toLowerCase()
const SHOULD_RUN = RUN_FLAG === '1' || RUN_FLAG === 'true'

async function ensureSchemaReady(): Promise<boolean> {
  const pool = getDbPool()
  const requiredTables = ['agents', 'plans', 'agent_services', 'blockchain_sync']

  for (const table of requiredTables) {
    const result = await pool.query<{ exists: string | null }>(
      `SELECT to_regclass($1) AS exists`,
      [table],
    )
    if (!result.rows[0]?.exists) {
      return false
    }
  }

  return true
}

async function tableExists(tableName: string): Promise<boolean> {
  const pool = getDbPool()
  const result = await pool.query<{ exists: string | null }>(`SELECT to_regclass($1) AS exists`, [tableName])
  return Boolean(result.rows[0]?.exists)
}

async function deleteIfTableExists(tableName: string, sql: string, params: unknown[]): Promise<void> {
  const pool = getDbPool()
  if (!(await tableExists(tableName))) {
    return
  }
  await pool.query(sql, params)
}

test('runMarketplaceIngestion upserts, is idempotent, and soft-deactivates removed rows', async (t) => {
  if (!SHOULD_RUN) {
    t.skip('Set RUN_INGESTION_INTEGRATION_TESTS=1 to run ingestion integration tests.')
    return
  }

  await initDbPool()
  const pool = getDbPool()

  const schemaReady = await ensureSchemaReady()
  if (!schemaReady) {
    t.skip('Required ingestion tables do not exist in current database.')
    await closeDbPool()
    return
  }

  const suffix = `it_${Date.now()}`
  const marketplaceId1 = `ingest-${suffix}-1`
  const marketplaceId2 = `ingest-${suffix}-2`
  const walletSeed = Date.now().toString(16).padEnd(40, 'a').slice(0, 40)
  const wallet1 = `0x${walletSeed}`
  const wallet2 = `0x${walletSeed.slice(0, 39)}b`
  const plan1 = `plan-${suffix}-1`
  const plan2 = `plan-${suffix}-2`
  const plan3 = `plan-${suffix}-3`

  const cleanup = async (): Promise<void> => {
    await pool.query(`DELETE FROM blockchain_sync WHERE filter_key = ANY($1::text[])`, [[wallet1, wallet2, plan1, plan2, plan3]])
    await pool.query(`DELETE FROM agent_services WHERE nvm_plan_id = ANY($1::text[])`, [[plan1, plan2, plan3]])
    await deleteIfTableExists(
      'reviews',
      `DELETE FROM reviews WHERE agent_id IN (SELECT id FROM agents WHERE marketplace_id = ANY($1::text[]))`,
      [[marketplaceId1, marketplaceId2]],
    )
    await deleteIfTableExists(
      'trust_scores',
      `DELETE FROM trust_scores WHERE agent_id IN (SELECT id FROM agents WHERE marketplace_id = ANY($1::text[]))`,
      [[marketplaceId1, marketplaceId2]],
    )
    await deleteIfTableExists(
      'agent_computed_stats',
      `DELETE FROM agent_computed_stats WHERE agent_id IN (SELECT id FROM agents WHERE marketplace_id = ANY($1::text[]))`,
      [[marketplaceId1, marketplaceId2]],
    )
    await pool.query(`DELETE FROM agents WHERE marketplace_id = ANY($1::text[])`, [[marketplaceId1, marketplaceId2]])
    await pool.query(`DELETE FROM plans WHERE nvm_plan_id = ANY($1::text[])`, [[plan1, plan2, plan3]])
  }

  await cleanup()

  const config: IngestionConfig = {
    marketplaceApiUrl: 'https://example.invalid/marketplace',
    intervalSeconds: 300,
    httpTimeoutMs: 1000,
    retryCount: 0,
    planEnrichConcurrency: 2,
    nvmApiKey: 'sandbox:key',
    nvmEnvironment: 'sandbox',
    chainNetwork: 'eip155:84532',
  }

  const fetchFirst: typeof fetch = async () => {
    return new Response(
      JSON.stringify({
        sellers: [
          {
            id: marketplaceId1,
            teamId: 'team-1',
            walletAddress: wallet1,
            name: 'Seller One',
            endpointUrl: 'https://seller-one.example/api',
            servicesProvidedPerRequest: 'report',
            planIds: [plan1, plan2],
          },
          {
            id: marketplaceId2,
            teamId: 'team-2',
            walletAddress: wallet2,
            name: 'Seller Two',
            endpointUrl: 'https://seller-two.example/api',
            servicesProvidedPerRequest: 'data',
            planIds: [plan3],
          },
        ],
        buyers: [],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
  }

  const planGetter = async (planId: string): Promise<unknown> => {
    return {
      name: `Plan ${planId}`,
      pricingType: 'erc20',
      priceAmount: '1000000',
      tokenSymbol: 'USDC',
      network: 'eip155:84532',
      creditsGranted: '100',
      creditsPerCall: '1',
      isActive: true,
    }
  }

  const firstRun = await runMarketplaceIngestion(pool, {
    config,
    fetchImpl: fetchFirst,
    planGetter,
  })

  assert.equal(firstRun.fetchedSellers, 2)
  assert.equal(firstRun.normalizedSellers, 2)
  assert.equal(firstRun.rejectedSellers, 0)
  assert.equal(firstRun.uniquePlansDiscovered, 3)

  const countAfterFirst = await pool.query<{ agents: string; plans: string; services: string }>(
    `
      SELECT
        (SELECT COUNT(*)::text FROM agents WHERE marketplace_id = ANY($1::text[])) AS agents,
        (SELECT COUNT(*)::text FROM plans WHERE nvm_plan_id = ANY($2::text[])) AS plans,
        (SELECT COUNT(*)::text FROM agent_services WHERE nvm_plan_id = ANY($2::text[])) AS services
    `,
    [[marketplaceId1, marketplaceId2], [plan1, plan2, plan3]],
  )

  assert.equal(countAfterFirst.rows[0]?.agents, '2')
  assert.equal(countAfterFirst.rows[0]?.plans, '3')
  assert.equal(countAfterFirst.rows[0]?.services, '3')

  await runMarketplaceIngestion(pool, {
    config,
    fetchImpl: fetchFirst,
    planGetter,
  })

  const fetchSecond: typeof fetch = async () => {
    return new Response(
      JSON.stringify({
        sellers: [
          {
            id: marketplaceId1,
            teamId: 'team-1',
            walletAddress: wallet1,
            name: 'Seller One',
            endpointUrl: 'https://seller-one.example/api',
            servicesProvidedPerRequest: 'report',
            planIds: [plan1],
          },
        ],
        buyers: [],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
  }

  await runMarketplaceIngestion(pool, {
    config,
    fetchImpl: fetchSecond,
    planGetter,
  })

  const status = await pool.query<{ marketplace_id: string; is_active: boolean }>(
    `SELECT marketplace_id, is_active FROM agents WHERE marketplace_id = ANY($1::text[]) ORDER BY marketplace_id`,
    [[marketplaceId1, marketplaceId2]],
  )

  assert.deepEqual(status.rows, [
    { marketplace_id: marketplaceId1, is_active: true },
    { marketplace_id: marketplaceId2, is_active: false },
  ])

  const plansStatus = await pool.query<{ nvm_plan_id: string; is_active: boolean }>(
    `SELECT nvm_plan_id, is_active FROM plans WHERE nvm_plan_id = ANY($1::text[]) ORDER BY nvm_plan_id`,
    [[plan1, plan2, plan3]],
  )

  assert.deepEqual(plansStatus.rows, [
    { nvm_plan_id: plan1, is_active: true },
    { nvm_plan_id: plan2, is_active: false },
    { nvm_plan_id: plan3, is_active: false },
  ])

  await cleanup()
  await closeDbPool()
})
