import { type Pool } from 'pg'

import {
  type BuyerAgentConfig,
  type BuyerAgentRunRow,
  type BuyerAgentRunSummary,
  type JudgmentInsertInput,
  type SellerCandidate,
  type SellerPlan,
  type SetupFailureInput,
} from './types.js'

interface SellerRow {
  id: string
  marketplace_id: string
  nvm_agent_id: string | null
  name: string
  endpoint_url: string
  services_sold: string | null
}

interface SellerPlanRow {
  agent_id: string
  nvm_plan_id: string
  fiat_amount_cents: number | null
  token_symbol: string | null
  price_amount: string | null
}

function asJson(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null
  }
  return JSON.stringify(value)
}

export interface SellerSelectionOptions {
  maxSellers: number | null
  targetSeller: string | null
  includeVerifiedSellers: boolean
  includeVerifiedTarget: boolean
}

export async function fetchSellerCandidates(
  pool: Pool,
  options: SellerSelectionOptions,
): Promise<SellerCandidate[]> {
  const values: Array<string | number | boolean | null> = [
    options.targetSeller,
    options.includeVerifiedSellers,
    options.includeVerifiedTarget,
  ]
  const limitClause = options.maxSellers !== null ? 'LIMIT $4' : ''
  if (options.maxSellers !== null) {
    values.push(options.maxSellers)
  }

  const sellersResult = await pool.query<SellerRow>(
    `
      SELECT
        id,
        marketplace_id,
        nvm_agent_id,
        name,
        endpoint_url,
        services_sold
      FROM agents
      WHERE is_active = TRUE
        AND endpoint_url IS NOT NULL
        AND btrim(endpoint_url) <> ''
        AND (
          is_verified = FALSE
          OR $2::boolean = TRUE
          OR ($1::text IS NOT NULL AND $3::boolean = TRUE)
        )
        AND (
          $1::text IS NULL
          OR (
            id::text = $1
            OR marketplace_id = $1
            OR COALESCE(nvm_agent_id, '') = $1
            OR name = $1
          )
        )
      ORDER BY last_synced_at DESC NULLS LAST, id ASC
      ${limitClause}
    `,
    values,
  )

  if (sellersResult.rows.length === 0) {
    return []
  }

  const agentIds = sellersResult.rows.map((row) => row.id)
  const plansResult = await pool.query<SellerPlanRow>(
    `
      SELECT
        services.agent_id,
        services.nvm_plan_id,
        plans.fiat_amount_cents,
        plans.token_symbol,
        plans.price_amount
      FROM agent_services AS services
      JOIN plans ON plans.nvm_plan_id = services.nvm_plan_id
      WHERE services.is_active = TRUE
        AND plans.is_active = TRUE
        AND services.agent_id = ANY($1::uuid[])
      ORDER BY services.agent_id ASC, services.nvm_plan_id ASC
    `,
    [agentIds],
  )

  const plansByAgent = new Map<string, SellerPlan[]>()
  for (const row of plansResult.rows) {
    const list = plansByAgent.get(row.agent_id) ?? []
    list.push({
      nvmPlanId: row.nvm_plan_id,
      fiatAmountCents: row.fiat_amount_cents,
      tokenSymbol: row.token_symbol,
      priceAmount: row.price_amount,
    })
    plansByAgent.set(row.agent_id, list)
  }

  return sellersResult.rows.map((row) => ({
    agentId: row.id,
    marketplaceId: row.marketplace_id,
    nvmAgentId: row.nvm_agent_id,
    name: row.name,
    endpointUrl: row.endpoint_url,
    servicesSold: row.services_sold,
    plans: plansByAgent.get(row.id) ?? [],
  }))
}

export async function createRun(pool: Pool, config: BuyerAgentConfig): Promise<BuyerAgentRunRow> {
  const result = await pool.query<BuyerAgentRunRow>(
    `
      INSERT INTO buyer_agent_runs (
        model,
        pass_score_threshold,
        max_sellers,
        status
      )
      VALUES ($1, $2, $3, 'running')
      RETURNING id
    `,
    [config.model, config.passScore, config.maxSellers],
  )

  const row = result.rows[0]
  if (!row) {
    throw new Error('Failed to create buyer_agent_runs row.')
  }

  return row
}

