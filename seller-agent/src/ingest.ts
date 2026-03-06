/**
 * Ingestion pipeline for Cloudflare Workers cron trigger.
 *
 * Ports the 3-phase ingestion (marketplace sync, blockchain scan, trust scores)
 * from the original pg-based Node.js code to postgres.js + Hyperdrive.
 *
 * Key difference: postgres.js uses sql.unsafe(query, params) instead of pool.query(query, params),
 * and sql.begin(async tx => { ... }) instead of BEGIN/COMMIT/ROLLBACK.
 */

import postgres, { type Sql, type TransactionSql } from "postgres";

// ─── Types ────────────────────────────────────────────────────────

interface NormalizedSeller {
	marketplaceId: string;
	teamId: string;
	nvmAgentId: string | null;
	walletAddress: string;
	teamName: string | null;
	name: string;
	description: string | null;
	category: string | null;
	keywords: string[];
	marketplaceReady: boolean;
	endpointUrl: string | null;
	servicesSold: string | null;
	servicesProvidedPerRequest: string | null;
	pricePerRequestDisplay: string | null;
	priceMeteringUnit: string | null;
	priceDisplay: number | null;
	apiCreatedAt: Date | null;
	apiUpdatedAt: Date | null;
	planIds: string[];
}

interface PlanEnrichment {
	nvmPlanId: string;
	name: string | null;
	description: string | null;
	planType: string | null;
	pricingType: string | null;
	priceAmount: string | null;
	tokenAddress: string | null;
	tokenSymbol: string | null;
	fiatAmountCents: number | null;
	fiatCurrency: string | null;
	network: string | null;
	receiverAddress: string | null;
	creditsGranted: string | null;
	creditsPerCall: string | null;
	creditsMin: string | null;
	creditsMax: string | null;
	durationSeconds: number | null;
}

interface TokenTransfer {
	hash: string;
	blockNumber: string;
	timeStamp: string;
	from: string;
	to: string;
	value: string;
	contractAddress: string;
	tokenSymbol: string;
	methodId: string;
	functionName: string;
}

interface IngestionResult {
	phase1_marketplace: Record<string, unknown>;
	phase2_orders: Record<string, unknown>;
	phase3_trust: Record<string, unknown>;
	durationMs: number;
}

interface AgentIdentityCandidate {
	id: string;
	marketplace_id: string;
	plan_overlap: number;
	endpoint_match: number;
	name_match: number;
	team_name_match: number;
}

// ─── Config ───────────────────────────────────────────────────────

const MARKETPLACE_API_URL = "https://nevermined.ai/hackathon/register/api/marketplace?side=all";
const ETHERSCAN_API_URL = "https://api.etherscan.io/v2/api";
const CHAIN_ID = "84532";
const CHAIN_NETWORK = "eip155:84532";
const USDC_CONTRACT = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const USDC_DECIMALS = 6;

// ─── Helpers ──────────────────────────────────────────────────────

function usdcToHuman(rawValue: string): number {
	return Number(BigInt(rawValue)) / 10 ** USDC_DECIMALS;
}

function asTrimmedString(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const t = value.trim();
	return t.length > 0 ? t : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	return value as Record<string, unknown>;
}

function asStringList(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	const s = new Set<string>();
	for (const item of value) {
		const t = asTrimmedString(item);
		if (t) s.add(t);
	}
	return [...s];
}

function asBoolean(value: unknown, def = false): boolean {
	return typeof value === "boolean" ? value : def;
}

function asNumber(value: unknown): number | null {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string") {
		const p = Number.parseFloat(value.trim());
		return Number.isFinite(p) ? p : null;
	}
	return null;
}

function asTimestamp(value: unknown): Date | null {
	const t = asTrimmedString(value);
	if (!t) return null;
	const d = new Date(t);
	return Number.isNaN(d.getTime()) ? null : d;
}

function planIdsFromPlanPricing(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	const planIds = new Set<string>();
	for (const item of value) {
		const record = asRecord(item);
		const planId = record ? asTrimmedString(record.planDid) : null;
		if (planId) planIds.add(planId);
	}
	return [...planIds];
}

