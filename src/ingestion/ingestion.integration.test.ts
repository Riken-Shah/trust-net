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

function makeDiscoverSeller(input: {
  teamId: string
  nvmAgentId: string
  walletAddress: string
  teamName?: string
  name: string
  endpointUrl: string
  servicesSold?: string
  servicesProvidedPerRequest?: string
  planIds: string[]
  planPrices: number[]
  createdAt?: string
}): Record<string, unknown> {
  return {
    teamId: input.teamId,
    nvmAgentId: input.nvmAgentId,
    walletAddress: input.walletAddress,
    teamName: input.teamName ?? null,
    name: input.name,
    description: `${input.name} description`,
    category: 'Research',
    keywords: ['trust', 'agent'],
    endpointUrl: input.endpointUrl,
    servicesSold: input.servicesSold ?? 'service',
    pricing: {
      servicesPerRequest: input.servicesProvidedPerRequest ?? 'report',
      perRequest: '$0.10',
      meteringUnit: 'per request',
    },
    planIds: input.planIds,
    planPricing: input.planIds.map((planId, index) => ({
      planDid: planId,
      planPrice: input.planPrices[index] ?? input.planPrices[0] ?? 0,
      pricePerRequest: input.planPrices[index] ?? input.planPrices[0] ?? 0,
      pricePerRequestFormatted: '$0.10',
      meteringUnit: 'per request',
      paymentType: 'fiat',
      isTimeBased: false,
      totalRequests: 1,
    })),
    createdAt: input.createdAt ?? '2026-03-06T20:44:16.848Z',
  }
}

function buildConfig(): IngestionConfig {
  return {
    discoverApiUrl: 'https://example.invalid/discover',
    intervalSeconds: 300,
    httpTimeoutMs: 1000,
    retryCount: 0,
    planEnrichConcurrency: 2,
    nvmApiKey: 'sandbox:key',
    nvmEnvironment: 'sandbox',
    chainNetwork: 'eip155:84532',
  }
}

