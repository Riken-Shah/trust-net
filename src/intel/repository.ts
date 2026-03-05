import { type Pool } from 'pg'

import {
  type IntelAgentProfileRow,
  type IntelRecentReviewRow,
  type IntelSnapshotRow,
  type IntelWindowMetrics,
} from './types.js'

interface RawIntelAgentProfileRow {
  agent_uuid: string
  nvm_agent_id: string
  marketplace_id: string
  name: string
  description: string | null
  category: string | null
  endpoint_url: string | null
  is_active: boolean
  keywords: string[] | null
  services_text: string | null
  plan_names_text: string | null
  total_orders: number | string | null
  unique_buyers: number | string | null
  repeat_buyers: number | string | null
  total_requests: number | string | null
  successful_burns: number | string | null
  failed_burns: number | string | null
  total_credits_burned: number | string | null
  trust_score: number | string | null
  trust_tier: string | null
  trust_reliability: number | string | null
  trust_review_score: number | string | null
  trust_review_count: number | string | null
  avg_review_score: number | string | null
  avg_score_accuracy: number | string | null
  avg_score_speed: number | string | null
  avg_score_value: number | string | null
  avg_score_reliability: number | string | null
  min_plan_price_usd: number | string | null
  min_plan_id: string | null
  roi_unavailable_reason: string | null
}

interface RawIntelWindowMetricsRow {
  agent_id: string
  order_delta_30m: number | string | null
  unique_buyers_delta_30m: number | string | null
  repeat_buyers_delta_30m: number | string | null
  total_requests_delta_30m: number | string | null
  successful_burns_delta_30m: number | string | null
  failed_burns_delta_30m: number | string | null
  total_credits_burned_delta_30m: number | string | null
  latest_snapshot_at: Date
  baseline_snapshot_at: Date | null
  window_data_available: boolean
}

interface RawIntelSnapshotRow {
  snapshot_at: Date
  agent_id: string
  total_orders: number | string | null
  unique_buyers: number | string | null
  repeat_buyers: number | string | null
  total_requests: number | string | null
  successful_burns: number | string | null
  failed_burns: number | string | null
  total_credits_burned: number | string | null
}

