-- orders table — raw blockchain USDC transfer events (received by agent wallets)
-- The other 7 tables (agents, plans, agent_services, blockchain_sync,
-- agent_computed_stats, reviews, trust_scores) are defined in yelp-for-ai-agents-v8.md.

CREATE TABLE IF NOT EXISTS orders (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  agent_id        UUID NOT NULL REFERENCES agents(id),
  nvm_plan_id     TEXT REFERENCES plans(nvm_plan_id),

  tx_hash         TEXT UNIQUE NOT NULL,
  block_number    BIGINT NOT NULL,
  from_wallet     TEXT NOT NULL,
  to_wallet       TEXT NOT NULL,
  raw_value       TEXT NOT NULL,
  usdc_amount     NUMERIC NOT NULL,
  tx_timestamp    TIMESTAMPTZ NOT NULL,

  token_address   TEXT,
  token_symbol    TEXT DEFAULT 'USDC',
  network         TEXT NOT NULL DEFAULT 'eip155:84532',
  method_id       TEXT,
  function_name   TEXT,

  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_orders_to_wallet    ON orders (to_wallet);
CREATE INDEX IF NOT EXISTS idx_orders_from_wallet  ON orders (from_wallet);
CREATE INDEX IF NOT EXISTS idx_orders_block_number ON orders (block_number);
CREATE INDEX IF NOT EXISTS idx_orders_agent_id     ON orders (agent_id);
