# Cron Job — Ingestion Pipeline

## Schedule

Runs every 5 minutes via Cloudflare Workers Cron Trigger.

```jsonc
// wrangler.jsonc
"triggers": {
    "crons": ["*/5 * * * *"]
}
```

## Architecture

```
Cron (every 5 min) → Worker scheduled() → runIngestion() → Hyperdrive → Postgres
```

The cron runs directly on the **Worker** (not the Durable Object). The `scheduled` handler in `src/index.ts` calls `runIngestion(env)` wrapped in `ctx.waitUntil()` so the Worker stays alive until ingestion completes.

## Three Phases

### Phase 1 — Marketplace Sync

1. Fetches all sellers from `https://nevermined.ai/hackathon/register/api/marketplace?side=all`
2. Normalizes seller data (validates required fields, deduplicates by `marketplaceId`)
3. Enriches plan details via direct HTTP call to `GET https://api.sandbox.nevermined.app/api/v1/protocol/plans/{planId}`
4. Upserts into `agents`, `plans`, and `agent_services` tables
5. Deactivates stale agents/plans not in the latest snapshot

### Phase 2 — Blockchain Order Scan

1. Reads wallet checkpoints from `blockchain_sync` table
2. For each wallet, queries Etherscan V2 API for USDC token transfers on Base Sepolia (chain `84532`)
3. Inserts new orders into `orders` table
4. Computes per-agent stats: total orders, unique buyers, repeat buyers → `agent_computed_stats`
5. Updates checkpoint block numbers

### Phase 3 — Trust Score Computation

1. For each active agent, pulls order stats, burn stats, and review scores
2. Computes weighted trust score:
   - 35% reliability (successful burns / total requests)
   - 25% repeat usage (repeat buyers / unique buyers)
   - 20% reviews (average review score / 10)
   - 20% volume (log10 of total requests, capped at 1)
3. Assigns tier: platinum (80+), gold (60+), silver (40+), bronze (20+), unverified (<20)
4. Upserts into `trust_scores` table

## Secrets Required

| Secret | Description |
|--------|-------------|
| `NVM_API_KEY` | Nevermined API key (for plan enrichment) |
| `ETHERSCAN_API_KEY` | Etherscan API key (for blockchain order scan) |

Set via:

```bash
echo "your-value" | npx wrangler secret put NVM_API_KEY
echo "your-value" | npx wrangler secret put ETHERSCAN_API_KEY
```

For non-interactive setup and deploy, Wrangler also requires `CLOUDFLARE_API_TOKEN`.

One-step setup from `seller-agent/`:

```bash
export CLOUDFLARE_API_TOKEN=your-cloudflare-api-token
export NVM_API_KEY=your-nevermined-api-key
export ETHERSCAN_API_KEY=your-etherscan-api-key
npm run setup:cron
```

## Monitoring

View cron logs in the Cloudflare dashboard under **Workers & Pages → trust-net-mcp → Logs**, or via:

```bash
npx wrangler tail --format pretty
```

Successful runs log:

```
Ingestion complete: {"phase1_marketplace":{...},"phase2_orders":{...},"phase3_trust":{...},"durationMs":...}
```

Failed runs log:

```
Ingestion failed: <error message>
```

## Key Files

- `src/index.ts` — `scheduled` handler (entry point)
- `src/ingest.ts` — Full ingestion pipeline (all 3 phases)
- `wrangler.jsonc` — Cron trigger config