const AGENT_PROFILE_SELECT = `
  WITH order_stats AS (
    SELECT
      agent_id,
      COALESCE(SUM(total_orders), 0)::double precision AS total_orders,
      COALESCE(SUM(unique_buyers), 0)::double precision AS unique_buyers,
      COALESCE(SUM(repeat_buyers), 0)::double precision AS repeat_buyers
    FROM agent_computed_stats
    WHERE event_type = 'order'
    GROUP BY agent_id
  ),
  burn_stats AS (
    SELECT
      agent_id,
      COALESCE(SUM(total_requests), 0)::double precision AS total_requests,
      COALESCE(SUM(successful_burns), 0)::double precision AS successful_burns,
      COALESCE(SUM(failed_burns), 0)::double precision AS failed_burns,
      COALESCE(SUM(total_credits_burned), 0)::double precision AS total_credits_burned
    FROM agent_computed_stats
    WHERE event_type = 'burn'
    GROUP BY agent_id
  ),
  review_stats AS (
    SELECT
      agent_id,
      AVG(score)::double precision AS avg_review_score,
      AVG(score_accuracy)::double precision AS avg_score_accuracy,
      AVG(score_speed)::double precision AS avg_score_speed,
      AVG(score_value)::double precision AS avg_score_value,
      AVG(score_reliability)::double precision AS avg_score_reliability,
      COUNT(*)::double precision AS review_count
    FROM reviews
    GROUP BY agent_id
  ),
  plan_text AS (
    SELECT
      services.agent_id,
      string_agg(DISTINCT COALESCE(services.name, ''), ' ') AS services_text,
      string_agg(DISTINCT COALESCE(plans.name, ''), ' ') AS plan_names_text,
      bool_or(
        plans.fiat_amount_cents IS NOT NULL
        OR (plans.token_symbol IN ('USDC', 'USDT') AND plans.price_amount IS NOT NULL)
      ) AS has_supported_pricing
    FROM agent_services AS services
    JOIN plans ON plans.nvm_plan_id = services.nvm_plan_id
    WHERE services.is_active = TRUE
      AND plans.is_active = TRUE
    GROUP BY services.agent_id
  ),
  price_candidates AS (
    SELECT
      services.agent_id,
      plans.nvm_plan_id,
      CASE
        WHEN plans.fiat_amount_cents IS NOT NULL THEN plans.fiat_amount_cents::double precision / 100.0
        WHEN plans.token_symbol IN ('USDC', 'USDT') AND plans.price_amount IS NOT NULL THEN plans.price_amount::double precision / 1000000.0
        ELSE NULL
      END AS plan_price_usd
    FROM agent_services AS services
    JOIN plans ON plans.nvm_plan_id = services.nvm_plan_id
    WHERE services.is_active = TRUE
      AND plans.is_active = TRUE
  ),
  cheapest_plan AS (
    SELECT DISTINCT ON (agent_id)
      agent_id,
      nvm_plan_id,
      plan_price_usd
    FROM price_candidates
    WHERE plan_price_usd IS NOT NULL
    ORDER BY agent_id, plan_price_usd ASC, nvm_plan_id ASC
  )
  SELECT
    agents.id AS agent_uuid,
    agents.nvm_agent_id,
    agents.marketplace_id,
    agents.name,
    agents.description,
    agents.category,
    agents.endpoint_url,
    agents.is_active,
    agents.keywords,
    plan_text.services_text,
    plan_text.plan_names_text,
    COALESCE(order_stats.total_orders, 0) AS total_orders,
    COALESCE(order_stats.unique_buyers, 0) AS unique_buyers,
    COALESCE(order_stats.repeat_buyers, 0) AS repeat_buyers,
    COALESCE(burn_stats.total_requests, 0) AS total_requests,
    COALESCE(burn_stats.successful_burns, 0) AS successful_burns,
    COALESCE(burn_stats.failed_burns, 0) AS failed_burns,
    COALESCE(burn_stats.total_credits_burned, 0) AS total_credits_burned,
    trust_scores.trust_score::double precision AS trust_score,
    trust_scores.tier AS trust_tier,
    trust_scores.score_reliability::double precision AS trust_reliability,
    trust_scores.score_reviews::double precision AS trust_review_score,
    COALESCE(trust_scores.review_count, review_stats.review_count, 0) AS trust_review_count,
    review_stats.avg_review_score,
    review_stats.avg_score_accuracy,
    review_stats.avg_score_speed,
    review_stats.avg_score_value,
    review_stats.avg_score_reliability,
    cheapest_plan.plan_price_usd AS min_plan_price_usd,
    cheapest_plan.nvm_plan_id AS min_plan_id,
    CASE
      WHEN cheapest_plan.nvm_plan_id IS NULL AND COALESCE(plan_text.has_supported_pricing, FALSE) = FALSE
        THEN 'no_supported_usd_plan'
      WHEN cheapest_plan.nvm_plan_id IS NULL
        THEN 'pricing_unavailable'
      ELSE NULL
    END AS roi_unavailable_reason
  FROM agents
  LEFT JOIN order_stats ON order_stats.agent_id = agents.id
  LEFT JOIN burn_stats ON burn_stats.agent_id = agents.id
  LEFT JOIN review_stats ON review_stats.agent_id = agents.id
  LEFT JOIN trust_scores ON trust_scores.agent_id = agents.id
  LEFT JOIN plan_text ON plan_text.agent_id = agents.id
  LEFT JOIN cheapest_plan ON cheapest_plan.agent_id = agents.id
  WHERE agents.is_active = TRUE
    AND agents.nvm_agent_id IS NOT NULL
`

function toNumber(value: number | string | null | undefined): number {
  if (typeof value === 'number') {
    return value
  }
  if (typeof value === 'string') {
    const parsed = Number.parseFloat(value)
    return Number.isFinite(parsed) ? parsed : 0
  }
  return 0
}

function toNullableNumber(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined) {
    return null
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null
  }
  const parsed = Number.parseFloat(value)
  return Number.isFinite(parsed) ? parsed : null
}

