# Seller Agent — Cloudflare Workers Deployment

## Live URL

**`https://trust-net-mcp.rikenshah-02.workers.dev`**

## Endpoints

| Endpoint | Auth | Description |
|----------|------|-------------|
| `/health` | None | Health check |
| `/api/agents` | None | Free JSON API — returns all agents with trust scores |
| `/api/paid/agents` | x402 `payment-signature` header | Payment-protected (1 credit per call): verify → query → settle |
| `/mcp` | None (SSE session) | MCP protocol via Durable Objects (Streamable HTTP + SSE) |
| `/mcp` | `Authorization: Bearer <x402-token>` (no session) | Stateless JSON-RPC with x402 payment (for test-client) |
| `/sse` | None | Alias for `/mcp` |

## Architecture

- **Runtime**: Cloudflare Workers + Durable Objects (`McpAgent`)
- **Database**: Supabase Postgres via [Hyperdrive](https://developers.cloudflare.com/hyperdrive/) (connection pooling)
- **Payments**: Manual x402 verify/settle against Nevermined sandbox API
- **MCP**: `@modelcontextprotocol/sdk` + `agents` (Cloudflare Agents SDK)

## Secrets (set via `wrangler secret put`)

| Secret | Description |
|--------|-------------|
| `DATABASE_URL` | Supabase Postgres connection string |
| `NVM_PLAN_ID` | Nevermined plan ID for x402 payment verification |
| `SELLER_AGENT_ID` | Nevermined agent ID |

## Bindings

| Binding | Type | Description |
|---------|------|-------------|
| `MCP_OBJECT` | Durable Object | MCP session management (`MyMCP` class) |
| `HYPERDRIVE` | Hyperdrive | Postgres connection pool (`6c06a2bc37b44bb1b1053b78cba6bf88`) |

## Deploy

```bash
cd seller-agent
npm install
npm run deploy
```

To set or update secrets:

```bash
echo "your-value" | npx wrangler secret put DATABASE_URL
echo "your-value" | npx wrangler secret put NVM_PLAN_ID
echo "your-value" | npx wrangler secret put SELLER_AGENT_ID
```

## Test

```bash
# Health check
curl https://trust-net-mcp.rikenshah-02.workers.dev/health

# Free agent list
curl https://trust-net-mcp.rikenshah-02.workers.dev/api/agents

# Paid endpoint (no token → 402)
curl -i https://trust-net-mcp.rikenshah-02.workers.dev/api/paid/agents

# Full test with x402 payment (from repo root)
NVM_BUYER_API_KEY=sandbox:xxx \
NVM_PLAN_ID=94240777376471260267957735995112520664129993265013811504650562878230741255648 \
SERVER_URL=https://trust-net-mcp.rikenshah-02.workers.dev \
npx tsx src/test-client.ts
```

## x402 Payment Flow

1. **No token** → `402` with `payment-required` header (base64 JSON with planId, scheme)
2. **With token** → Verify via `POST https://api.sandbox.nevermined.app/api/v1/x402/verify` → Execute query → Settle via `POST .../x402/settle` → `200` with `payment-response` header

**Note**: The Nevermined plan (`Starter_USDC`) is configured with "Credits per use: 1", so each settle call redeems exactly 1 credit.

## Cloudflare Account

- **Account**: `Rikenshah.02@gmail.com` (`ef44744f424f5bb00d8640febf528286`)
- **Worker name**: `trust-net-mcp`
- **Hyperdrive config**: `trust-net-db` (`6c06a2bc37b44bb1b1053b78cba6bf88`)
