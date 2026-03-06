import { type Pool, type PoolClient } from 'pg'

import { type NormalizedSeller, type PersistResult, type PlanEnrichment } from './types.js'

export interface PersistMarketplaceInput {
  sellers: NormalizedSeller[]
  planEnrichments: Map<string, PlanEnrichment>
  chainNetwork: string
}

interface AgentRow {
  id: string
  marketplace_id: string
}

interface AgentIdentityCandidate extends AgentRow {
  plan_overlap: number
  endpoint_match: number
  name_match: number
  team_name_match: number
  last_synced_at: Date | null
}

interface ActiveServiceKey {
  agentId: string
  planId: string
}

interface IdentityResolution {
  marketplaceId: string | null
  protectedMarketplaceIds: string[]
  protectedServiceKeys: ActiveServiceKey[]
}

function serviceNameForPlan(seller: NormalizedSeller, plan: PlanEnrichment | undefined): string {
  if (plan?.name) {
    return plan.name
  }
  return seller.name
}

function compareCandidateRank(left: AgentIdentityCandidate, right: AgentIdentityCandidate): number {
  const comparisons = [
    left.plan_overlap - right.plan_overlap,
    left.endpoint_match - right.endpoint_match,
    left.name_match - right.name_match,
    left.team_name_match - right.team_name_match,
    (left.last_synced_at?.getTime() ?? -1) - (right.last_synced_at?.getTime() ?? -1),
  ]

  for (const comparison of comparisons) {
    if (comparison !== 0) {
      return comparison
    }
  }

  return 0
}

function pickIdentityCandidate(candidates: AgentIdentityCandidate[]): AgentIdentityCandidate | null {
  const firstCandidate = candidates[0]
  if (!firstCandidate) {
    return null
  }
  const secondCandidate = candidates[1]
  if (!secondCandidate) {
    return firstCandidate
  }
  return compareCandidateRank(firstCandidate, secondCandidate) > 0 ? firstCandidate : null
}

async function loadProtectedServiceKeys(client: PoolClient, agentIds: string[]): Promise<ActiveServiceKey[]> {
  if (agentIds.length === 0) {
    return []
  }

  const result = await client.query<{ agent_id: string; nvm_plan_id: string }>(
    `
      SELECT agent_id, nvm_plan_id
      FROM agent_services
      WHERE is_active = TRUE
      AND agent_id = ANY($1::uuid[])
    `,
    [agentIds],
  )

  return result.rows.map((row) => ({
    agentId: row.agent_id,
    planId: row.nvm_plan_id,
  }))
}

async function resolvePersistedMarketplaceId(client: PoolClient, seller: NormalizedSeller): Promise<IdentityResolution> {
  const exactNvmMatches = await client.query<AgentRow>(
    `
      SELECT id, marketplace_id
      FROM agents
      WHERE nvm_agent_id = $1
      ORDER BY last_synced_at DESC NULLS LAST, id ASC
      LIMIT 2
    `,
    [seller.nvmAgentId],
  )

  const exactMatch = exactNvmMatches.rows[0]
  if (exactNvmMatches.rows.length === 1 && exactMatch) {
    return {
      marketplaceId: exactMatch.marketplace_id,
      protectedMarketplaceIds: [],
      protectedServiceKeys: [],
    }
  }

  if (exactNvmMatches.rows.length > 1) {
    return {
      marketplaceId: null,
      protectedMarketplaceIds: exactNvmMatches.rows.map((row) => row.marketplace_id),
      protectedServiceKeys: await loadProtectedServiceKeys(
        client,
        exactNvmMatches.rows.map((row) => row.id),
      ),
    }
  }

  const candidateResult = await client.query<AgentIdentityCandidate>(
    `
      SELECT
        a.id,
        a.marketplace_id,
        COUNT(*) FILTER (WHERE services.nvm_plan_id = ANY($3::text[]))::int AS plan_overlap,
        CASE WHEN a.endpoint_url IS NOT DISTINCT FROM $4 THEN 1 ELSE 0 END::int AS endpoint_match,
        CASE WHEN a.name IS NOT DISTINCT FROM $5 THEN 1 ELSE 0 END::int AS name_match,
        CASE WHEN a.team_name IS NOT DISTINCT FROM $6 THEN 1 ELSE 0 END::int AS team_name_match,
        a.last_synced_at
      FROM agents AS a
      LEFT JOIN agent_services AS services
        ON services.agent_id = a.id
       AND services.is_active = TRUE
      WHERE a.is_active = TRUE
        AND a.team_id = $1
        AND a.wallet_address = $2
        AND a.nvm_agent_id IS NULL
      GROUP BY a.id, a.marketplace_id, a.endpoint_url, a.name, a.team_name, a.last_synced_at
      ORDER BY
        plan_overlap DESC,
        endpoint_match DESC,
        name_match DESC,
        team_name_match DESC,
        a.last_synced_at DESC NULLS LAST,
        a.id ASC
    `,
    [seller.teamId, seller.walletAddress, seller.planIds, seller.endpointUrl, seller.name, seller.teamName],
  )

  const match = pickIdentityCandidate(candidateResult.rows)
  if (match) {
    return {
      marketplaceId: match.marketplace_id,
      protectedMarketplaceIds: [],
      protectedServiceKeys: [],
    }
  }

  if (candidateResult.rows.length > 1) {
    return {
      marketplaceId: null,
      protectedMarketplaceIds: candidateResult.rows.map((row) => row.marketplace_id),
      protectedServiceKeys: await loadProtectedServiceKeys(
        client,
        candidateResult.rows.map((row) => row.id),
      ),
    }
  }

  return {
    marketplaceId: seller.nvmAgentId,
    protectedMarketplaceIds: [],
    protectedServiceKeys: [],
  }
}

