import { type Pool, type PoolClient } from 'pg'

import { type PlanEnrichment, type PersistResult, type NormalizedSeller } from './types.js'

export interface PersistMarketplaceInput {
  sellers: NormalizedSeller[]
  planEnrichments: Map<string, PlanEnrichment>
  chainNetwork: string
}

interface AgentRow {
  id: string
  marketplace_id: string
}

function serviceNameForPlan(seller: NormalizedSeller, plan: PlanEnrichment | undefined): string {
  if (plan?.name) {
    return plan.name
  }
  return seller.name
}

async function upsertAgent(client: PoolClient, seller: NormalizedSeller): Promise<AgentRow> {
  const result = await client.query<AgentRow>(
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
        is_active
      )
      VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8,
        $9::text[], $10, $11, $12, $13, $14,
        $15, $16, $17, $18, NOW(), TRUE
      )
      ON CONFLICT (marketplace_id)
      DO UPDATE SET
        team_id = EXCLUDED.team_id,
        nvm_agent_id = EXCLUDED.nvm_agent_id,
        wallet_address = EXCLUDED.wallet_address,
        team_name = EXCLUDED.team_name,
        name = EXCLUDED.name,
        description = EXCLUDED.description,
        category = EXCLUDED.category,
        keywords = EXCLUDED.keywords,
        marketplace_ready = EXCLUDED.marketplace_ready,
        endpoint_url = EXCLUDED.endpoint_url,
        services_sold = EXCLUDED.services_sold,
        services_provided_per_req = EXCLUDED.services_provided_per_req,
        price_per_request_display = EXCLUDED.price_per_request_display,
        price_metering_unit = EXCLUDED.price_metering_unit,
        price_display = EXCLUDED.price_display,
        api_created_at = EXCLUDED.api_created_at,
        api_updated_at = EXCLUDED.api_updated_at,
        last_synced_at = NOW(),
        is_active = TRUE
      RETURNING id, marketplace_id
    `,
    [
      seller.marketplaceId,
      seller.teamId,
      seller.nvmAgentId,
      seller.walletAddress,
      seller.teamName,
      seller.name,
      seller.description,
      seller.category,
      seller.keywords,
      seller.marketplaceReady,
      seller.endpointUrl,
      seller.servicesSold,
      seller.servicesProvidedPerRequest,
      seller.pricePerRequestDisplay,
      seller.priceMeteringUnit,
      seller.priceDisplay,
      seller.apiCreatedAt,
      seller.apiUpdatedAt,
    ],
  )

  const row = result.rows[0]
  if (!row) {
    throw new Error(`Failed to upsert agent for marketplace_id=${seller.marketplaceId}.`)
  }

  return row
}

async function upsertPlan(
  client: PoolClient,
  planId: string,
  planEnrichment: PlanEnrichment | undefined,
  chainNetwork: string,
): Promise<void> {
  const fiatCurrency = planEnrichment?.fiatCurrency ?? (planEnrichment?.fiatAmountCents !== null ? 'USD' : null)

  await client.query(
    `
      INSERT INTO plans (
        nvm_plan_id,
        name,
        description,
        plan_type,
        pricing_type,
        price_amount,
        token_address,
        token_symbol,
        fiat_amount_cents,
        fiat_currency,
        network,
        receiver_address,
        credits_granted,
        credits_per_call,
        credits_min,
        credits_max,
        duration_seconds,
        is_active,
        synced_at
      )
      VALUES (
        $1, $2, $3, $4, $5, $6,
        $7, $8, $9, $10, $11, $12,
        $13, $14, $15, $16, $17,
        TRUE, NOW()
      )
      ON CONFLICT (nvm_plan_id)
      DO UPDATE SET
        name = COALESCE(EXCLUDED.name, plans.name),
        description = COALESCE(EXCLUDED.description, plans.description),
        plan_type = COALESCE(EXCLUDED.plan_type, plans.plan_type),
        pricing_type = COALESCE(EXCLUDED.pricing_type, plans.pricing_type),
        price_amount = COALESCE(EXCLUDED.price_amount, plans.price_amount),
        token_address = COALESCE(EXCLUDED.token_address, plans.token_address),
        token_symbol = COALESCE(EXCLUDED.token_symbol, plans.token_symbol),
        fiat_amount_cents = COALESCE(EXCLUDED.fiat_amount_cents, plans.fiat_amount_cents),
        fiat_currency = COALESCE(EXCLUDED.fiat_currency, plans.fiat_currency),
        network = COALESCE(EXCLUDED.network, plans.network),
        receiver_address = COALESCE(EXCLUDED.receiver_address, plans.receiver_address),
        credits_granted = COALESCE(EXCLUDED.credits_granted, plans.credits_granted),
        credits_per_call = COALESCE(EXCLUDED.credits_per_call, plans.credits_per_call),
        credits_min = COALESCE(EXCLUDED.credits_min, plans.credits_min),
        credits_max = COALESCE(EXCLUDED.credits_max, plans.credits_max),
        duration_seconds = COALESCE(EXCLUDED.duration_seconds, plans.duration_seconds),
        is_active = TRUE,
        synced_at = NOW()
    `,
    [
      planId,
      planEnrichment?.name ?? null,
      planEnrichment?.description ?? null,
      planEnrichment?.planType ?? null,
      planEnrichment?.pricingType ?? null,
      planEnrichment?.priceAmount ?? null,
      planEnrichment?.tokenAddress ?? null,
      planEnrichment?.tokenSymbol ?? null,
      planEnrichment?.fiatAmountCents ?? null,
      fiatCurrency,
      planEnrichment?.network ?? chainNetwork,
      planEnrichment?.receiverAddress ?? null,
      planEnrichment?.creditsGranted ?? null,
      planEnrichment?.creditsPerCall ?? null,
      planEnrichment?.creditsMin ?? null,
      planEnrichment?.creditsMax ?? null,
      planEnrichment?.durationSeconds ?? null,
    ],
  )
}

async function upsertAgentService(
  client: PoolClient,
  agentId: string,
  planId: string,
  name: string,
  description: string | null,
  endpointUrl: string | null,
): Promise<void> {
  await client.query(
    `
      INSERT INTO agent_services (
        agent_id,
        nvm_plan_id,
        name,
        description,
        endpoint_url,
        is_active,
        synced_at
      )
      VALUES ($1, $2, $3, $4, $5, TRUE, NOW())
      ON CONFLICT (agent_id, nvm_plan_id)
      DO UPDATE SET
        name = EXCLUDED.name,
        description = EXCLUDED.description,
        endpoint_url = EXCLUDED.endpoint_url,
        is_active = TRUE,
        synced_at = NOW()
    `,
    [agentId, planId, name, description, endpointUrl],
  )
}

async function ensureOrderCheckpoint(client: PoolClient, walletAddress: string, network: string): Promise<number> {
  const result = await client.query(
    `
      INSERT INTO blockchain_sync (event_type, filter_key, network, last_block)
      VALUES ('order', $1, $2, 0)
      ON CONFLICT DO NOTHING
    `,
    [walletAddress, network],
  )

  return result.rowCount ?? 0
}

async function ensureBurnCheckpoint(client: PoolClient, nvmPlanId: string, network: string): Promise<number> {
  const result = await client.query(
    `
      INSERT INTO blockchain_sync (event_type, filter_key, network, last_block)
      VALUES ('burn', $1, $2, 0)
      ON CONFLICT DO NOTHING
    `,
    [nvmPlanId, network],
  )

  return result.rowCount ?? 0
}

async function deactivateAgentsNotInSnapshot(client: PoolClient, marketplaceIds: string[]): Promise<number> {
  if (marketplaceIds.length === 0) {
    const result = await client.query(`UPDATE agents SET is_active = FALSE WHERE is_active = TRUE`)
    return result.rowCount ?? 0
  }

  const result = await client.query(
    `
      UPDATE agents
      SET is_active = FALSE
      WHERE is_active = TRUE
      AND NOT (marketplace_id = ANY($1::text[]))
    `,
    [marketplaceIds],
  )
  return result.rowCount ?? 0
}

async function deactivatePlansNotInSnapshot(client: PoolClient, planIds: string[]): Promise<number> {
  if (planIds.length === 0) {
    const result = await client.query(`UPDATE plans SET is_active = FALSE WHERE is_active = TRUE`)
    return result.rowCount ?? 0
  }

  const result = await client.query(
    `
      UPDATE plans
      SET is_active = FALSE
      WHERE is_active = TRUE
      AND NOT (nvm_plan_id = ANY($1::text[]))
    `,
    [planIds],
  )
  return result.rowCount ?? 0
}

async function deactivateServicesNotInSnapshot(
  client: PoolClient,
  activeAgentIds: string[],
  activePlanIds: string[],
): Promise<number> {
  if (activeAgentIds.length === 0) {
    const result = await client.query(`UPDATE agent_services SET is_active = FALSE WHERE is_active = TRUE`)
    return result.rowCount ?? 0
  }

  const result = await client.query(
    `
      WITH snapshot(agent_id, nvm_plan_id) AS (
        SELECT *
        FROM UNNEST($1::uuid[], $2::text[])
      )
      UPDATE agent_services AS services
      SET is_active = FALSE
      WHERE services.is_active = TRUE
      AND NOT EXISTS (
        SELECT 1
        FROM snapshot
        WHERE snapshot.agent_id = services.agent_id
          AND snapshot.nvm_plan_id = services.nvm_plan_id
      )
    `,
    [activeAgentIds, activePlanIds],
  )

  return result.rowCount ?? 0
}

export async function persistMarketplaceSnapshot(pool: Pool, input: PersistMarketplaceInput): Promise<PersistResult> {
  const client = await pool.connect()

  try {
    await client.query('BEGIN')

    const sellersByMarketplaceId = new Map<string, NormalizedSeller>()
    for (const seller of input.sellers) {
      sellersByMarketplaceId.set(seller.marketplaceId, seller)
    }
    const sellers = [...sellersByMarketplaceId.values()]

    const agentIdByMarketplaceId = new Map<string, string>()
    let agentsUpserted = 0

    for (const seller of sellers) {
      const row = await upsertAgent(client, seller)
      agentsUpserted += 1
      agentIdByMarketplaceId.set(row.marketplace_id, row.id)
    }

    const planIdSet = new Set<string>()
    for (const seller of sellers) {
      for (const planId of seller.planIds) {
        planIdSet.add(planId)
      }
    }
    const planIds = [...planIdSet]

    for (const planId of planIds) {
      await upsertPlan(client, planId, input.planEnrichments.get(planId), input.chainNetwork)
    }

    const activeServiceAgentIds: string[] = []
    const activeServicePlanIds: string[] = []
    let agentServicesUpserted = 0

    for (const seller of sellers) {
      const agentId = agentIdByMarketplaceId.get(seller.marketplaceId)
      if (!agentId) {
        throw new Error(`Missing agent row for marketplace_id=${seller.marketplaceId}.`)
      }

      for (const planId of seller.planIds) {
        const plan = input.planEnrichments.get(planId)
        await upsertAgentService(
          client,
          agentId,
          planId,
          serviceNameForPlan(seller, plan),
          seller.servicesProvidedPerRequest,
          seller.endpointUrl,
        )
        agentServicesUpserted += 1
        activeServiceAgentIds.push(agentId)
        activeServicePlanIds.push(planId)
      }
    }

    let orderCheckpointsInserted = 0
    for (const seller of sellers) {
      orderCheckpointsInserted += await ensureOrderCheckpoint(client, seller.walletAddress, input.chainNetwork)
    }

    let burnCheckpointsInserted = 0
    for (const planId of planIds) {
      burnCheckpointsInserted += await ensureBurnCheckpoint(client, planId, input.chainNetwork)
    }

    const activeMarketplaceIds = sellers.map((seller) => seller.marketplaceId)
    const agentsDeactivated = await deactivateAgentsNotInSnapshot(client, activeMarketplaceIds)
    const plansDeactivated = await deactivatePlansNotInSnapshot(client, planIds)
    const agentServicesDeactivated = await deactivateServicesNotInSnapshot(
      client,
      activeServiceAgentIds,
      activeServicePlanIds,
    )

    await client.query('COMMIT')

    return {
      agentsUpserted,
      plansUpserted: planIds.length,
      agentServicesUpserted,
      orderCheckpointsInserted,
      burnCheckpointsInserted,
      agentsDeactivated,
      plansDeactivated,
      agentServicesDeactivated,
    }
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}