function pickIdentityCandidate(candidates: AgentIdentityCandidate[]): AgentIdentityCandidate | null {
	if (candidates.length === 0) return null;
	if (candidates.length === 1) return candidates[0];

	const overlappingPlans = candidates.filter((candidate) => candidate.plan_overlap > 0);
	if (overlappingPlans.length === 1) return overlappingPlans[0];
	if (overlappingPlans.length > 1 && overlappingPlans[0].plan_overlap > overlappingPlans[1].plan_overlap) {
		return overlappingPlans[0];
	}

	const metadataMatches = candidates.filter(
		(candidate) => candidate.endpoint_match + candidate.name_match + candidate.team_name_match > 0,
	);
	if (metadataMatches.length === 1) return metadataMatches[0];

	const [best, next] = candidates;
	if (!next) return best;
	const bestMetadataScore = best.endpoint_match + best.name_match + best.team_name_match;
	const nextMetadataScore = next.endpoint_match + next.name_match + next.team_name_match;
	if (bestMetadataScore > 0 && bestMetadataScore > nextMetadataScore) {
		return best;
	}

	return null;
}

// ─── Plan mapper (from SDK response) ─────────────────────────────

function getByPath(source: unknown, path: string[]): unknown {
	let current: unknown = source;
	for (const key of path) {
		if (!current || typeof current !== "object" || Array.isArray(current)) return undefined;
		current = (current as Record<string, unknown>)[key];
	}
	return current;
}

function firstDefined(source: unknown, paths: string[][]): unknown {
	for (const path of paths) {
		const v = getByPath(source, path);
		if (v !== undefined && v !== null) return v;
	}
	return null;
}

function asNumericString(value: unknown): string | null {
	if (typeof value === "bigint") return value.toString();
	if (typeof value === "number" && Number.isFinite(value)) return String(value);
	if (typeof value === "string") {
		const t = value.trim();
		return t && Number.isFinite(Number(t)) ? t : null;
	}
	return null;
}

function asInteger(value: unknown): number | null {
	if (typeof value === "number" && Number.isInteger(value)) return value;
	if (typeof value === "bigint") {
		const c = Number(value);
		return Number.isSafeInteger(c) ? c : null;
	}
	if (typeof value === "string") {
		const p = Number.parseInt(value.trim(), 10);
		return Number.isInteger(p) ? p : null;
	}
	return null;
}

function mapPlanFromSdk(planId: string, raw: unknown): PlanEnrichment {
	return {
		nvmPlanId: planId,
		name: asTrimmedString(firstDefined(raw, [["name"], ["planMetadata", "name"], ["metadata", "name"]]) as string),
		description: asTrimmedString(firstDefined(raw, [["description"], ["planMetadata", "description"]]) as string),
		planType: asTrimmedString(firstDefined(raw, [["planType"], ["accessType"]]) as string),
		pricingType: asTrimmedString(firstDefined(raw, [["pricingType"], ["price", "type"]]) as string),
		priceAmount: asNumericString(firstDefined(raw, [["priceAmount"], ["price"], ["price", "amount"]])),
		tokenAddress: asTrimmedString(firstDefined(raw, [["tokenAddress"], ["price", "tokenAddress"]]) as string),
		tokenSymbol: asTrimmedString(firstDefined(raw, [["tokenSymbol"], ["price", "tokenSymbol"]]) as string),
		fiatAmountCents: asInteger(firstDefined(raw, [["fiatAmountCents"], ["price", "fiatAmountCents"]])),
		fiatCurrency: asTrimmedString(firstDefined(raw, [["fiatCurrency"], ["price", "fiatCurrency"]]) as string),
		network: asTrimmedString(firstDefined(raw, [["network"], ["price", "network"]]) as string),
		receiverAddress: asTrimmedString(firstDefined(raw, [["receiverAddress"], ["receiver"]]) as string),
		creditsGranted: asNumericString(firstDefined(raw, [["creditsGranted"], ["credits"]])),
		creditsPerCall: asNumericString(firstDefined(raw, [["creditsPerCall"], ["creditsConfiguration", "minCreditsToCharge"]])),
		creditsMin: asNumericString(firstDefined(raw, [["creditsMin"], ["creditsConfiguration", "minCreditsRequired"]])),
		creditsMax: asNumericString(firstDefined(raw, [["creditsMax"], ["creditsConfiguration", "maxCreditsToCharge"]])),
		durationSeconds: asInteger(firstDefined(raw, [["durationSeconds"], ["duration"]])),
	};
}

// ─── Phase 1: Marketplace Sync ────────────────────────────────────

