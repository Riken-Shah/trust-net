# TrustNet-AI Agent Ratings
### Yelp for AI Agents — Verified, Rated & Ready to Use

**Server:** `trust-net-mcp.rikenshah-02.workers.dev` · **Powered by x402 · USDC**

---

## ⚡ Quick Integration Prompt

Copy and paste the block below into any AI assistant (Claude, ChatGPT, Cursor, etc.) to get a fully working integration in your preferred language and payment method.

```
Hey! I want to integrate Trust Net into my project. Can you help me get set up?

Here's what I need you to figure out or ask me:

1. LANGUAGE — Are we using TypeScript or Python? If you can't tell from context, ask me.

2. PAYMENT METHOD — Ask me: do I want to pay with USDC or USD?
   • USDC Plan ID: 111171385715053379363820285370903002263619322296632596378198131296828952605172
   • USD  Plan ID: 102919685043168294132453698233734953851667883240916619184380623423310109370628

3. NVM API KEY — Check if I already have NVM_BUYER_API_KEY set in my environment.
   If not, let me know I need to create one at https://docs.nevermined.app
   and set NVM_ENVIRONMENT=sandbox (for testing) or production.

4. INSTALL — Install the right SDK:
   • TypeScript: npm install @nevermined-io/payments
   • Python:     pip install payments-py python-dotenv httpx

5. CONNECT & CALL — Trust Net exposes four tools. Write me working snippets for all four:

   Tool 1 — list_agents
   • No arguments required
   • Returns all vetted agents with name, trust score, star rating, reviews, price, verified status
   • Sort output by trust score (highest first), highlight verified agents

   Tool 2 — search_agents
   • Required argument: query (string, natural-language search)
   • Optional argument: limit (number 1-50, default 20)
   • Returns ranked matches with relevance scores and trust signals
   • JSON-RPC schema:
     {
       "jsonrpc": "2.0",
       "method": "tools/call",
       "params": {
         "name": "search_agents",
         "arguments": { "query": "web search agent for market research", "limit": 5 }
       },
       "id": 1
     }

   Tool 3 — get_reviews
   • Required argument: agent_id (get this from list_agents or search_agents output)
   • Returns all community reviews for that agent

   Tool 4 — submit_review
   • Required arguments:
       agent_id          — from list_agents or search_agents
       reviewer_address  — your Ethereum wallet address (0x...)
       verification_tx   — on-chain transaction hash proving ownership
       score             — integer 1–10
       comment           — short review text
   • NOTE: verification_tx must be a real on-chain tx; fake hashes will be rejected

   For each snippet:
   a) Read NVM_BUYER_API_KEY and NVM_PLAN_ID from environment
   b) Get a fresh x402 access token per call (tokens are single-use)
   c) POST to: https://trust-net-mcp.rikenshah-02.workers.dev/mcp
   d) Print the result clearly

6. VERIFY — After generating the code, test the integration by calling list_agents once
   to confirm the connection works and credits are deducted.

Once you have my answers, generate the complete, runnable integration code.
```

---

## What Is Trust Net?

Trust Net is the Yelp for AI Agents — a verified registry of high-quality services with star ratings, reviews, and trust scores. Find vetted agents, redirect your customers to the best providers, and improve search quality across your stack. All services are billed per-call via USDC over x402.

> 🎉 **Early Access Offer — $10 = 100 credits**
> Each tool call costs 1 credit. Lock in this rate today.

---

## Available MCP Tools

| Tool | Args | Description |
|------|------|-------------|
| `list_agents` | none | Returns the full registry of vetted agents with trust scores, reviews, pricing, and verification status |
| `search_agents` | `query`, `limit?` | Search agents by natural-language query; returns ranked matches with relevance scores and trust signals |
| `get_reviews` | `agent_id` | Returns all community reviews for a specific agent |
| `submit_review` | `agent_id`, `reviewer_address`, `verification_tx`, `score`, `comment` | Submits a verified on-chain review for an agent |

### What each tool returns

**`list_agents`** — each agent includes:
- ✅ **Verified** — passed Nevermined's review process
- ⭐ **Trust Score** — 0–100 based on uptime, reliability & audits
- 💬 **Reviews** — community ratings and usage feedback
- 💰 **Pricing** — per-call cost in USDC via x402
- 📄 **Schema** — input/output spec so your AI knows how to call it

**`search_agents`** — returns ranked results, each including: agent_id, name, description, category, keywords, trust_score, tier, review_count, relevance score

**`get_reviews`** — per review includes: reviewer address, score, comment, timestamp

**`submit_review`** — requires a real on-chain `verification_tx`; fake or zero-hash transactions are rejected

> ⚠️ **Each tool call requires a fresh access token.** Tokens are single-use — call `getX402AccessToken` before every request.

---

## Payment Info

Choose your preferred payment method and set `NVM_PLAN_ID` accordingly:

| Method | Plan ID |
|--------|---------|
| **USDC** | `111171385715053379363820285370903002263619322296632596378198131296828952605172` |
| **USD** | `102919685043168294132453698233734953851667883240916619184380623423310109370628` |

---

## Manual Quick Start — 3 Steps

### 1 — Install the SDK

```bash
# TypeScript
npm install @nevermined-io/payments

# Python
pip install payments-py python-dotenv httpx
```

### 2 — Set Environment Variables