export async function completeRun(
  pool: Pool,
  runId: string,
  summary: BuyerAgentRunSummary,
): Promise<void> {
  await pool.query(
    `
      UPDATE buyer_agent_runs
      SET
        finished_at = NOW(),
        status = 'completed',
        sellers_scanned = $2,
        services_attempted = $3,
        services_succeeded = $4,
        services_failed = $5,
        sellers_verified = $6,
        protocol_counts = $7::jsonb,
        error = NULL
      WHERE id = $1
    `,
    [
      runId,
      summary.sellersScanned,
      summary.servicesAttempted,
      summary.servicesSucceeded,
      summary.servicesFailed,
      summary.sellersVerified,
      JSON.stringify(summary.protocolCounts),
    ],
  )
}

export async function failRun(pool: Pool, runId: string, errorMessage: string): Promise<void> {
  await pool.query(
    `
      UPDATE buyer_agent_runs
      SET
        finished_at = NOW(),
        status = 'failed',
        error = $2
      WHERE id = $1
    `,
    [runId, errorMessage.slice(0, 2000)],
  )
}

export async function insertJudgment(pool: Pool, input: JudgmentInsertInput): Promise<void> {
  await pool.query(
    `
      INSERT INTO buyer_agent_judgments (
        run_id,
        agent_id,
        marketplace_id,
        seller_name,
        service_name,
        service_name_normalized,
        protocol,
        plan_id,
        endpoint_url,
        request_payload,
        response_payload,
        response_excerpt,
        purchase_success,
        purchase_error,
        http_status,
        latency_ms,
        tx_hash,
        credits_redeemed,
        remaining_balance,
        payment_meta,
        overall_score,
        score_accuracy,
        score_speed,
        score_value,
        score_reliability,
        verdict,
        rationale,
        passed
      )
      VALUES (
        $1, $2, $3, $4, $5, $6, $7,
        $8, $9, $10::jsonb, $11::jsonb, $12,
        $13, $14, $15, $16, $17,
        $18, $19, $20::jsonb,
        $21, $22, $23, $24, $25,
        $26, $27, $28
      )
    `,
    [
      input.runId,
      input.seller.agentId,
      input.seller.marketplaceId,
      input.seller.name,
      input.service.displayName,
      input.service.normalized,
      input.protocol,
      input.planId,
      input.seller.endpointUrl,
      asJson(input.purchase.requestPayload),
      asJson(input.purchase.responsePayload),
      input.purchase.responseExcerpt,
      input.purchase.purchaseSuccess,
      input.purchase.error,
      input.purchase.httpStatus,
      input.purchase.latencyMs,
      input.purchase.txHash,
      input.purchase.creditsRedeemed,
      input.purchase.remainingBalance,
      asJson(input.purchase.paymentMeta),
      input.judgment.overallScore,
      input.judgment.scoreAccuracy,
      input.judgment.scoreSpeed,
      input.judgment.scoreValue,
      input.judgment.scoreReliability,
      input.judgment.verdict,
      input.judgment.rationale,
      input.passed,
    ],
  )
}

export async function insertSetupFailure(pool: Pool, input: SetupFailureInput): Promise<void> {
  await pool.query(
    `
      INSERT INTO buyer_agent_judgments (
        run_id,
        agent_id,
        marketplace_id,
        seller_name,
        service_name,
        service_name_normalized,
        protocol,
        plan_id,
        endpoint_url,
        purchase_success,
        purchase_error,
        latency_ms,
        passed
      )
      VALUES (
        $1, $2, $3, $4,
        '__setup__', '__setup__',
        $5, $6, $7,
        FALSE, $8, 0, FALSE
      )
    `,
    [
      input.runId,
      input.seller.agentId,
      input.seller.marketplaceId,
      input.seller.name,
      input.protocol,
      input.planId,
      input.seller.endpointUrl,
      input.reason,
    ],
  )
}

export async function markSellerVerified(pool: Pool, agentId: string): Promise<boolean> {
  const result = await pool.query(
    `
      UPDATE agents
      SET is_verified = TRUE
      WHERE id = $1
        AND is_verified = FALSE
    `,
    [agentId],
  )

  return (result.rowCount ?? 0) > 0
}
