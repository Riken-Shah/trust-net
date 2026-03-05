# Nevermined AI Agent Examples

Working examples of AI agents with [Nevermined](https://nevermined.app) payment integration. Each agent demonstrates a different protocol (x402, A2A, MCP) and can be run locally with a few commands.

## Quick Start

### Prerequisites

- Python 3.10+
- [Poetry](https://python-poetry.org/) for dependency management
- [Nevermined App](https://nevermined.app) account (API key + payment plan)
- OpenAI API key (or other LLM provider)

### Environment Setup

Each agent has its own `.env.example`. Copy and fill it in:

```bash
cd agents/<agent-name>
cp .env.example .env
# Edit .env with your credentials
```

Key variables:

```bash
NVM_API_KEY=sandbox:your-api-key       # From https://nevermined.app > API Keys
NVM_ENVIRONMENT=sandbox                # sandbox, staging_sandbox, or live
NVM_PLAN_ID=your-plan-id              # Create in Nevermined App > My Pricing Plans
OPENAI_API_KEY=sk-your-key            # For LLM-powered agents
```

### Shared DB Service (`src/`)

Supabase/PostgreSQL pooling is now provided by a root TypeScript service.

```bash
cp .env.example .env
npm install
npm run dev                 # starts DB service (health endpoints below)
npm run build && npm start  # production build + run
```

Health endpoints:
- `GET /health/live`
- `GET /health/ready`

Integration tests against a real Supabase/PostgreSQL instance:

```bash
npm run test:integration
```

### Marketplace Ingestion Worker

The repo includes a dedicated marketplace ingestion worker that polls Nevermined marketplace sellers, enriches plan metadata, and upserts into `agents`, `plans`, `agent_services`, plus `blockchain_sync` checkpoints.

```bash
cp .env.example .env
npm install
npm run ingest:once     # single ingestion cycle
npm run ingest:worker   # interval worker loop
```

Key env vars:
- `MARKETPLACE_API_URL` (default: `https://nevermined.ai/hackathon/register/api/marketplace?side=all`)
- `INGEST_INTERVAL_SECONDS` (default: `300`)
- `INGEST_HTTP_TIMEOUT_MS` (default: `15000`)
- `INGEST_RETRY_COUNT` (default: `2`)
- `INGEST_PLAN_ENRICH_CONCURRENCY` (default: `5`)
- `NVM_API_KEY` and `NVM_ENVIRONMENT` (required for plan enrichment)

## Agents

| Agent | Description | Protocols | Link |
|-------|-------------|-----------|------|
| **Buyer Agent** | Discovers sellers, purchases data, tracks spending | x402, A2A | [README](./agents/buyer-simple-agent/) |
| **Seller Agent** | Sells data/services with tiered pricing | x402, A2A | [README](./agents/seller-simple-agent/) |
| **MCP Server** | Payment-protected tools via MCP protocol | MCP, x402 | [README](./agents/mcp-server-agent/) |
| **Strands Agent** | Strands SDK agent with payment-protected tools | x402 | [README](./agents/strands-simple-agent/) |

### Buyer Agent (`agents/buyer-simple-agent/`)

Discovers sellers in an A2A marketplace, purchases data autonomously, and tracks spending with budget limits. Includes a React web frontend for interactive use.

```bash
cd agents/buyer-simple-agent
poetry install
poetry run python -m src.agent          # Interactive CLI (A2A mode)
poetry run python -m src.web            # Web server + React frontend
```

### Seller Agent (`agents/seller-simple-agent/`)

Sells data and services with tiered pricing (1, 5, 10 credits). Supports both HTTP (x402 middleware) and A2A modes with auto-registration to buyer marketplaces.

```bash
cd agents/seller-simple-agent
poetry install
poetry run python -m src.agent          # HTTP server (x402)
poetry run python -m src.agent_a2a      # A2A server
```

### MCP Server Agent (`agents/mcp-server-agent/`)

MCP server with payment-protected tools (search, summarize, research). Includes a setup script that programmatically registers the agent and creates a payment plan.

```bash
cd agents/mcp-server-agent
poetry install
poetry run python -m src.setup          # Register agent + create plan
poetry run python -m src.server         # Start MCP server (port 3000)
```

### Strands Agent (`agents/strands-simple-agent/`)

Strands SDK agent with x402 payment-protected tools and full payment discovery flow. Demonstrates the `@requires_payment` decorator pattern.

```bash
cd agents/strands-simple-agent
poetry install
poetry run python agent.py              # Run agent
poetry run python demo.py               # Run demo
```

## Protocols

### x402 (HTTP Payment Protocol)

Payment negotiation via HTTP headers. The client sends a `payment-signature` header with an access token. If missing, the server returns `402 Payment Required` with a `payment-required` header describing what's needed.

### A2A (Agent-to-Agent)

Standard agent discovery via `/.well-known/agent.json` and JSON-RPC messaging with payment extensions. Agents can auto-register with buyer marketplaces.

### MCP (Model Context Protocol)

Tool/plugin monetization with logical URLs (e.g., `mcp://server/tools/search`). Each tool can have independent credit pricing.

## Documentation

- [Getting Started](./docs/getting-started.md) — Environment setup and first agent
- [AWS Integration](./docs/aws-integration.md) — Strands SDK + AgentCore deployment
- [Deploy to AgentCore](./docs/deploy-to-agentcore.md) — Step-by-step AgentCore deployment with Nevermined payments

## Resources

- [Nevermined Documentation](https://nevermined.ai/docs)
- [Nevermined App](https://nevermined.app)
- [Payments Python SDK](https://github.com/nevermined-io/payments-py)
- [Payments TypeScript SDK](https://github.com/nevermined-io/payments)
- [x402 Protocol Spec](https://github.com/coinbase/x402)
- [AWS AgentCore Samples](https://github.com/awslabs/amazon-bedrock-agentcore-samples)
- [Discord Community](https://discord.com/invite/GZju2qScKq)

## License

MIT