test('runMarketplaceIngestion inserts discover sellers under nvmAgentId, skips unchanged rewrites, and deactivates removed rows', async (t) => {
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
  const nvmAgentId1 = `nvm-${suffix}-1`
  const nvmAgentId2 = `nvm-${suffix}-2`
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
      [[nvmAgentId1, nvmAgentId2]],
    )
    await deleteIfTableExists(
      'trust_scores',
      `DELETE FROM trust_scores WHERE agent_id IN (SELECT id FROM agents WHERE marketplace_id = ANY($1::text[]))`,
      [[nvmAgentId1, nvmAgentId2]],
    )
    await deleteIfTableExists(
      'agent_computed_stats',
      `DELETE FROM agent_computed_stats WHERE agent_id IN (SELECT id FROM agents WHERE marketplace_id = ANY($1::text[]))`,
      [[nvmAgentId1, nvmAgentId2]],
    )
    await pool.query(`DELETE FROM agents WHERE marketplace_id = ANY($1::text[])`, [[nvmAgentId1, nvmAgentId2]])
    await pool.query(`DELETE FROM plans WHERE nvm_plan_id = ANY($1::text[])`, [[plan1, plan2, plan3]])
  }

  await cleanup()

  const config = buildConfig()

  const fetchFirst: typeof fetch = async () => {
    return new Response(
      JSON.stringify({
        sellers: [
          makeDiscoverSeller({
            teamId: 'team-1',
            nvmAgentId: nvmAgentId1,
            walletAddress: wallet1,
            teamName: 'Team One',
            name: 'Seller One',
            endpointUrl: 'https://seller-one.example/mcp',
            servicesProvidedPerRequest: 'report',
            planIds: [plan1, plan2],
            planPrices: [10, 20],
          }),
          makeDiscoverSeller({
            teamId: 'team-2',
            nvmAgentId: nvmAgentId2,
            walletAddress: wallet2,
            teamName: 'Team Two',
            name: 'Seller Two',
            endpointUrl: 'https://seller-two.example/mcp',
            servicesProvidedPerRequest: 'data',
            planIds: [plan3],
            planPrices: [5],
          }),
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

  const countAfterFirst = await pool.query<{ agents: string; plans: string; services: string; price_display: string }>(
    `
      SELECT
        (SELECT COUNT(*)::text FROM agents WHERE marketplace_id = ANY($1::text[])) AS agents,
        (SELECT COUNT(*)::text FROM plans WHERE nvm_plan_id = ANY($2::text[])) AS plans,
        (SELECT COUNT(*)::text FROM agent_services WHERE nvm_plan_id = ANY($2::text[])) AS services,
        (SELECT price_display::text FROM agents WHERE marketplace_id = $3) AS price_display
    `,
    [[nvmAgentId1, nvmAgentId2], [plan1, plan2, plan3], nvmAgentId1],
  )

  assert.equal(countAfterFirst.rows[0]?.agents, '2')
  assert.equal(countAfterFirst.rows[0]?.plans, '3')
  assert.equal(countAfterFirst.rows[0]?.services, '3')
  assert.equal(countAfterFirst.rows[0]?.price_display, '20')

  const beforeSecondRun = await pool.query<{ marketplace_id: string; last_synced_at: Date }>(
    `SELECT marketplace_id, last_synced_at FROM agents WHERE marketplace_id = ANY($1::text[]) ORDER BY marketplace_id`,
    [[nvmAgentId1, nvmAgentId2]],
  )

  await runMarketplaceIngestion(pool, {
    config,
    fetchImpl: fetchFirst,
    planGetter,
  })

  const afterSecondRun = await pool.query<{ marketplace_id: string; last_synced_at: Date }>(
    `SELECT marketplace_id, last_synced_at FROM agents WHERE marketplace_id = ANY($1::text[]) ORDER BY marketplace_id`,
    [[nvmAgentId1, nvmAgentId2]],
  )

  assert.deepEqual(
    afterSecondRun.rows.map((row) => ({ marketplace_id: row.marketplace_id, last_synced_at: row.last_synced_at.toISOString() })),
    beforeSecondRun.rows.map((row) => ({ marketplace_id: row.marketplace_id, last_synced_at: row.last_synced_at.toISOString() })),
  )

  const fetchSecond: typeof fetch = async () => {
    return new Response(
      JSON.stringify({
        sellers: [
          makeDiscoverSeller({
            teamId: 'team-1',
            nvmAgentId: nvmAgentId1,
            walletAddress: wallet1,
            teamName: 'Team One',
            name: 'Seller One',
            endpointUrl: 'https://seller-one.example/mcp',
            servicesProvidedPerRequest: 'report',
            planIds: [plan1],
            planPrices: [10],
          }),
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
    [[nvmAgentId1, nvmAgentId2]],
  )

  assert.deepEqual(status.rows, [
    { marketplace_id: nvmAgentId1, is_active: true },
    { marketplace_id: nvmAgentId2, is_active: false },
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

test('runMarketplaceIngestion preserves legacy marketplace_id, backfills nvm_agent_id, and resets verification when endpoint changes', async (t) => {
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

  const suffix = `legacy_${Date.now()}`
  const legacyMarketplaceId = `legacy-${suffix}`
  const nvmAgentId = `nvm-${suffix}`
  const wallet = `0x${Date.now().toString(16).padEnd(40, 'c').slice(0, 40)}`
  const planId = `plan-${suffix}`
  const oldEndpoint = 'https://legacy.example/old'
  const newEndpoint = 'https://legacy.example/new'

  const cleanup = async (): Promise<void> => {
    await pool.query(`DELETE FROM blockchain_sync WHERE filter_key = ANY($1::text[])`, [[wallet, planId]])
    await pool.query(`DELETE FROM agent_services WHERE nvm_plan_id = $1`, [planId])
    await deleteIfTableExists(
      'reviews',
      `DELETE FROM reviews WHERE agent_id IN (SELECT id FROM agents WHERE marketplace_id IN ($1, $2))`,
      [legacyMarketplaceId, nvmAgentId],
    )
    await deleteIfTableExists(
      'trust_scores',
      `DELETE FROM trust_scores WHERE agent_id IN (SELECT id FROM agents WHERE marketplace_id IN ($1, $2))`,
      [legacyMarketplaceId, nvmAgentId],
    )
    await deleteIfTableExists(
      'agent_computed_stats',
      `DELETE FROM agent_computed_stats WHERE agent_id IN (SELECT id FROM agents WHERE marketplace_id IN ($1, $2))`,
      [legacyMarketplaceId, nvmAgentId],
    )
    await pool.query(`DELETE FROM agents WHERE marketplace_id IN ($1, $2)`, [legacyMarketplaceId, nvmAgentId])
    await pool.query(`DELETE FROM plans WHERE nvm_plan_id = $1`, [planId])
  }

  await cleanup()

  await pool.query(
    `
      INSERT INTO plans (nvm_plan_id, is_active, synced_at)
      VALUES ($1, TRUE, NOW())
      ON CONFLICT (nvm_plan_id) DO NOTHING
    `,
    [planId],
  )

  const seededAgent = await pool.query<{ id: string }>(
    `
      INSERT INTO agents (
        marketplace_id,
        team_id,
        nvm_agent_id,
        wallet_address,
        team_name,
        name,
        description,
        category,
        keywords,
        marketplace_ready,
        endpoint_url,
        services_sold,
        services_provided_per_req,
        price_per_request_display,
        price_metering_unit,
        price_display,
        api_created_at,
        api_updated_at,
        last_synced_at,
        is_active,
        is_verified
      )
      VALUES (
        $1, $2, NULL, $3, $4, $5, $6, $7, $8::text[],
        TRUE, $9, $10, $11, $12, $13, $14, $15, NULL, $16, TRUE, TRUE
      )
      RETURNING id
    `,
    [
      legacyMarketplaceId,
      'legacy-team',
      wallet,
      'Legacy Team',
      'Legacy Seller',
      'old description',
      'Research',
      ['legacy'],
      oldEndpoint,
      'legacy service',
      'legacy report',
      '$1.00',
      'per request',
      5,
      '2026-03-05T00:00:00.000Z',
      '2026-03-06T00:00:00.000Z',
    ],
  )

  await pool.query(
    `
      INSERT INTO agent_services (agent_id, nvm_plan_id, name, description, endpoint_url, is_active, synced_at)
      VALUES ($1, $2, 'Legacy Plan', 'legacy report', $3, TRUE, NOW())
    `,
    [seededAgent.rows[0]?.id, planId, oldEndpoint],
  )

  const result = await runMarketplaceIngestion(pool, {
    config: buildConfig(),
    fetchImpl: async () => new Response(
      JSON.stringify({
        sellers: [
          makeDiscoverSeller({
            teamId: 'legacy-team',
            nvmAgentId,
            walletAddress: wallet,
            teamName: 'Legacy Team',
            name: 'Legacy Seller',
            endpointUrl: newEndpoint,
            servicesProvidedPerRequest: 'legacy report',
            planIds: [planId],
            planPrices: [9],
          }),
        ],
        buyers: [],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ),
    planGetter: async () => ({ name: 'Legacy Plan', isActive: true }),
  })

  assert.equal(result.persisted.agentsUpserted, 1)

  const rows = await pool.query<{
    marketplace_id: string
    nvm_agent_id: string | null
    endpoint_url: string | null
    is_verified: boolean
    is_active: boolean
  }>(
    `
      SELECT marketplace_id, nvm_agent_id, endpoint_url, is_verified, is_active
      FROM agents
      WHERE marketplace_id IN ($1, $2)
      ORDER BY marketplace_id
    `,
    [legacyMarketplaceId, nvmAgentId],
  )

  assert.deepEqual(rows.rows, [
    {
      marketplace_id: legacyMarketplaceId,
      nvm_agent_id: nvmAgentId,
      endpoint_url: newEndpoint,
      is_verified: false,
      is_active: true,
    },
  ])

  await cleanup()
  await closeDbPool()
})

test('runMarketplaceIngestion rejects ambiguous legacy matches without merging or deactivating them', async (t) => {
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

  const suffix = `amb_${Date.now()}`
  const marketplaceId1 = `legacy-a-${suffix}`
  const marketplaceId2 = `legacy-b-${suffix}`
  const nvmAgentId = `nvm-${suffix}`
  const planId = `plan-${suffix}`
  const wallet = `0x${Date.now().toString(16).padEnd(40, 'd').slice(0, 40)}`
  const endpoint = 'https://ambiguous.example/mcp'

  const cleanup = async (): Promise<void> => {
    await pool.query(`DELETE FROM blockchain_sync WHERE filter_key = ANY($1::text[])`, [[wallet, planId]])
    await pool.query(`DELETE FROM agent_services WHERE nvm_plan_id = $1`, [planId])
    await deleteIfTableExists(
      'reviews',
      `DELETE FROM reviews WHERE agent_id IN (SELECT id FROM agents WHERE marketplace_id = ANY($1::text[]))`,
      [[marketplaceId1, marketplaceId2, nvmAgentId]],
    )
    await deleteIfTableExists(
      'trust_scores',
      `DELETE FROM trust_scores WHERE agent_id IN (SELECT id FROM agents WHERE marketplace_id = ANY($1::text[]))`,
      [[marketplaceId1, marketplaceId2, nvmAgentId]],
    )
    await deleteIfTableExists(
      'agent_computed_stats',
      `DELETE FROM agent_computed_stats WHERE agent_id IN (SELECT id FROM agents WHERE marketplace_id = ANY($1::text[]))`,
      [[marketplaceId1, marketplaceId2, nvmAgentId]],
    )
    await pool.query(`DELETE FROM agents WHERE marketplace_id = ANY($1::text[])`, [[marketplaceId1, marketplaceId2, nvmAgentId]])
    await pool.query(`DELETE FROM plans WHERE nvm_plan_id = $1`, [planId])
  }

  await cleanup()

  await pool.query(
    `
      INSERT INTO plans (nvm_plan_id, is_active, synced_at)
      VALUES ($1, TRUE, NOW())
      ON CONFLICT (nvm_plan_id) DO NOTHING
    `,
    [planId],
  )

  const seededAgents = await pool.query<{ id: string; marketplace_id: string }>(
    `
      INSERT INTO agents (
        marketplace_id,
        team_id,
        nvm_agent_id,
        wallet_address,
        team_name,
        name,
        description,
        category,
        keywords,
        marketplace_ready,
        endpoint_url,
        last_synced_at,
        is_active
      )
      VALUES
        ($1, 'shared-team', NULL, $3, 'Shared Team', 'Shared Seller', 'A', 'Research', ARRAY['a']::text[], TRUE, $4, $5, TRUE),
        ($2, 'shared-team', NULL, $3, 'Shared Team', 'Shared Seller', 'B', 'Research', ARRAY['b']::text[], TRUE, $4, $5, TRUE)
      RETURNING id, marketplace_id
    `,
    [marketplaceId1, marketplaceId2, wallet, endpoint, '2026-03-06T00:00:00.000Z'],
  )

  for (const row of seededAgents.rows) {
    await pool.query(
      `
        INSERT INTO agent_services (agent_id, nvm_plan_id, name, description, endpoint_url, is_active, synced_at)
        VALUES ($1, $2, 'Shared Plan', 'shared report', $3, TRUE, NOW())
      `,
      [row.id, planId, endpoint],
    )
  }

  const result = await runMarketplaceIngestion(pool, {
    config: buildConfig(),
    fetchImpl: async () => new Response(
      JSON.stringify({
        sellers: [
          makeDiscoverSeller({
            teamId: 'shared-team',
            nvmAgentId,
            walletAddress: wallet,
            teamName: 'Shared Team',
            name: 'Shared Seller',
            endpointUrl: endpoint,
            servicesProvidedPerRequest: 'shared report',
            planIds: [planId],
            planPrices: [7],
          }),
        ],
        buyers: [],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ),
    planGetter: async () => ({ name: 'Shared Plan', isActive: true }),
  })

  assert.equal(result.persisted.agentsUpserted, 0)

  const agents = await pool.query<{ marketplace_id: string; nvm_agent_id: string | null; is_active: boolean }>(
    `
      SELECT marketplace_id, nvm_agent_id, is_active
      FROM agents
      WHERE marketplace_id = ANY($1::text[])
      ORDER BY marketplace_id
    `,
    [[marketplaceId1, marketplaceId2, nvmAgentId]],
  )

  assert.deepEqual(agents.rows, [
    { marketplace_id: marketplaceId1, nvm_agent_id: null, is_active: true },
    { marketplace_id: marketplaceId2, nvm_agent_id: null, is_active: true },
  ])

  const services = await pool.query<{ active_services: string }>(
    `
      SELECT COUNT(*)::text AS active_services
      FROM agent_services
      WHERE is_active = TRUE
      AND nvm_plan_id = $1
    `,
    [planId],
  )

  assert.equal(services.rows[0]?.active_services, '2')

  await cleanup()
  await closeDbPool()
})
