# Buyer Agent — Autonomous Seller Verification

## Overview

The buyer agent is an autonomous verification system that scans seller agents in the Nevermined marketplace, purchases their services using real payment protocols, and scores the results with an LLM judge. Sellers that pass verification are marked `is_verified = TRUE` in the database.

It supports all three Nevermined payment protocols (**x402**, **A2A**, **MCP**) and can pay with either crypto credits or fiat via Stripe card delegation.

---

## Quick Start

```bash
# Verify all unverified sellers (pass score = 1, any success = verified)
npm run buyer-agent:verify

# Verify all sellers, including rows where agents.is_verified = TRUE
npm run buyer-agent:verify -- --include-verified

# Verify a single seller by name, agent ID, marketplace ID, or NVM agent ID
npm run buyer-agent:verify:one "Mog Markets"
npm run buyer-agent:verify:one "72b6b183-b801-458b-bd9d-f44711aade90"

# Run without auto-verify (default pass score = 6/10)
npm run buyer-agent:run

# Test a single seller without auto-verify
npm run buyer-agent:run:one "AiRI — AI Resilience Index"
```

### Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `NVM_BUYER_API_KEY` or `NVM_API_KEY` | Yes | — | Nevermined API key (buyer account) |
| `NVM_ENVIRONMENT` | No | `sandbox` | `sandbox`, `staging_sandbox`, or `live` |
| `OPENAI_API_KEY` | Yes | — | OpenAI key for the LLM judge |
| `BUYER_AGENT_MODEL` | No | `gpt-4o-mini` | LLM model for scoring |
| `BUYER_AGENT_PASS_SCORE` | No | `6` | Minimum score (1–10) to mark a seller as verified |
| `BUYER_AGENT_TIMEOUT_MS` | No | `15000` | HTTP request timeout in milliseconds |
| `BUYER_AGENT_MAX_SELLERS` | No | unlimited | Cap the number of sellers scanned per run |
| `BUYER_AGENT_TARGET_SELLER` | No | — | Restrict to a single seller (ID, name, or marketplace ID) |
| `BUYER_AGENT_INCLUDE_VERIFIED_TARGET` | No | `false` | Re-test an already-verified target seller |

### CLI Flags

| Flag | Description |
|------|-------------|
| `--include-verified` | Include sellers already marked `is_verified = TRUE` in a full run |

---

## Architecture

```
runOnce.ts          Entry point — loads config, connects to DB, runs verification
  │
  ▼
service.ts          Main orchestrator
  │
  ├── config.ts          Parse environment variables into BuyerAgentConfig
  ├── repository.ts      All Postgres queries (fetch sellers, insert judgments, mark verified)
  ├── schema.ts          Auto-creates buyer_agent_runs and buyer_agent_judgments tables
  ├── endpoint.ts        URL normalization and localhost filtering
  ├── plans.ts           Select cheapest plan (crypto or fiat with card delegation)
  ├── protocol.ts        Auto-detect seller protocol (A2A → MCP → x402)
  ├── offers.ts          Match DB services to discovered endpoint capabilities
  ├── judge.ts           LLM-based scoring via OpenAI (accuracy, speed, value, reliability)
  │
  └── clients/
      ├── x402.ts        Purchase via x402 HTTP payment headers
      ├── a2a.ts         Purchase via Agent-to-Agent JSON-RPC
      └── mcp.ts         Purchase via Model Context Protocol + tool invocation
```

---

## Verification Pipeline

For each selected seller in the database:

### 1. Endpoint Validation

Normalizes the seller's `endpoint_url` and rejects invalid or unreachable targets:
- Empty or non-URL strings
- `localhost`, `127.0.0.1`, `example.com`, `.local` hosts
- Non-HTTP(S) schemes

### 2. Plan Selection

Picks the cheapest active plan from the seller's linked plans:
- **With card delegation**: all plans are eligible (fiat plans charged via the delegated Stripe card)
- **Without card delegation**: only crypto plans (fiat plans require interactive Stripe checkout)
- Prices are normalized to USD-equivalent for comparison (USDC, USDT at 1:1, ETH at 18 decimals)

### 3. Protocol Detection

Probes the seller endpoint to determine which Nevermined protocol it speaks. Detection runs in priority order:

#### A2A (Agent-to-Agent)
- Fetches `/.well-known/agent.json` (root and path-based)
- If found, checks for x402 indicators in the agent card (payment scheme, description keywords, skill endpoints)
- Agent cards declaring x402 are reclassified as x402 instead of A2A

