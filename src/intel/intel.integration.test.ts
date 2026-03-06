import assert from 'node:assert/strict'
import test from 'node:test'

import { config as loadDotEnv } from 'dotenv'

import { closeDbPool, getDbPool, initDbPool } from '../index.js'
import { ensureIntelSchema } from './repository.js'
import { createIntelService } from './service.js'

loadDotEnv()

const RUN_FLAG = (process.env.RUN_INTEL_INTEGRATION_TESTS ?? '').trim().toLowerCase()
const SHOULD_RUN = RUN_FLAG === '1' || RUN_FLAG === 'true'

const REQUIRED_TABLES = [
  'agents',
  'plans',
  'agent_services',
  'agent_computed_stats',
  'reviews',
  'trust_scores',
  'intel_agent_stats_snapshots',
]

async function tableExists(tableName: string): Promise<boolean> {
  const pool = getDbPool()
  const result = await pool.query<{ exists: string | null }>(`SELECT to_regclass($1) AS exists`, [tableName])
  return Boolean(result.rows[0]?.exists)
}

async function ensureTablesReady(): Promise<boolean> {
  for (const table of REQUIRED_TABLES) {
    if (!(await tableExists(table))) {
      return false
    }
  }
  return true
}

function floorMinute(date: Date): Date {
  const copy = new Date(date)
  copy.setUTCSeconds(0, 0)
  return copy
}