function normalizeSeller(raw: unknown): NormalizedSeller | null {
	const r = asRecord(raw);
	if (!r) return null;
	const pricing = asRecord(r.pricing);
	const marketplaceId = asTrimmedString(r.id);
	const teamId = asTrimmedString(r.teamId);
	const walletAddress = asTrimmedString(r.walletAddress) ?? teamId;
	const name = asTrimmedString(r.name);
	const planIds = asStringList(r.planIds);
	const resolvedPlanIds = planIds.length > 0 ? planIds : planIdsFromPlanPricing(r.planPricing);
	if (!marketplaceId || !teamId || !walletAddress || !name || resolvedPlanIds.length === 0) return null;
	return {
		marketplaceId, teamId,
		nvmAgentId: asTrimmedString(r.nvmAgentId),
		walletAddress: walletAddress.toLowerCase(),
		teamName: asTrimmedString(r.teamName),
		name, description: asTrimmedString(r.description),
		category: asTrimmedString(r.category),
		keywords: asStringList(r.keywords),
		marketplaceReady: asBoolean(r.marketplaceReady),
		endpointUrl: asTrimmedString(r.endpointUrl),
		servicesSold: asTrimmedString(r.servicesSold),
		servicesProvidedPerRequest: asTrimmedString(r.servicesProvidedPerRequest) ?? asTrimmedString(pricing?.servicesPerRequest),
		pricePerRequestDisplay: asTrimmedString(r.pricePerRequest) ?? asTrimmedString(pricing?.perRequest),
		priceMeteringUnit: asTrimmedString(r.priceMeteringUnit) ?? asTrimmedString(pricing?.meteringUnit),
		priceDisplay: asNumber(r.price),
		apiCreatedAt: asTimestamp(r.createdAt),
		apiUpdatedAt: asTimestamp(r.updatedAt),
		planIds: resolvedPlanIds,
	};
}

async function reconcileMarketplaceId(tx: TransactionSql, seller: NormalizedSeller): Promise<boolean> {
	const existingRows = await tx.unsafe<{ id: string }[]>(
		`SELECT id FROM agents WHERE marketplace_id=$1 LIMIT 1`,
		[seller.marketplaceId],
	);
	if (existingRows[0]) return false;

	if (seller.nvmAgentId) {
		const nvmMatches = await tx.unsafe<{ id: string }[]>(
			`SELECT id FROM agents WHERE nvm_agent_id=$1 AND marketplace_id<>$2 ORDER BY last_synced_at DESC NULLS LAST, id ASC LIMIT 2`,
			[seller.nvmAgentId, seller.marketplaceId],
		);
		if (nvmMatches.length === 1) {
			const updated = await tx.unsafe<{ id: string }[]>(
				`UPDATE agents
				 SET marketplace_id=$1
				 WHERE id=$2
				   AND marketplace_id<>$1
				   AND NOT EXISTS (
				     SELECT 1
				     FROM agents current
				     WHERE current.marketplace_id=$1
				       AND current.id<>$2
				   )
				 RETURNING id`,
				[seller.marketplaceId, nvmMatches[0].id],
			);
			return Boolean(updated[0]);
		}
	}

	const candidates = await tx.unsafe<AgentIdentityCandidate[]>(
		`SELECT
		   a.id,
		   a.marketplace_id,
		   COUNT(*) FILTER (WHERE services.nvm_plan_id = ANY($3::text[]))::int AS plan_overlap,
		   CASE WHEN a.endpoint_url IS NOT DISTINCT FROM $4 THEN 1 ELSE 0 END::int AS endpoint_match,
		   CASE WHEN a.name IS NOT DISTINCT FROM $5 THEN 1 ELSE 0 END::int AS name_match,
		   CASE WHEN a.team_name IS NOT DISTINCT FROM $6 THEN 1 ELSE 0 END::int AS team_name_match
		 FROM agents a
		 LEFT JOIN agent_services services
		   ON services.agent_id = a.id
		  AND services.is_active = TRUE
		 WHERE (a.team_id=$1 OR a.wallet_address=$2)
		   AND a.marketplace_id<>$7
		 GROUP BY a.id, a.marketplace_id, a.endpoint_url, a.name, a.team_name, a.last_synced_at
		 ORDER BY
		   plan_overlap DESC,
		   endpoint_match DESC,
		   name_match DESC,
		   team_name_match DESC,
		   a.last_synced_at DESC NULLS LAST,
		   a.id ASC`,
		[seller.teamId, seller.walletAddress, seller.planIds, seller.endpointUrl, seller.name, seller.teamName, seller.marketplaceId],
	);

	const match = pickIdentityCandidate(candidates);
	if (!match) return false;

	const updated = await tx.unsafe<{ id: string }[]>(
		`UPDATE agents
		 SET marketplace_id=$1
		 WHERE id=$2
		   AND marketplace_id<>$1
		   AND NOT EXISTS (
		     SELECT 1
		     FROM agents current
		     WHERE current.marketplace_id=$1
		       AND current.id<>$2
		   )
		 RETURNING id`,
		[seller.marketplaceId, match.id],
	);
	return Boolean(updated[0]);
}