#### MCP (Model Context Protocol)
- Sends a JSON-RPC `initialize` request to `/mcp`
- If successful, enumerates tools, prompts, and resources via `tools/list`, `prompts/list`, `resources/list`
- Also detects OAuth-protected MCP servers via `/.well-known/oauth-protected-resource`

#### x402 (HTTP Payment Protocol)
- Sends POST probes to the endpoint with multiple body shapes (`{query}`, `{message}`, `{}`)
- Detects 402 Payment Required responses, or 401/403 with payment-related body text
- Falls back to checking `/pricing` endpoint for x402 pricing contracts

### 4. Service Discovery

Builds a list of services to test:
- **A2A**: skills from the agent card + services listed in the DB
- **MCP**: tools, prompts, and resources from JSON-RPC discovery
- **x402**: pricing tiers from `/pricing` + DB services

### 5. Purchase

Each service is purchased using the detected protocol's client:

#### x402 Client (`clients/x402.ts`)
1. Check plan balance / order plan (skipped with card delegation)
2. Get x402 access token from Nevermined SDK (with optional `nvm:card-delegation` scheme)
3. Build request payload from agent card's `inputSchema` (falls back to `{query: serviceName}`)
4. POST to the paid URL with `payment-signature` header
5. **Retry logic**:
   - 422 → parse validation error, rebuild payload with correct field names, retry POST
   - 405 → retry as GET with query params
   - GET 422 → parse validation error, add required query params, retry GET

#### A2A Client (`clients/a2a.ts`)
1. Order plan (skipped with card delegation)
2. Create A2A client via `payments.a2a.getClient()` with card delegation config
3. Send task via the A2A JSON-RPC protocol
4. Extract agent ID from agent card's Nevermined payment extension or plan lookup

#### MCP Client (`clients/mcp.ts`)
1. Get x402 access token for MCP authorization
2. Send JSON-RPC `tools/call` (or prompts/resources equivalent) with the token
3. Parse MCP response for tool output

### 6. LLM Judgment

Each purchase result is scored by an LLM judge (GPT-4o-mini by default):

| Dimension | What it measures |
|-----------|-----------------|
| `score_accuracy` | Did the response match the service's advertised purpose? |
| `score_speed` | How fast was the response relative to timeout? |
| `score_value` | Was the response worth the credits/cost? |
| `score_reliability` | Did the service respond without errors? |
| `overall_score` | Composite score (1–10) |
| `verdict` | `pass` or `fail` |
| `rationale` | Free-text explanation |

A service **passes** if `purchaseSuccess = true` AND (`verdict = 'pass'` OR `overallScore >= passScore`).

### 7. Verification

If **any** service for a seller passes, the seller is marked `is_verified = TRUE` in the `agents` table.

---

## Card Delegation (Fiat Payments)

Card delegation enables autonomous fiat payments without interactive Stripe checkout. The buyer agent auto-detects enrolled payment methods at startup:

```
Card delegation enabled: visa ****4242
```

### How It Works

1. The buyer enrolls a card via Stripe in the Nevermined app
2. At runtime, the agent calls `payments.delegation.listPaymentMethods()`
3. If a card is found, it creates a `CardDelegation` config:
   - `paymentMethodId` — Stripe payment method ID
   - `spendingLimitCents` — per-request spending cap (default: $10.00)
   - `durationSecs` — delegation window (default: 3600s)
4. When purchasing, the x402 token is requested with scheme `nvm:card-delegation` instead of crypto
5. The Nevermined facilitator charges the delegated card and issues the access token

Without card delegation, sellers with fiat-only plans are skipped.

---

## Database Schema

The buyer agent auto-creates two tables on startup:

### `buyer_agent_runs`

Tracks each verification run.

| Column | Type | Description |
|--------|------|-------------|
| `id` | UUID | Primary key |
| `started_at` | TIMESTAMPTZ | Run start time |
| `finished_at` | TIMESTAMPTZ | Run end time |
| `status` | TEXT | `running`, `completed`, or `failed` |
| `model` | TEXT | LLM model used for judging |
| `pass_score_threshold` | INTEGER | Minimum score to pass (1–10) |
| `sellers_scanned` | INTEGER | Total sellers processed |
| `services_attempted` | INTEGER | Total service purchase attempts |
| `services_succeeded` | INTEGER | Successful purchases |
| `services_failed` | INTEGER | Failed purchases |
| `sellers_verified` | INTEGER | Sellers newly marked as verified |
| `protocol_counts` | JSONB | `{a2a: N, mcp: N, x402_http: N, unknown: N}` |
| `error` | TEXT | Error message if run failed |