async function upsertAgent(client: PoolClient, marketplaceId: string, seller: NormalizedSeller): Promise<AgentRow> {
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
        $9::text[], TRUE, $10, $11, $12, $13,
        $14, $15, $16, NULL, NOW(), TRUE
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
        marketplace_ready = TRUE,
        endpoint_url = EXCLUDED.endpoint_url,
        services_sold = EXCLUDED.services_sold,
        services_provided_per_req = EXCLUDED.services_provided_per_req,
        price_per_request_display = EXCLUDED.price_per_request_display,
        price_metering_unit = EXCLUDED.price_metering_unit,
        price_display = EXCLUDED.price_display,
        api_created_at = EXCLUDED.api_created_at,
        api_updated_at = EXCLUDED.api_updated_at,
        last_synced_at = NOW(),
        is_active = TRUE,
        is_verified = CASE
          WHEN agents.is_verified = TRUE AND agents.endpoint_url IS DISTINCT FROM EXCLUDED.endpoint_url THEN FALSE
          ELSE agents.is_verified
        END
      WHERE
        agents.team_id IS DISTINCT FROM EXCLUDED.team_id
        OR agents.nvm_agent_id IS DISTINCT FROM EXCLUDED.nvm_agent_id
        OR agents.wallet_address IS DISTINCT FROM EXCLUDED.wallet_address
        OR agents.team_name IS DISTINCT FROM EXCLUDED.team_name
        OR agents.name IS DISTINCT FROM EXCLUDED.name
        OR agents.description IS DISTINCT FROM EXCLUDED.description
        OR agents.category IS DISTINCT FROM EXCLUDED.category
        OR agents.keywords IS DISTINCT FROM EXCLUDED.keywords
        OR agents.marketplace_ready IS DISTINCT FROM TRUE
        OR agents.endpoint_url IS DISTINCT FROM EXCLUDED.endpoint_url
        OR agents.services_sold IS DISTINCT FROM EXCLUDED.services_sold
        OR agents.services_provided_per_req IS DISTINCT FROM EXCLUDED.services_provided_per_req
        OR agents.price_per_request_display IS DISTINCT FROM EXCLUDED.price_per_request_display
        OR agents.price_metering_unit IS DISTINCT FROM EXCLUDED.price_metering_unit
        OR agents.price_display IS DISTINCT FROM EXCLUDED.price_display
        OR agents.api_created_at IS DISTINCT FROM EXCLUDED.api_created_at
        OR agents.api_updated_at IS DISTINCT FROM EXCLUDED.api_updated_at
        OR agents.is_active IS DISTINCT FROM TRUE
      RETURNING id, marketplace_id
    `,
    [
      marketplaceId,
      seller.teamId,
      seller.nvmAgentId,
      seller.walletAddress,
      seller.teamName,
      seller.name,
      seller.description,
      seller.category,
      seller.keywords,
      seller.endpointUrl,
      seller.servicesSold,
      seller.servicesProvidedPerRequest,
      seller.pricePerRequestDisplay,
      seller.priceMeteringUnit,
      seller.priceDisplay,
      seller.apiCreatedAt,
    ],
  )

  const row = result.rows[0] ?? (
    await client.query<AgentRow>(
      `SELECT id, marketplace_id FROM agents WHERE marketplace_id = $1 LIMIT 1`,
      [marketplaceId],
    )
  ).rows[0]
  if (!row) {
    throw new Error(`Failed to upsert agent for marketplace_id=${marketplaceId}.`)
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
  endpointUrl: string,
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

    const sellersByNvmAgentId = new Map<string, NormalizedSeller>()
    for (const seller of input.sellers) {
      sellersByNvmAgentId.set(seller.nvmAgentId, seller)
    }
    const sellers = [...sellersByNvmAgentId.values()]

    const planIdSet = new Set<string>()
    for (const seller of sellers) {
      for (const planId of seller.planIds) {
        planIdSet.add(planId)
      }
    }
    const planIds = [...planIdSet]

    const agentIdByNvmAgentId = new Map<string, string>()
    const activeMarketplaceIdSet = new Set<string>()
    const activeServiceKeySet = new Set<string>()
    let agentsUpserted = 0

    for (const seller of sellers) {
      const resolution = await resolvePersistedMarketplaceId(client, seller)

      for (const marketplaceId of resolution.protectedMarketplaceIds) {
        activeMarketplaceIdSet.add(marketplaceId)
      }
      for (const serviceKey of resolution.protectedServiceKeys) {
        activeServiceKeySet.add(`${serviceKey.agentId}:${serviceKey.planId}`)
      }

      if (!resolution.marketplaceId) {
        continue
      }

      const row = await upsertAgent(client, resolution.marketplaceId, seller)
      agentsUpserted += 1
      agentIdByNvmAgentId.set(seller.nvmAgentId, row.id)
      activeMarketplaceIdSet.add(row.marketplace_id)
    }

    for (const planId of planIds) {
      await upsertPlan(client, planId, input.planEnrichments.get(planId), input.chainNetwork)
    }

    let agentServicesUpserted = 0
    for (const seller of sellers) {
      const agentId = agentIdByNvmAgentId.get(seller.nvmAgentId)
      if (!agentId) {
        continue
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
        activeServiceKeySet.add(`${agentId}:${planId}`)
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

    const activeServiceAgentIds: string[] = []
    const activeServicePlanIds: string[] = []
    for (const serviceKey of activeServiceKeySet) {
      const separator = serviceKey.indexOf(':')
      activeServiceAgentIds.push(serviceKey.slice(0, separator))
      activeServicePlanIds.push(serviceKey.slice(separator + 1))
    }

    const agentsDeactivated = await deactivateAgentsNotInSnapshot(client, [...activeMarketplaceIdSet])
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