async function enrichPlans(planIds: string[], nvmApiKey: string, nvmEnvironment: string): Promise<Map<string, PlanEnrichment>> {
	const baseUrl = nvmEnvironment === "live"
		? "https://api.live.nevermined.app/api/v1"
		: "https://api.sandbox.nevermined.app/api/v1";
	const result = new Map<string, PlanEnrichment>();
	for (const planId of planIds) {
		try {
			const resp = await fetch(`${baseUrl}/protocol/plans/${planId}`, {
				headers: { Authorization: `bearer ${nvmApiKey}`, Accept: "application/json" },
				signal: AbortSignal.timeout(10_000),
			});
			if (!resp.ok) continue;
			const plan = await resp.json();
			result.set(planId, mapPlanFromSdk(planId, plan));
		} catch { /* skip failed plans */ }
	}
	return result;
}

async function phase1MarketplaceSync(sql: Sql, nvmApiKey: string, nvmEnvironment: string) {
	// Fetch marketplace snapshot
	const resp = await fetch(MARKETPLACE_API_URL, { headers: { accept: "application/json" } });
	if (!resp.ok) throw new Error(`Marketplace API failed: ${resp.status}`);
	const data = await resp.json() as { sellers: unknown[]; buyers: unknown[] };

	// Normalize sellers
	const sellers: NormalizedSeller[] = [];
	for (const raw of data.sellers) {
		const s = normalizeSeller(raw);
		if (s) sellers.push(s);
	}

	// Enrich plans
	const allPlanIds = [...new Set(sellers.flatMap(s => s.planIds))];
	const planEnrichments = await enrichPlans(allPlanIds, nvmApiKey, nvmEnvironment);

	// Persist in a transaction
	const stats = await sql.begin(async (tx: TransactionSql) => {
		let agentsUpserted = 0;
		let marketplaceIdsReconciled = 0;
		const agentIdByMid = new Map<string, string>();

		// Dedup sellers by marketplaceId
		const deduped = new Map<string, NormalizedSeller>();
		for (const s of sellers) deduped.set(s.marketplaceId, s);

		for (const seller of deduped.values()) {
			if (await reconcileMarketplaceId(tx, seller)) {
				marketplaceIdsReconciled++;
			}
			const rows = await tx.unsafe<{ id: string; marketplace_id: string }[]>(
				`INSERT INTO agents (marketplace_id, team_id, nvm_agent_id, wallet_address, team_name, name, description, category, keywords, marketplace_ready, endpoint_url, services_sold, services_provided_per_req, price_per_request_display, price_metering_unit, price_display, api_created_at, api_updated_at, last_synced_at, is_active)
				 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::text[],$10,$11,$12,$13,$14,$15,$16,$17,$18,NOW(),TRUE)
				 ON CONFLICT (marketplace_id) DO UPDATE SET
				   team_id=EXCLUDED.team_id, nvm_agent_id=EXCLUDED.nvm_agent_id, wallet_address=EXCLUDED.wallet_address,
				   team_name=EXCLUDED.team_name, name=EXCLUDED.name, description=EXCLUDED.description, category=EXCLUDED.category,
				   keywords=EXCLUDED.keywords, marketplace_ready=EXCLUDED.marketplace_ready, endpoint_url=EXCLUDED.endpoint_url,
				   services_sold=EXCLUDED.services_sold, services_provided_per_req=EXCLUDED.services_provided_per_req,
				   price_per_request_display=EXCLUDED.price_per_request_display, price_metering_unit=EXCLUDED.price_metering_unit,
				   price_display=EXCLUDED.price_display, api_created_at=EXCLUDED.api_created_at, api_updated_at=EXCLUDED.api_updated_at,
				   last_synced_at=NOW(), is_active=TRUE,
				   is_verified=CASE
				     WHEN agents.is_verified=TRUE AND agents.endpoint_url IS DISTINCT FROM EXCLUDED.endpoint_url THEN FALSE
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
				   OR agents.marketplace_ready IS DISTINCT FROM EXCLUDED.marketplace_ready
				   OR agents.endpoint_url IS DISTINCT FROM EXCLUDED.endpoint_url
				   OR agents.services_sold IS DISTINCT FROM EXCLUDED.services_sold
				   OR agents.services_provided_per_req IS DISTINCT FROM EXCLUDED.services_provided_per_req
				   OR agents.price_per_request_display IS DISTINCT FROM EXCLUDED.price_per_request_display
				   OR agents.price_metering_unit IS DISTINCT FROM EXCLUDED.price_metering_unit
				   OR agents.price_display IS DISTINCT FROM EXCLUDED.price_display
				   OR agents.api_created_at IS DISTINCT FROM EXCLUDED.api_created_at
				   OR agents.api_updated_at IS DISTINCT FROM EXCLUDED.api_updated_at
				   OR agents.is_active IS DISTINCT FROM TRUE
				 RETURNING id, marketplace_id`,
				[seller.marketplaceId, seller.teamId, seller.nvmAgentId, seller.walletAddress, seller.teamName, seller.name,
				 seller.description, seller.category, seller.keywords, seller.marketplaceReady, seller.endpointUrl, seller.servicesSold,
				 seller.servicesProvidedPerRequest, seller.pricePerRequestDisplay, seller.priceMeteringUnit, seller.priceDisplay,
				 seller.apiCreatedAt, seller.apiUpdatedAt],
			);
			const row = rows[0] ?? (
				await tx.unsafe<{ id: string; marketplace_id: string }[]>(
					`SELECT id, marketplace_id FROM agents WHERE marketplace_id=$1 LIMIT 1`,
					[seller.marketplaceId],
				)
			)[0];
			if (row) {
				agentIdByMid.set(row.marketplace_id, row.id);
				agentsUpserted++;
			}
		}

		// Upsert plans
		for (const planId of allPlanIds) {
			const p = planEnrichments.get(planId);
			const fiatCurrency = p?.fiatCurrency ?? (p?.fiatAmountCents !== null ? "USD" : null);
			await tx.unsafe(
				`INSERT INTO plans (nvm_plan_id, name, description, plan_type, pricing_type, price_amount, token_address, token_symbol,
				   fiat_amount_cents, fiat_currency, network, receiver_address, credits_granted, credits_per_call, credits_min, credits_max,
				   duration_seconds, is_active, synced_at)
				 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,TRUE,NOW())
				 ON CONFLICT (nvm_plan_id) DO UPDATE SET
				   name=COALESCE(EXCLUDED.name,plans.name), description=COALESCE(EXCLUDED.description,plans.description),
				   plan_type=COALESCE(EXCLUDED.plan_type,plans.plan_type), pricing_type=COALESCE(EXCLUDED.pricing_type,plans.pricing_type),
				   price_amount=COALESCE(EXCLUDED.price_amount,plans.price_amount), token_address=COALESCE(EXCLUDED.token_address,plans.token_address),
				   token_symbol=COALESCE(EXCLUDED.token_symbol,plans.token_symbol), fiat_amount_cents=COALESCE(EXCLUDED.fiat_amount_cents,plans.fiat_amount_cents),
				   fiat_currency=COALESCE(EXCLUDED.fiat_currency,plans.fiat_currency), network=COALESCE(EXCLUDED.network,plans.network),
				   receiver_address=COALESCE(EXCLUDED.receiver_address,plans.receiver_address), credits_granted=COALESCE(EXCLUDED.credits_granted,plans.credits_granted),
				   credits_per_call=COALESCE(EXCLUDED.credits_per_call,plans.credits_per_call), credits_min=COALESCE(EXCLUDED.credits_min,plans.credits_min),
				   credits_max=COALESCE(EXCLUDED.credits_max,plans.credits_max), duration_seconds=COALESCE(EXCLUDED.duration_seconds,plans.duration_seconds),
				   is_active=TRUE, synced_at=NOW()`,
				[planId, p?.name ?? null, p?.description ?? null, p?.planType ?? null, p?.pricingType ?? null,
				 p?.priceAmount ?? null, p?.tokenAddress ?? null, p?.tokenSymbol ?? null, p?.fiatAmountCents ?? null,
				 fiatCurrency, p?.network ?? CHAIN_NETWORK, p?.receiverAddress ?? null, p?.creditsGranted ?? null,
				 p?.creditsPerCall ?? null, p?.creditsMin ?? null, p?.creditsMax ?? null, p?.durationSeconds ?? null],
			);
		}

		// Upsert agent_services + checkpoints
		let agentServicesUpserted = 0;
		for (const seller of deduped.values()) {
			const agentId = agentIdByMid.get(seller.marketplaceId);
			if (!agentId) continue;
			for (const planId of seller.planIds) {
				const p = planEnrichments.get(planId);
				await tx.unsafe(
					`INSERT INTO agent_services (agent_id, nvm_plan_id, name, description, endpoint_url, is_active, synced_at)
					 VALUES ($1,$2,$3,$4,$5,TRUE,NOW())
					 ON CONFLICT (agent_id, nvm_plan_id) DO UPDATE SET name=EXCLUDED.name, description=EXCLUDED.description, endpoint_url=EXCLUDED.endpoint_url, is_active=TRUE, synced_at=NOW()`,
					[agentId, planId, p?.name ?? seller.name, seller.servicesProvidedPerRequest, seller.endpointUrl],
				);
				agentServicesUpserted++;
			}
			// Order checkpoint
			await tx.unsafe(
				`INSERT INTO blockchain_sync (event_type, filter_key, network, last_block) VALUES ('order',$1,$2,0) ON CONFLICT DO NOTHING`,
				[seller.walletAddress, CHAIN_NETWORK],
			);
		}

		// Deactivate stale
		const mids = [...deduped.keys()];
		if (mids.length > 0) {
			await tx.unsafe(`UPDATE agents SET is_active=FALSE WHERE is_active=TRUE AND NOT (marketplace_id = ANY($1::text[]))`, [mids]);
			await tx.unsafe(`UPDATE plans SET is_active=FALSE WHERE is_active=TRUE AND NOT (nvm_plan_id = ANY($1::text[]))`, [allPlanIds]);
		}

		return { agentsUpserted, marketplaceIdsReconciled, plansUpserted: allPlanIds.length, agentServicesUpserted };
	});

	return { fetchedSellers: data.sellers.length, normalized: sellers.length, plansEnriched: planEnrichments.size, ...stats };
}