### `buyer_agent_judgments`

One row per service purchase attempt.

| Column | Type | Description |
|--------|------|-------------|
| `id` | UUID | Primary key |
| `run_id` | UUID | FK to `buyer_agent_runs` |
| `agent_id` | UUID | FK to `agents` |
| `seller_name` | TEXT | Seller display name |
| `service_name` | TEXT | Service tested |
| `protocol` | TEXT | `a2a`, `mcp`, `x402_http`, or `unknown` |
| `plan_id` | TEXT | Nevermined plan ID used |
| `purchase_success` | BOOLEAN | Did the HTTP purchase succeed? |
| `purchase_error` | TEXT | Error code if failed |
| `http_status` | INTEGER | HTTP response status |
| `latency_ms` | INTEGER | Round-trip time |
| `tx_hash` | TEXT | On-chain transaction hash |
| `overall_score` | SMALLINT | LLM judge score (1–10) |
| `verdict` | TEXT | `pass` or `fail` |
| `rationale` | TEXT | LLM explanation |
| `passed` | BOOLEAN | Final pass/fail determination |

---

## Protocol Detection Heuristics

The detector handles several edge cases found in the wild:

| Scenario | Detection |
|----------|-----------|
| Standard A2A agent card | `/.well-known/agent.json` with name/description → A2A |
| Agent card with `payment.scheme: "x402"` | Agent card present but reclassified → x402 |
| Agent card mentioning "x402" in description | Keywords in description → x402 |
| Agent card with skill HTTP endpoints | Skills listing `endpoint: "/data"` or full URLs → x402 |
| MCP server with OAuth | 401 + `/.well-known/oauth-protected-resource` → MCP |
| Standard x402 endpoint | POST returns 402 → x402 |
| Endpoint rejects wrong body before payment check | Multiple probe bodies tried (`{query}`, `{message}`, `{}`) |
| GET-only x402 endpoint | POST returns 405 → retry as GET |
| Endpoint with `/pricing` contract | Pricing tiers discovered → x402 |

---

## Example Output

```
Buyer-agent: 45 unverified seller(s) to scan
[1/45] Mog Markets — https://mogmarkets.xyz/
  protocol: x402_http
  service: data (via x402_http)
    purchase: OK, score: 8, verdict: pass, passed: true
  service: market intelligence (via x402_http)
    purchase: OK, score: 7, verdict: pass, passed: true
[2/45] AiRI — AI Resilience Index — https://airi-app.com/api/
  protocol: x402_http
  service: resilience-score (via x402_http)
    purchase: OK, score: 9, verdict: pass, passed: true
...
{
  "message": "Buyer-agent verification run completed",
  "summary": {
    "sellersScanned": 45,
    "servicesAttempted": 87,
    "servicesSucceeded": 23,
    "servicesFailed": 64,
    "sellersVerified": 9,
    "protocolCounts": {
      "a2a": 3,
      "mcp": 2,
      "x402_http": 31,
      "unknown": 9
    }
  }
}
```

---

## File Reference

| File | Lines | Purpose |
|------|-------|---------|
| `runOnce.ts` | ~38 | CLI entry point |
| `config.ts` | ~103 | Environment variable parsing |
| `service.ts` | ~413 | Main orchestration loop |
| `types.ts` | ~132 | All TypeScript interfaces |
| `repository.ts` | ~323 | PostgreSQL queries |
| `schema.ts` | ~77 | DDL for `buyer_agent_runs` and `buyer_agent_judgments` |
| `endpoint.ts` | ~71 | URL normalization and localhost filtering |
| `plans.ts` | ~79 | Cheapest plan selection with fiat support |
| `protocol.ts` | ~733 | Protocol auto-detection (A2A, MCP, x402) |
| `offers.ts` | — | Service name matching and normalization |
| `judge.ts` | ~213 | LLM-based scoring via OpenAI |
| `clients/x402.ts` | ~415 | x402 purchase with retry logic |
| `clients/a2a.ts` | — | A2A purchase via Nevermined SDK |
| `clients/mcp.ts` | — | MCP purchase via JSON-RPC |
