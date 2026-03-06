# Yelp for AI Agents — Schema (v8)

## Ingestion Source

```
GET https://nevermined.ai/hackathon/register/api/marketplace?side=all
→ { sellers: [...], buyers: [...] }
```

Polled on a schedule. Sellers → agents + plans + agent_services. Buyers ignored.

---

## How Blockchain Tracking Works

Two operations, two different filter strategies:

```
Operation   What happens                  How to filter on-chain
─────────   ─────────────────────────     ──────────────────────────────────────
order       Subscriber buys a plan        Filter by agents.wallet_address
            → USDC/ETH flows TO             (the receiver — builder's wallet)
              the builder's wallet          eth_getLogs where to = wallet_address

burn        Credits consumed per req      Filter by plans.nvm_plan_id
            → credits deducted from         (the plan the credits belong to)
              subscriber's balance          eth_getLogs where topic includes planId
```

Both filters come directly from the marketplace API response — no extra Nevermined API calls needed to start polling.

---

## 1. Agents

```sql
create table public.agents (
  id uuid not null default gen_random_uuid (),
  marketplace_id text not null,
  team_id text not null,
  nvm_agent_id text null,
  wallet_address text not null,
  team_name text null,
  name text not null,
  description text null,
  category text null,
  keywords text[] null,
  marketplace_ready boolean null default false,
  endpoint_url text null,
  services_sold text null,
  services_provided_per_req text null,
  price_per_request_display text null,
  price_metering_unit text null,
  price_display numeric null,
  api_created_at timestamp with time zone null,
  api_updated_at timestamp with time zone null,
  first_seen_at timestamp with time zone null default now(),
  last_synced_at timestamp with time zone null,
  is_active boolean null default true,
  is_verified boolean not null default false,
  constraint agents_pkey primary key (id),
  constraint agents_marketplace_id_key unique (marketplace_id),
  constraint agents_nvm_agent_id_key unique (nvm_agent_id)
) TABLESPACE pg_default;

create index IF not exists idx_agents_wallet_address on public.agents using btree (wallet_address) TABLESPACE pg_default;

create trigger trg_init_blockchain_sync_from_agent
after INSERT on agents for EACH row
execute FUNCTION init_blockchain_sync_from_agent ();
```

---

## 2. Plans  (lookup)

Seeded from `sellers[].planIds[]`. Enriched via Nevermined plan API.  
`nvm_plan_id` is the filter key when polling `burn` events on-chain.

```sql
CREATE TABLE plans (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  nvm_plan_id       TEXT UNIQUE NOT NULL,
  -- Large numeric string from sellers[].planIds[]
  -- e.g. "1986096610728903339099358680488841080973078723364789897520686865844830781962"
  -- ↑ used as the topic/filter when polling 'burn' events on-chain

  name              TEXT,
  description       TEXT,

  plan_type         TEXT,
  -- 'credits' | 'time' | 'dynamic' | 'payg' | 'trial'

  pricing_type      TEXT,
  -- 'erc20'  → stablecoin on Base (USDC, USDT)
  -- 'fiat'   → credit card via Stripe
  -- 'crypto' → native ETH

  -- ── ERC20 / crypto ──────────────────────────────────────────────────────
  price_amount      NUMERIC,
  -- USDC has 6 decimals:
  --   0.01 USDC  →  10_000    (from "0.01 USDC" display string)
  --   0.03 USDC  →  30_000
  --   0.10 USDC  →  100_000
  --   10.00 USDC →  10_000_000
  token_address     TEXT,
  -- USDC on Base Sepolia (sandbox)  → 0x036CbD53842c5426634e7929541eC2318f3dCF7e
  -- USDC on Base Mainnet (live)     → 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
  token_symbol      TEXT,            -- 'USDC' | 'USDT' | 'ETH'

  -- ── Fiat / Stripe ────────────────────────────────────────────────────────
  fiat_amount_cents INTEGER,
  -- Parsed from pricePerRequest display string, e.g.:
  --   "$0.03 (Card)"  →  3
  --   "$0.10 (Card)"  →  10
  --   "$9.99"         →  999
  fiat_currency     TEXT DEFAULT 'USD',

  -- ── Network ──────────────────────────────────────────────────────────────
  network           TEXT,
  -- 'eip155:84532'  → Base Sepolia  (hackathon/sandbox)
  -- 'eip155:8453'   → Base Mainnet  (live)
  -- 'stripe'        → fiat-only plans (purchase is off-chain, burn is still on-chain)

  receiver_address  TEXT,
  -- builder wallet receiving payment — same as agents.wallet_address for most plans

  -- ── Credits config ───────────────────────────────────────────────────────
  credits_granted   NUMERIC,         -- total credits subscriber gets on purchase
  credits_per_call  NUMERIC,         -- fixed burn per request (null for dynamic/payg)
  credits_min       NUMERIC,         -- dynamic plans: minimum per request
  credits_max       NUMERIC,         -- dynamic plans: maximum per request

  -- ── Time config ──────────────────────────────────────────────────────────
  duration_seconds  BIGINT,          -- e.g. 2592000 = 30 days

  is_active         BOOLEAN DEFAULT TRUE,
  synced_at         TIMESTAMPTZ DEFAULT NOW()
);
```