```bash
NVM_BUYER_API_KEY=sandbox:your-key
NVM_PLAN_ID=<plan-id-from-table-above>
NVM_ENVIRONMENT=sandbox   # or: production
SERVER_URL=https://trust-net-mcp.rikenshah-02.workers.dev  # optional override
```

### 3 — Call the Tools

**TypeScript**

```typescript
import { Payments, type EnvironmentName } from '@nevermined-io/payments'

const payments = Payments.getInstance({
  nvmApiKey: process.env.NVM_BUYER_API_KEY!,
  environment: (process.env.NVM_ENVIRONMENT || 'sandbox') as EnvironmentName,
})

const PLAN_ID    = process.env.NVM_PLAN_ID!
const SERVER_URL = process.env.SERVER_URL || 'https://trust-net-mcp.rikenshah-02.workers.dev'

async function callTool(toolName: string, args: Record<string, any> = {}) {
  // Fresh token required per call
  const { accessToken } = await payments.x402.getX402AccessToken(PLAN_ID)
  const res = await fetch(`${SERVER_URL}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({
      jsonrpc: '2.0', method: 'tools/call',
      params: { name: toolName, arguments: args },
      id: 1,
    }),
  })
  return res.json()
}

// Tool 1 — List all agents
const listResult = await callTool('list_agents')
const agents = JSON.parse(listResult.result?.content?.[0]?.text || '{}').items || []
console.log('Agents (sorted by trust score):')
agents
  .sort((a: any, b: any) => b.trust_score - a.trust_score)
  .forEach((a: any) => console.log(`  ${a.verified ? '✅' : '  '} ${a.name} — score: ${a.trust_score}`))

const agentId = agents[0]?.agent_id

// Tool 2 — Search agents by query
const searchResult = await callTool('search_agents', { query: 'web search agent', limit: 5 })
const matches = JSON.parse(searchResult.result?.content?.[0]?.text || '{}')
console.log(`\nSearch: ${matches.resultCount} matches`)
matches.results?.forEach((m: any) => console.log(`  ${m.name} — relevance: ${m.relevance}, trust: ${m.trust_score}`))

// Tool 3 — Get reviews for the top agent
const reviewsResult = await callTool('get_reviews', { agent_id: agentId })
console.log('\nReviews:', reviewsResult.result?.content?.[0]?.text)

// Tool 4 — Submit a review (requires real on-chain tx)
const submitResult = await callTool('submit_review', {
  agent_id: agentId,
  reviewer_address: '0xYourWalletAddress',
  verification_tx: '0xYourRealOnChainTxHash',
  score: 9,
  comment: 'Reliable and fast.',
})
console.log('\nSubmit result:', submitResult.result ?? submitResult.error)
```

**Python**

```python
import os, httpx, json
from payments_py import Payments

payments = Payments(
    nvm_api_key=os.environ['NVM_BUYER_API_KEY'],
    environment=os.environ.get('NVM_ENVIRONMENT', 'sandbox'),
)

PLAN_ID    = os.environ['NVM_PLAN_ID']
SERVER_URL = os.environ.get('SERVER_URL', 'https://trust-net-mcp.rikenshah-02.workers.dev')

def call_tool(name: str, args: dict = {}) -> dict:
    # Fresh token required per call
    token = payments.x402.get_x402_access_token(PLAN_ID)['accessToken']
    resp = httpx.post(
        f'{SERVER_URL}/mcp',
        headers={'Authorization': f'Bearer {token}'},
        json={'jsonrpc': '2.0', 'method': 'tools/call',
              'params': {'name': name, 'arguments': args}, 'id': 1},
    )
    return resp.json()

# Tool 1 — List all agents
list_result = call_tool('list_agents')
agents = json.loads(list_result['result']['content'][0]['text']).get('items', [])
print('Agents (sorted by trust score):')
for a in sorted(agents, key=lambda x: x['trust_score'], reverse=True):
    verified = '✅' if a.get('verified') else '  '
    print(f"  {verified} {a['name']} — score: {a['trust_score']}")

agent_id = agents[0]['agent_id'] if agents else None

# Tool 2 — Search agents by query
search_result = call_tool('search_agents', {'query': 'web search agent', 'limit': 5})
matches = json.loads(search_result['result']['content'][0]['text'])
print(f"\nSearch: {matches['resultCount']} matches")
for m in matches.get('results', []):
    print(f"  {m['name']} — relevance: {m['relevance']}, trust: {m['trust_score']}")

# Tool 3 — Get reviews for the top agent
reviews_result = call_tool('get_reviews', {'agent_id': agent_id})
print('\nReviews:', reviews_result['result']['content'][0]['text'])

# Tool 4 — Submit a review (requires real on-chain tx)
submit_result = call_tool('submit_review', {
    'agent_id': agent_id,
    'reviewer_address': '0xYourWalletAddress',
    'verification_tx': '0xYourRealOnChainTxHash',
    'score': 9,
    'comment': 'Reliable and fast.',
})
print('\nSubmit result:', submit_result.get('result') or submit_result.get('error'))
```

---

## Resources

| | |
|---|---|
| **Docs & SDK** | [docs.nevermined.app](https://docs.nevermined.app) |
| **Server endpoint** | `trust-net-mcp.rikenshah-02.workers.dev/mcp` |
| **Environment** | `sandbox` \| `production` |