function mapProfileRow(row: RawIntelAgentProfileRow): IntelAgentProfileRow {
  return {
    agentUuid: row.agent_uuid,
    nvmAgentId: row.nvm_agent_id,
    marketplaceId: row.marketplace_id,
    name: row.name,
    description: row.description,
    category: row.category,
    endpointUrl: row.endpoint_url,
    isActive: row.is_active,
    keywords: row.keywords ?? [],
    servicesText: row.services_text,
    planNamesText: row.plan_names_text,
    totalOrders: toNumber(row.total_orders),
    uniqueBuyers: toNumber(row.unique_buyers),
    repeatBuyers: toNumber(row.repeat_buyers),
    totalRequests: toNumber(row.total_requests),
    successfulBurns: toNumber(row.successful_burns),
    failedBurns: toNumber(row.failed_burns),
    totalCreditsBurned: toNumber(row.total_credits_burned),
    trustScore: toNullableNumber(row.trust_score),
    trustTier: row.trust_tier,
    trustReliability: toNullableNumber(row.trust_reliability),
    trustReviewScore: toNullableNumber(row.trust_review_score),
    trustReviewCount: toNumber(row.trust_review_count),
    avgReviewScore: toNullableNumber(row.avg_review_score),
    avgScoreAccuracy: toNullableNumber(row.avg_score_accuracy),
    avgScoreSpeed: toNullableNumber(row.avg_score_speed),
    avgScoreValue: toNullableNumber(row.avg_score_value),
    avgScoreReliability: toNullableNumber(row.avg_score_reliability),
    minPlanPriceUsd: toNullableNumber(row.min_plan_price_usd),
    minPlanId: row.min_plan_id,
    roiUnavailableReason: row.roi_unavailable_reason,
  }
}

function mapSnapshotRow(row: RawIntelSnapshotRow): IntelSnapshotRow {
  return {
    snapshotAt: row.snapshot_at,
    agentId: row.agent_id,
    totalOrders: toNumber(row.total_orders),
    uniqueBuyers: toNumber(row.unique_buyers),
    repeatBuyers: toNumber(row.repeat_buyers),
    totalRequests: toNumber(row.total_requests),
    successfulBurns: toNumber(row.successful_burns),
    failedBurns: toNumber(row.failed_burns),
    totalCreditsBurned: toNumber(row.total_credits_burned),
  }
}

function mapWindowMetricsRow(row: RawIntelWindowMetricsRow): IntelWindowMetrics {
  return {
    agentId: row.agent_id,
    orderDelta30m: toNumber(row.order_delta_30m),
    uniqueBuyersDelta30m: toNumber(row.unique_buyers_delta_30m),
    repeatBuyersDelta30m: toNumber(row.repeat_buyers_delta_30m),
    totalRequestsDelta30m: toNumber(row.total_requests_delta_30m),
    successfulBurnsDelta30m: toNumber(row.successful_burns_delta_30m),
    failedBurnsDelta30m: toNumber(row.failed_burns_delta_30m),
    totalCreditsBurnedDelta30m: toNumber(row.total_credits_burned_delta_30m),
    latestSnapshotAt: row.latest_snapshot_at,
    baselineSnapshotAt: row.baseline_snapshot_at,
    windowDataAvailable: row.window_data_available,
  }
}

function truncateToMinute(value: Date): Date {
  const next = new Date(value)
  next.setUTCSeconds(0, 0)
  return next
}