test('intel service computes profile, search, trending, avoid, and compare', async (t) => {
  if (!SHOULD_RUN) {
    t.skip('Set RUN_INTEL_INTEGRATION_TESTS=1 to run intel integration tests.')
    return
  }

  await initDbPool()
  const pool = getDbPool()
  await ensureIntelSchema(pool)

  if (!(await ensureTablesReady())) {
    t.skip('Required intel tables do not exist in current database.')
    await closeDbPool()
    return
  }

  const suffix = `intel_it_${Date.now()}`
  const marketplaceIds: [string, string, string] = [`${suffix}_m1`, `${suffix}_m2`, `${suffix}_m3`]
  const nvmIds: [string, string, string] = [`${suffix}_n1`, `${suffix}_n2`, `${suffix}_n3`]
  const wallets: [string, string, string] = [`0x${'a'.repeat(39)}1`, `0x${'a'.repeat(39)}2`, `0x${'a'.repeat(39)}3`]
  const planIds: [string, string, string] = [`${suffix}_p1`, `${suffix}_p2`, `${suffix}_p3`]

  const cleanup = async (): Promise<void> => {
    await pool.query(`DELETE FROM intel_agent_stats_snapshots WHERE agent_id IN (SELECT id FROM agents WHERE marketplace_id = ANY($1::text[]))`, [marketplaceIds])
    await pool.query(`DELETE FROM reviews WHERE agent_id IN (SELECT id FROM agents WHERE marketplace_id = ANY($1::text[]))`, [marketplaceIds])
    await pool.query(`DELETE FROM trust_scores WHERE agent_id IN (SELECT id FROM agents WHERE marketplace_id = ANY($1::text[]))`, [marketplaceIds])
    await pool.query(`DELETE FROM agent_computed_stats WHERE agent_id IN (SELECT id FROM agents WHERE marketplace_id = ANY($1::text[]))`, [marketplaceIds])
    await pool.query(`DELETE FROM agent_services WHERE nvm_plan_id = ANY($1::text[])`, [planIds])
    await pool.query(`DELETE FROM agents WHERE marketplace_id = ANY($1::text[])`, [marketplaceIds])
    await pool.query(`DELETE FROM plans WHERE nvm_plan_id = ANY($1::text[])`, [planIds])
  }

  await cleanup()

  await pool.query(
    `
      INSERT INTO agents (
        marketplace_id,
        team_id,
        nvm_agent_id,
        wallet_address,
        name,
        category,
        description,
        endpoint_url,
        is_active,
        last_synced_at
      )
      VALUES
        ($1, 'team-a', $2, $3, 'Atlas Agent', 'search', 'Atlas search intelligence', 'https://atlas.example/api', TRUE, NOW()),
        ($4, 'team-b', $5, $6, 'Beacon Agent', 'search', 'Beacon search analytics', 'https://beacon.example/api', TRUE, NOW()),
        ($7, 'team-c', $8, $9, 'Cipher Agent', 'search', 'Cipher search workflows', 'https://cipher.example/api', TRUE, NOW())
    `,
    [
      marketplaceIds[0], nvmIds[0], wallets[0],
      marketplaceIds[1], nvmIds[1], wallets[1],
      marketplaceIds[2], nvmIds[2], wallets[2],
    ],
  )

  await pool.query(
    `
      INSERT INTO plans (
        nvm_plan_id,
        name,
        pricing_type,
        fiat_amount_cents,
        token_symbol,
        price_amount,
        network,
        is_active,
        synced_at
      ) VALUES
        ($1, 'Atlas Plan', 'fiat', 12, NULL, NULL, 'stripe', TRUE, NOW()),
        ($2, 'Beacon Plan', 'fiat', 10, NULL, NULL, 'stripe', TRUE, NOW()),
        ($3, 'Cipher Plan', 'erc20', NULL, 'USDC', 120000, 'eip155:84532', TRUE, NOW())
    `,
    planIds,
  )

  await pool.query(
    `
      INSERT INTO agent_services (agent_id, nvm_plan_id, name, is_active, synced_at)
      SELECT id, $1, 'Atlas Search', TRUE, NOW() FROM agents WHERE marketplace_id = $2
      UNION ALL
      SELECT id, $3, 'Beacon Search', TRUE, NOW() FROM agents WHERE marketplace_id = $4
      UNION ALL
      SELECT id, $5, 'Cipher Search', TRUE, NOW() FROM agents WHERE marketplace_id = $6
    `,
    [planIds[0], marketplaceIds[0], planIds[1], marketplaceIds[1], planIds[2], marketplaceIds[2]],
  )

  await pool.query(
    `
      INSERT INTO trust_scores (agent_id, trust_score, score_reliability, score_reviews, tier, review_count, last_computed)
      SELECT id, 82, 0.9, 0.8, 'gold', 2, NOW() FROM agents WHERE marketplace_id = $1
      UNION ALL
      SELECT id, 79, 0.92, 0.7, 'gold', 1, NOW() FROM agents WHERE marketplace_id = $2
      UNION ALL
      SELECT id, 70, 0.88, 0.6, 'silver', 1, NOW() FROM agents WHERE marketplace_id = $3
    `,
    marketplaceIds,
  )

  await pool.query(
    `
      INSERT INTO reviews (agent_id, reviewer_address, verification_tx, score, score_accuracy, score_speed, score_value, score_reliability, comment)
      SELECT id, '0x111', '0xtx1', 9, 9, 8, 8, 9, 'Very accurate output' FROM agents WHERE marketplace_id = $1
      UNION ALL
      SELECT id, '0x112', '0xtx2', 8, 8, 7, 8, 8, 'Reliable and fast' FROM agents WHERE marketplace_id = $1
      UNION ALL
      SELECT id, '0x113', '0xtx3', 7, 7, 7, 7, 7, 'Good value' FROM agents WHERE marketplace_id = $2
    `,
    [marketplaceIds[0], marketplaceIds[1]],
  )

  const upsertStats = async (rows: Array<{ marketplaceId: string; planId: string; eventType: 'order' | 'burn'; totalOrders?: number; uniqueBuyers?: number; repeatBuyers?: number; totalRequests?: number; successfulBurns?: number; failedBurns?: number; totalCreditsBurned?: number }>): Promise<void> => {
    for (const row of rows) {
      await pool.query(
        `
          INSERT INTO agent_computed_stats (
            agent_id,
            nvm_plan_id,
            event_type,
            total_orders,
            unique_buyers,
            repeat_buyers,
            total_requests,
            successful_burns,
            failed_burns,
            total_credits_burned,
            updated_at
          )
          SELECT
            id,
            $1,
            $2,
            $3,
            $4,
            $5,
            $6,
            $7,
            $8,
            $9,
            NOW()
          FROM agents
          WHERE marketplace_id = $10
          ON CONFLICT (agent_id, nvm_plan_id, event_type)
          DO UPDATE SET
            total_orders = EXCLUDED.total_orders,
            unique_buyers = EXCLUDED.unique_buyers,
            repeat_buyers = EXCLUDED.repeat_buyers,
            total_requests = EXCLUDED.total_requests,
            successful_burns = EXCLUDED.successful_burns,
            failed_burns = EXCLUDED.failed_burns,
            total_credits_burned = EXCLUDED.total_credits_burned,
            updated_at = NOW()
        `,
        [
          row.planId,
          row.eventType,
          row.totalOrders ?? 0,
          row.uniqueBuyers ?? 0,
          row.repeatBuyers ?? 0,
          row.totalRequests ?? 0,
          row.successfulBurns ?? 0,
          row.failedBurns ?? 0,
          row.totalCreditsBurned ?? 0,
          row.marketplaceId,
        ],
      )
    }
  }

  const now = floorMinute(new Date())
  const mid = new Date(now)
  mid.setUTCMinutes(mid.getUTCMinutes() - 30)
  const base = new Date(now)
  base.setUTCMinutes(base.getUTCMinutes() - 60)

  const service = createIntelService(pool, {
    windowMinutes: 30,
    searchResultLimit: 20,
    avoidFailureThreshold: 3,
  })

  await upsertStats([
    { marketplaceId: marketplaceIds[0], planId: planIds[0], eventType: 'order', totalOrders: 10, uniqueBuyers: 8, repeatBuyers: 2 },
    { marketplaceId: marketplaceIds[0], planId: planIds[0], eventType: 'burn', totalRequests: 50, successfulBurns: 48, failedBurns: 2, totalCreditsBurned: 100 },
    { marketplaceId: marketplaceIds[1], planId: planIds[1], eventType: 'order', totalOrders: 20, uniqueBuyers: 20, repeatBuyers: 0 },
    { marketplaceId: marketplaceIds[1], planId: planIds[1], eventType: 'burn', totalRequests: 60, successfulBurns: 58, failedBurns: 2, totalCreditsBurned: 120 },
    { marketplaceId: marketplaceIds[2], planId: planIds[2], eventType: 'order', totalOrders: 5, uniqueBuyers: 5, repeatBuyers: 0 },
    { marketplaceId: marketplaceIds[2], planId: planIds[2], eventType: 'burn', totalRequests: 25, successfulBurns: 24, failedBurns: 1, totalCreditsBurned: 40 },
  ])
  await service.captureSnapshotNow(base)

  await upsertStats([
    { marketplaceId: marketplaceIds[0], planId: planIds[0], eventType: 'order', totalOrders: 20, uniqueBuyers: 12, repeatBuyers: 4 },
    { marketplaceId: marketplaceIds[0], planId: planIds[0], eventType: 'burn', totalRequests: 70, successfulBurns: 66, failedBurns: 4, totalCreditsBurned: 140 },
    { marketplaceId: marketplaceIds[1], planId: planIds[1], eventType: 'order', totalOrders: 30, uniqueBuyers: 25, repeatBuyers: 2 },
    { marketplaceId: marketplaceIds[1], planId: planIds[1], eventType: 'burn', totalRequests: 80, successfulBurns: 77, failedBurns: 3, totalCreditsBurned: 150 },
    { marketplaceId: marketplaceIds[2], planId: planIds[2], eventType: 'order', totalOrders: 8, uniqueBuyers: 7, repeatBuyers: 1 },
    { marketplaceId: marketplaceIds[2], planId: planIds[2], eventType: 'burn', totalRequests: 35, successfulBurns: 33, failedBurns: 2, totalCreditsBurned: 55 },
  ])
  await service.captureSnapshotNow(mid)

  await upsertStats([
    { marketplaceId: marketplaceIds[0], planId: planIds[0], eventType: 'order', totalOrders: 35, uniqueBuyers: 18, repeatBuyers: 9 },
    { marketplaceId: marketplaceIds[0], planId: planIds[0], eventType: 'burn', totalRequests: 100, successfulBurns: 90, failedBurns: 10, totalCreditsBurned: 200 },
    { marketplaceId: marketplaceIds[1], planId: planIds[1], eventType: 'order', totalOrders: 45, uniqueBuyers: 33, repeatBuyers: 5 },
    { marketplaceId: marketplaceIds[1], planId: planIds[1], eventType: 'burn', totalRequests: 100, successfulBurns: 97, failedBurns: 3, totalCreditsBurned: 180 },
    { marketplaceId: marketplaceIds[2], planId: planIds[2], eventType: 'order', totalOrders: 10, uniqueBuyers: 9, repeatBuyers: 1 },
    { marketplaceId: marketplaceIds[2], planId: planIds[2], eventType: 'burn', totalRequests: 40, successfulBurns: 38, failedBurns: 2, totalCreditsBurned: 70 },
  ])
  await service.captureSnapshotNow(now)

  const profile = await service.getAgentProfile(nvmIds[0])
  assert.equal(profile.agent.nvmAgentId, nvmIds[0])
  assert.ok(profile.failureHistory.last30m.failedBurns >= 3)
  assert.ok(profile.outputQualityNotes.length > 0)

  const search = await service.search('search')
  assert.ok(search.results.length >= 3)
  if (!search.results[0] || !search.results[1]) {
    throw new Error('Expected at least 2 search results for ranking assertion.')
  }
  assert.ok(search.results[0].rankScore >= search.results[1].rankScore)

  const trending = await service.getTrending()
  assert.equal(trending.insufficientWindowData, false)
  assert.ok(trending.agents.length >= 1)
  assert.equal(trending.agents[0]?.agent.nvmAgentId, nvmIds[0])

  const avoid = await service.getAvoidList()
  assert.ok(avoid.agents.some((item) => item.agent.nvmAgentId === nvmIds[0]))

  const compare = await service.compare([nvmIds[0], nvmIds[1], nvmIds[2]])
  assert.equal(compare.agents.length, 3)
  assert.ok(compare.summary.bestReliability)

  await cleanup()
  await closeDbPool()
})