// ─── Phase 2: Blockchain Order Scan ───────────────────────────────

async function fetchTokenTransfers(walletAddress: string, apiKey: string, startBlock: number): Promise<TokenTransfer[]> {
	const params = new URLSearchParams({
		chainid: CHAIN_ID, module: "account", action: "tokentx",
		contractaddress: USDC_CONTRACT, address: walletAddress,
		startblock: String(startBlock), endblock: "99999999",
		page: "1", offset: "1000", sort: "asc", apikey: apiKey,
	});
	const resp = await fetch(`${ETHERSCAN_API_URL}?${params}`, {
		headers: { accept: "application/json" },
		signal: AbortSignal.timeout(15_000),
	});
	if (!resp.ok) throw new Error(`Etherscan HTTP ${resp.status}`);
	const data = await resp.json() as { status: string; message: string; result: TokenTransfer[] | string };
	if (data.status === "1" && Array.isArray(data.result)) return data.result;
	if (data.message === "No transactions found") return [];
	return [];
}

async function phase2OrderScan(sql: Sql, etherscanApiKey: string) {
	const checkpoints = await sql.unsafe<{ filter_key: string; network: string; last_block: string }[]>(
		`SELECT filter_key, network, last_block::text FROM blockchain_sync WHERE event_type='order' ORDER BY filter_key`,
	);

	let walletsScanned = 0, ordersInserted = 0;
	const errors: string[] = [];

	for (const cp of checkpoints) {
		const wallet = cp.filter_key;
		const startBlock = Number(cp.last_block) + 1;

		let transfers: TokenTransfer[];
		try {
			transfers = await fetchTokenTransfers(wallet, etherscanApiKey, startBlock);
		} catch (e) {
			errors.push(`${wallet}: ${e instanceof Error ? e.message : String(e)}`);
			continue;
		}

		const received = transfers.filter(tx => tx.to.toLowerCase() === wallet.toLowerCase());

		if (received.length === 0) {
			walletsScanned++;
			if (transfers.length > 0) {
				const maxBlock = Math.max(...transfers.map(tx => Number(tx.blockNumber)));
				await sql.unsafe(
					`UPDATE blockchain_sync SET last_block=GREATEST(last_block,$1), last_polled_at=NOW() WHERE event_type='order' AND filter_key=$2 AND network=$3`,
					[maxBlock, wallet, cp.network],
				);
			}
			continue;
		}

		await sql.begin(async (tx: TransactionSql) => {
			const agents = await tx.unsafe<{ id: string }[]>(
				`SELECT id FROM agents WHERE wallet_address=$1 LIMIT 1`, [wallet.toLowerCase()],
			);
			if (!agents[0]) return;
			const agentId = agents[0].id;

			for (const t of received) {
				const res = await tx.unsafe(
					`INSERT INTO orders (agent_id, tx_hash, block_number, from_wallet, to_wallet, raw_value, usdc_amount, tx_timestamp,
					   token_address, token_symbol, network, method_id, function_name)
					 VALUES ($1,$2,$3,$4,$5,$6,$7,to_timestamp($8::bigint),$9,$10,$11,$12,$13) ON CONFLICT (tx_hash) DO NOTHING`,
					[agentId, t.hash, Number(t.blockNumber), t.from.toLowerCase(), t.to.toLowerCase(),
					 t.value, usdcToHuman(t.value), t.timeStamp, USDC_CONTRACT.toLowerCase(),
					 t.tokenSymbol || "USDC", cp.network, t.methodId || null, t.functionName || null],
				);
				ordersInserted += res.count;
			}

			// Upsert computed stats
			const planRows = await tx.unsafe<{ nvm_plan_id: string }[]>(
				`SELECT nvm_plan_id FROM agent_services WHERE agent_id=$1 AND is_active=TRUE ORDER BY synced_at LIMIT 1`, [agentId],
			);
			if (planRows[0]) {
				await tx.unsafe(
					`INSERT INTO agent_computed_stats (agent_id, nvm_plan_id, event_type, total_orders, unique_buyers, repeat_buyers, last_event_block, last_event_at, updated_at)
					 SELECT $1::uuid, $2, 'order', COUNT(*)::int, COUNT(DISTINCT o.from_wallet)::int,
					   (SELECT COUNT(*)::int FROM (SELECT from_wallet FROM orders WHERE agent_id=$1::uuid GROUP BY from_wallet HAVING COUNT(*)>1) r),
					   MAX(o.block_number), MAX(o.tx_timestamp), NOW()
					 FROM orders o WHERE o.agent_id=$1::uuid
					 ON CONFLICT (agent_id, nvm_plan_id, event_type) DO UPDATE SET
					   total_orders=EXCLUDED.total_orders, unique_buyers=EXCLUDED.unique_buyers, repeat_buyers=EXCLUDED.repeat_buyers,
					   last_event_block=GREATEST(agent_computed_stats.last_event_block, EXCLUDED.last_event_block),
					   last_event_at=GREATEST(agent_computed_stats.last_event_at, EXCLUDED.last_event_at), updated_at=NOW()`,
					[agentId, planRows[0].nvm_plan_id],
				);
			}

			const maxBlock = Math.max(...received.map(tx => Number(tx.blockNumber)));
			await tx.unsafe(
				`UPDATE blockchain_sync SET last_block=GREATEST(last_block,$1), last_polled_at=NOW() WHERE event_type='order' AND filter_key=$2 AND network=$3`,
				[maxBlock, wallet, cp.network],
			);
		});

		walletsScanned++;
	}

	return { walletsScanned, ordersInserted, errors };
}