export async function ensureIntelSchema(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS intel_agent_stats_snapshots (
      snapshot_at TIMESTAMPTZ NOT NULL,
      agent_id UUID NOT NULL REFERENCES agents(id),
      total_orders BIGINT NOT NULL DEFAULT 0,
      unique_buyers BIGINT NOT NULL DEFAULT 0,
      repeat_buyers BIGINT NOT NULL DEFAULT 0,
      total_requests BIGINT NOT NULL DEFAULT 0,
      successful_burns BIGINT NOT NULL DEFAULT 0,
      failed_burns BIGINT NOT NULL DEFAULT 0,
      total_credits_burned NUMERIC NOT NULL DEFAULT 0,
      PRIMARY KEY (snapshot_at, agent_id)
    )
  `)

  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_intel_snapshots_snapshot_at_desc ON intel_agent_stats_snapshots (snapshot_at DESC)`,
  )
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_intel_snapshots_agent_snapshot_desc ON intel_agent_stats_snapshots (agent_id, snapshot_at DESC)`,
  )
}

export async function captureIntelAgentStatsSnapshot(pool: Pool, now: Date = new Date()): Promise<{ inserted: number; snapshotAt: Date }> {
  const snapshotAt = truncateToMinute(now)

  const result = await pool.query(
    `
      INSERT INTO intel_agent_stats_snapshots (
        snapshot_at,
        agent_id,
        total_orders,
        unique_buyers,
        repeat_buyers,
        total_requests,
        successful_burns,
        failed_burns,
        total_credits_burned
      )
      SELECT
        $1::timestamptz AS snapshot_at,
        agents.id AS agent_id,
        COALESCE(SUM(CASE WHEN stats.event_type = 'order' THEN stats.total_orders ELSE 0 END), 0)::bigint,
        COALESCE(SUM(CASE WHEN stats.event_type = 'order' THEN stats.unique_buyers ELSE 0 END), 0)::bigint,
        COALESCE(SUM(CASE WHEN stats.event_type = 'order' THEN stats.repeat_buyers ELSE 0 END), 0)::bigint,
        COALESCE(SUM(CASE WHEN stats.event_type = 'burn' THEN stats.total_requests ELSE 0 END), 0)::bigint,
        COALESCE(SUM(CASE WHEN stats.event_type = 'burn' THEN stats.successful_burns ELSE 0 END), 0)::bigint,
        COALESCE(SUM(CASE WHEN stats.event_type = 'burn' THEN stats.failed_burns ELSE 0 END), 0)::bigint,
        COALESCE(SUM(CASE WHEN stats.event_type = 'burn' THEN stats.total_credits_burned ELSE 0 END), 0)
      FROM agents
      LEFT JOIN agent_computed_stats AS stats ON stats.agent_id = agents.id
      WHERE agents.is_active = TRUE
        AND agents.nvm_agent_id IS NOT NULL
      GROUP BY agents.id
      ON CONFLICT (snapshot_at, agent_id)
      DO UPDATE SET
        total_orders = EXCLUDED.total_orders,
        unique_buyers = EXCLUDED.unique_buyers,
        repeat_buyers = EXCLUDED.repeat_buyers,
        total_requests = EXCLUDED.total_requests,
        successful_burns = EXCLUDED.successful_burns,
        failed_burns = EXCLUDED.failed_burns,
        total_credits_burned = EXCLUDED.total_credits_burned
    `,
    [snapshotAt.toISOString()],
  )

  return {
    inserted: result.rowCount ?? 0,
    snapshotAt,
  }
}

export async function fetchAllAgentProfiles(pool: Pool): Promise<IntelAgentProfileRow[]> {
  const result = await pool.query<RawIntelAgentProfileRow>(AGENT_PROFILE_SELECT)
  return result.rows.map(mapProfileRow)
}

export async function fetchAgentProfileByNvmAgentId(pool: Pool, nvmAgentId: string): Promise<IntelAgentProfileRow | null> {
  const result = await pool.query<RawIntelAgentProfileRow>(
    `${AGENT_PROFILE_SELECT} AND agents.nvm_agent_id = $1 LIMIT 1`,
    [nvmAgentId],
  )
  return result.rows[0] ? mapProfileRow(result.rows[0]) : null
}

export async function fetchAgentProfilesByNvmAgentIds(pool: Pool, nvmAgentIds: string[]): Promise<IntelAgentProfileRow[]> {
  if (nvmAgentIds.length === 0) {
    return []
  }

  const result = await pool.query<RawIntelAgentProfileRow>(
    `${AGENT_PROFILE_SELECT} AND agents.nvm_agent_id = ANY($1::text[])`,
    [nvmAgentIds],
  )

  return result.rows.map(mapProfileRow)
}

export async function searchAgentProfiles(pool: Pool, query: string): Promise<IntelAgentProfileRow[]> {
  const normalized = `%${query.trim().toLowerCase()}%`

  const sql = `
    ${AGENT_PROFILE_SELECT}
    AND LOWER(
      CONCAT_WS(
        ' ',
        agents.name,
        COALESCE(agents.description, ''),
        COALESCE(agents.category, ''),
        ARRAY_TO_STRING(COALESCE(agents.keywords, ARRAY[]::text[]), ' '),
        COALESCE(plan_text.services_text, ''),
        COALESCE(plan_text.plan_names_text, '')
      )
    ) LIKE $1
  `

  const result = await pool.query<RawIntelAgentProfileRow>(sql, [normalized])
  return result.rows.map(mapProfileRow)
}

export async function fetchRecentReviewComments(pool: Pool, agentId: string, limit: number): Promise<IntelRecentReviewRow[]> {
  const result = await pool.query<{ comment: string; created_at: Date }>(
    `
      SELECT comment, created_at
      FROM reviews
      WHERE agent_id = $1
        AND comment IS NOT NULL
        AND LENGTH(TRIM(comment)) > 0
      ORDER BY created_at DESC
      LIMIT $2
    `,
    [agentId, limit],
  )

  return result.rows.map((row) => ({
    comment: row.comment,
    createdAt: row.created_at,
  }))
}

export async function fetchWindowMetrics(pool: Pool, windowMinutes: number): Promise<IntelWindowMetrics[]> {
  const result = await pool.query<RawIntelWindowMetricsRow>(
    `
      WITH latest_ts AS (
        SELECT MAX(snapshot_at) AS ts
        FROM intel_agent_stats_snapshots
      ),
      baseline_ts AS (
        SELECT MAX(snapshot_at) AS ts
        FROM intel_agent_stats_snapshots, latest_ts
        WHERE latest_ts.ts IS NOT NULL
          AND snapshot_at <= latest_ts.ts - make_interval(mins => $1::int)
      ),
      latest AS (
        SELECT snapshots.*
        FROM intel_agent_stats_snapshots AS snapshots
        JOIN latest_ts ON latest_ts.ts = snapshots.snapshot_at
      ),
      baseline AS (
        SELECT snapshots.*
        FROM intel_agent_stats_snapshots AS snapshots
        JOIN baseline_ts ON baseline_ts.ts = snapshots.snapshot_at
      )
      SELECT
        latest.agent_id,
        GREATEST(latest.total_orders - COALESCE(baseline.total_orders, 0), 0)::double precision AS order_delta_30m,
        GREATEST(latest.unique_buyers - COALESCE(baseline.unique_buyers, 0), 0)::double precision AS unique_buyers_delta_30m,
        GREATEST(latest.repeat_buyers - COALESCE(baseline.repeat_buyers, 0), 0)::double precision AS repeat_buyers_delta_30m,
        GREATEST(latest.total_requests - COALESCE(baseline.total_requests, 0), 0)::double precision AS total_requests_delta_30m,
        GREATEST(latest.successful_burns - COALESCE(baseline.successful_burns, 0), 0)::double precision AS successful_burns_delta_30m,
        GREATEST(latest.failed_burns - COALESCE(baseline.failed_burns, 0), 0)::double precision AS failed_burns_delta_30m,
        GREATEST(latest.total_credits_burned - COALESCE(baseline.total_credits_burned, 0), 0)::double precision AS total_credits_burned_delta_30m,
        latest.snapshot_at AS latest_snapshot_at,
        baseline.snapshot_at AS baseline_snapshot_at,
        (baseline.snapshot_at IS NOT NULL) AS window_data_available
      FROM latest
      LEFT JOIN baseline ON baseline.agent_id = latest.agent_id
    `,
    [windowMinutes],
  )

  return result.rows.map(mapWindowMetricsRow)
}

export async function fetchAgentSnapshotHistory(pool: Pool, agentId: string, limit: number): Promise<IntelSnapshotRow[]> {
  const result = await pool.query<RawIntelSnapshotRow>(
    `
      SELECT
        snapshot_at,
        agent_id,
        total_orders,
        unique_buyers,
        repeat_buyers,
        total_requests,
        successful_burns,
        failed_burns,
        total_credits_burned
      FROM intel_agent_stats_snapshots
      WHERE agent_id = $1
      ORDER BY snapshot_at DESC
      LIMIT $2
    `,
    [agentId, limit],
  )

  return result.rows.map(mapSnapshotRow)
}