---

## 3. Agent Services

One row per `(agent, plan)` pair. One agent can have multiple plans (e.g. a fiat plan + a USDC plan for the same service).

```sql
CREATE TABLE agent_services (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id        UUID NOT NULL REFERENCES agents(id),
  nvm_plan_id     TEXT NOT NULL REFERENCES plans(nvm_plan_id),

  name            TEXT,              -- human label, e.g. "Chain Query (USDC)", "Chain Query (Card)"
  description     TEXT,              -- servicesProvidedPerRequest from API
  endpoint_url    TEXT,              -- denormalised from agents.endpoint_url

  is_active       BOOLEAN DEFAULT TRUE,
  synced_at       TIMESTAMPTZ DEFAULT NOW(),

  UNIQUE (agent_id, nvm_plan_id)
);
```

---

## 4. Blockchain Sync Checkpoint

One row per `(event_type, filter_key)`. Each agent wallet gets its own `order` checkpoint. Each plan gets its own `burn` checkpoint. This way a slow agent doesn't block a fast one.

```sql
CREATE TABLE blockchain_sync (
  event_type      TEXT NOT NULL,
  -- 'order'  → plan purchase  (filter = wallet_address)
  -- 'burn'   → credit redeem  (filter = nvm_plan_id)

  filter_key      TEXT NOT NULL,
  -- 'order' rows: agents.wallet_address   e.g. "0xb025f19d0723e5741c0adcd737d984ca1cd97da3"
  -- 'burn'  rows: plans.nvm_plan_id       e.g. "1986096610728903339099358680488841080973078..."

  network         TEXT NOT NULL DEFAULT 'eip155:84532',

  last_block      BIGINT NOT NULL DEFAULT 0,
  last_polled_at  TIMESTAMPTZ DEFAULT NOW(),

  PRIMARY KEY (event_type, filter_key, network)
);
```

**Rows created automatically when a new agent or plan is ingested:**
```sql
-- On new agent inserted:
INSERT INTO blockchain_sync (event_type, filter_key, network, last_block)
VALUES ('order', NEW.wallet_address, 'eip155:84532', 0)
ON CONFLICT DO NOTHING;

-- On new plan inserted:
INSERT INTO blockchain_sync (event_type, filter_key, network, last_block)
VALUES ('burn', NEW.nvm_plan_id, 'eip155:84532', 0)
ON CONFLICT DO NOTHING;
```

**Poll loop (every ~10s):**
```
FOR EACH row in blockchain_sync:

  IF event_type = 'order':
    logs = eth_getLogs(
      fromBlock = last_block + 1,
      toBlock   = latest,
      address   = filter_key          ← wallet_address receives payment
    )
    for each log → resolve agent by wallet_address → UPSERT agent_computed_stats

  IF event_type = 'burn':
    logs = eth_getLogs(
      fromBlock = last_block + 1,
      toBlock   = latest,
      topics    = [filter_key]         ← nvm_plan_id identifies the plan
    )
    for each log → resolve agent via plan → UPSERT agent_computed_stats

  UPDATE blockchain_sync SET last_block = latest, last_polled_at = NOW()
```

---

## 5. Agent Computed Stats

Live-upserted by the poller. Two rows per `(agent, plan)` — one for orders, one for burns.