// ─── Phase 3: Trust Score Computation ─────────────────────────────

function computeTier(score: number): string {
	if (score >= 80) return "platinum";
	if (score >= 60) return "gold";
	if (score >= 40) return "silver";
	if (score >= 20) return "bronze";
	return "unverified";
}

async function phase3TrustScores(sql: Sql) {
	const agents = await sql.unsafe<{ agent_id: string }[]>(`SELECT id AS agent_id FROM agents WHERE is_active=TRUE`);
	let computed = 0;
	const errors: string[] = [];

	for (const { agent_id } of agents) {
		try {
			const [orders] = await sql.unsafe<{ total_orders: number; unique_buyers: number; repeat_buyers: number }[]>(
				`SELECT COALESCE(SUM(total_orders),0)::int AS total_orders, COALESCE(SUM(unique_buyers),0)::int AS unique_buyers, COALESCE(SUM(repeat_buyers),0)::int AS repeat_buyers
				 FROM agent_computed_stats WHERE agent_id=$1 AND event_type='order'`, [agent_id],
			);
			const [burns] = await sql.unsafe<{ total_requests: number; successful_burns: number }[]>(
				`SELECT COALESCE(SUM(total_requests),0)::int AS total_requests, COALESCE(SUM(successful_burns),0)::int AS successful_burns
				 FROM agent_computed_stats WHERE agent_id=$1 AND event_type='burn'`, [agent_id],
			);
			const [reviews] = await sql.unsafe<{ avg_score: number | null; review_count: number }[]>(
				`SELECT AVG(score)::numeric AS avg_score, COUNT(*)::int AS review_count FROM reviews WHERE agent_id=$1`, [agent_id],
			);

			const hasBurns = (burns?.total_requests ?? 0) > 0;
			const hasOrders = (orders?.unique_buyers ?? 0) > 0;
			const hasReviews = reviews?.avg_score !== null;

			const scoreReliability = hasBurns ? (burns!.successful_burns / burns!.total_requests) : 0;
			const scoreVolume = hasBurns ? Math.min(Math.log10(burns!.total_requests + 1) / 3, 1) : 0;
			const scoreRepeatUsage = hasOrders ? (orders!.repeat_buyers / orders!.unique_buyers) : 0;
			const scoreReviews = hasReviews ? Number(reviews!.avg_score) / 10 : 0;

			const w = { reliability: 0.35, repeatUsage: 0.25, reviews: 0.20, volume: 0.20 };
			let activeWeight = 0;
			if (hasBurns) activeWeight += w.reliability + w.volume;
			if (hasOrders) activeWeight += w.repeatUsage;
			if (hasReviews) activeWeight += w.reviews;

			let trustScore = 0;
			if (activeWeight > 0) {
				const s = 1 / activeWeight;
				trustScore = ((hasBurns ? scoreReliability * w.reliability * s : 0)
					+ (hasOrders ? scoreRepeatUsage * w.repeatUsage * s : 0)
					+ (hasReviews ? scoreReviews * w.reviews * s : 0)
					+ (hasBurns ? scoreVolume * w.volume * s : 0)) * 100;
			}

			await sql.unsafe(
				`INSERT INTO trust_scores (agent_id, score_reliability, score_volume, score_repeat_usage, score_reviews, trust_score, tier, review_count, last_computed)
				 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW())
				 ON CONFLICT (agent_id) DO UPDATE SET score_reliability=EXCLUDED.score_reliability, score_volume=EXCLUDED.score_volume,
				   score_repeat_usage=EXCLUDED.score_repeat_usage, score_reviews=EXCLUDED.score_reviews, trust_score=EXCLUDED.trust_score,
				   tier=EXCLUDED.tier, review_count=EXCLUDED.review_count, last_computed=NOW()`,
				[agent_id, Math.round(scoreReliability * 1e4) / 1e4, Math.round(scoreVolume * 1e4) / 1e4,
				 Math.round(scoreRepeatUsage * 1e4) / 1e4, Math.round(scoreReviews * 1e4) / 1e4,
				 Math.round(trustScore * 100) / 100, computeTier(trustScore), reviews?.review_count ?? 0],
			);
			computed++;
		} catch (e) {
			errors.push(`${agent_id}: ${e instanceof Error ? e.message : String(e)}`);
		}
	}

	return { agentsComputed: computed, errors };
}

// ─── Public entry point (called by scheduled handler) ─────────────

export async function runIngestion(env: {
	HYPERDRIVE: Hyperdrive;
	NVM_API_KEY: string;
	NVM_ENVIRONMENT?: string;
	ETHERSCAN_API_KEY: string;
}): Promise<IngestionResult> {
	const start = Date.now();
	const sql = postgres(env.HYPERDRIVE.connectionString, { max: 3, idle_timeout: 10, prepare: false });

	try {
		const phase1 = await phase1MarketplaceSync(sql, env.NVM_API_KEY, env.NVM_ENVIRONMENT || "sandbox");
		const phase2 = await phase2OrderScan(sql, env.ETHERSCAN_API_KEY);
		const phase3 = await phase3TrustScores(sql);

		return {
			phase1_marketplace: phase1,
			phase2_orders: phase2,
			phase3_trust: phase3,
			durationMs: Date.now() - start,
		};
	} finally {
		await sql.end();
	}
}