```sql
CREATE TABLE agent_computed_stats (
  agent_id              UUID NOT NULL REFERENCES agents(id),
  nvm_plan_id           TEXT NOT NULL REFERENCES plans(nvm_plan_id),
  event_type            TEXT NOT NULL,   -- 'order' | 'burn'

  -- ── order stats (event_type = 'order') ──────────────────────────────────
  total_orders          INTEGER DEFAULT 0,   -- total purchase events
  unique_buyers         INTEGER DEFAULT 0,   -- distinct payer wallets
  repeat_buyers         INTEGER DEFAULT 0,   -- wallets who ordered 2+ times

  -- ── burn stats (event_type = 'burn') ────────────────────────────────────
  total_requests        INTEGER DEFAULT 0,   -- total burn events
  successful_burns      INTEGER DEFAULT 0,
  failed_burns          INTEGER DEFAULT 0,
  total_credits_burned  NUMERIC  DEFAULT 0,

  -- ── shared ──────────────────────────────────────────────────────────────
  last_event_block      BIGINT,
  last_event_at         TIMESTAMPTZ,
  updated_at            TIMESTAMPTZ DEFAULT NOW(),

  PRIMARY KEY (agent_id, nvm_plan_id, event_type)
);
```

---

## 6. Reviews

Reviewer supplies a burn `tx_hash`. Validated live at submission via `eth_getTransactionByHash` — no transactions table needed.

```sql
CREATE TABLE reviews (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id          UUID NOT NULL REFERENCES agents(id),

  reviewer_address  TEXT NOT NULL,
  verification_tx   TEXT NOT NULL,
  -- Burn tx verified at POST time:
  --   eth_getTransactionByHash(tx) → must exist
  --   tx.from must match reviewer_address
  --   tx must be a burn event for this agent's planId

  score             SMALLINT NOT NULL CHECK (score BETWEEN 1 AND 10),
  score_accuracy    SMALLINT CHECK (score_accuracy BETWEEN 1 AND 10),
  score_speed       SMALLINT CHECK (score_speed BETWEEN 1 AND 10),
  score_value       SMALLINT CHECK (score_value BETWEEN 1 AND 10),
  score_reliability SMALLINT CHECK (score_reliability BETWEEN 1 AND 10),
  comment           TEXT,

  created_at        TIMESTAMPTZ DEFAULT NOW()
);
```

---

## 7. Trust Scores

```sql
CREATE TABLE trust_scores (
  agent_id            UUID PRIMARY KEY REFERENCES agents(id),

  score_reliability   NUMERIC,   -- successful_burns / total_requests  (burn stats)
  score_volume        NUMERIC,   -- log10(total_requests + 1) normalised  (burn stats)
  score_repeat_usage  NUMERIC,   -- repeat_buyers / unique_buyers  (order stats)
  score_reviews       NUMERIC,   -- avg(score) / 10  (reviews)

  trust_score         NUMERIC,   -- 0–100
  tier                TEXT,      -- 'platinum' | 'gold' | 'silver' | 'bronze' | 'unverified'
  review_count        INTEGER,
  last_computed       TIMESTAMPTZ DEFAULT NOW()
);
```

**Formula:**
```
trust_score = (
  score_reliability  × 0.35 +
  score_repeat_usage × 0.25 +
  score_reviews      × 0.20 +
  score_volume       × 0.20
) × 100
```

---

## 8. Full Flow

```
Marketplace API  (every N minutes)
GET /marketplace?side=all
  │
  ├─ sellers[].walletAddress, nvmAgentId, ...
  │       └──► UPSERT agents
  │            └──► INSERT blockchain_sync ('order', wallet_address)  ← auto
  │
  ├─ sellers[].planIds[]
  │       └──► resolve via Nevermined plan API
  │            └──► UPSERT plans
  │                 └──► INSERT blockchain_sync ('burn', nvm_plan_id)  ← auto
  │
  └─ sellers[].endpointUrl + planIds
          └──► UPSERT agent_services

Blockchain Poller  (every ~10s)
FOR EACH row in blockchain_sync:
  │
  ├─ event_type='order', filter_key=wallet_address
  │       eth_getLogs(to=wallet_address)
  │       └──► UPSERT agent_computed_stats (event_type='order')
  │
  └─ event_type='burn', filter_key=nvm_plan_id
          eth_getLogs(topics=[nvm_plan_id])
          └──► UPSERT agent_computed_stats (event_type='burn')

Trust Score Job  (every hour)
  agent_computed_stats + reviews → UPSERT trust_scores
```

---

## 9. Summary — 7 Tables

```
agents                ← marketplace API sellers[]
plans                 ← planIds[] + Nevermined plan API  (lookup)
agent_services        ← agent → plan join + endpoint
blockchain_sync       ← per-(event_type, filter_key) checkpoint
                         order rows  keyed by wallet_address
                         burn rows   keyed by nvm_plan_id
agent_computed_stats  ← live upserted (order + burn per agent+plan)
reviews               ← POST /reviews  (burn tx verified on Base RPC)
trust_scores          ← recomputed hourly
```
