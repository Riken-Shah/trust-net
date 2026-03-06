import { type Pool } from 'pg'

export async function ensureBuyerAgentSchema(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS buyer_agent_runs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      finished_at TIMESTAMPTZ,
      status TEXT NOT NULL DEFAULT 'running',
      model TEXT NOT NULL,
      pass_score_threshold INTEGER NOT NULL,
      max_sellers INTEGER,
      sellers_scanned INTEGER NOT NULL DEFAULT 0,
      services_attempted INTEGER NOT NULL DEFAULT 0,
      services_succeeded INTEGER NOT NULL DEFAULT 0,
      services_failed INTEGER NOT NULL DEFAULT 0,
      sellers_verified INTEGER NOT NULL DEFAULT 0,
      protocol_counts JSONB NOT NULL DEFAULT '{}'::jsonb,
      error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT buyer_agent_runs_status_check CHECK (status IN ('running', 'completed', 'failed')),
      CONSTRAINT buyer_agent_runs_pass_score_check CHECK (pass_score_threshold BETWEEN 1 AND 10)
    )
  `)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS buyer_agent_judgments (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      run_id UUID NOT NULL REFERENCES buyer_agent_runs(id) ON DELETE CASCADE,
      agent_id UUID NOT NULL,
      marketplace_id TEXT NOT NULL,
      seller_name TEXT NOT NULL,
      service_name TEXT NOT NULL,
      service_name_normalized TEXT NOT NULL,
      protocol TEXT NOT NULL,
      plan_id TEXT,
      endpoint_url TEXT,
      request_payload JSONB,
      response_payload JSONB,
      response_excerpt TEXT,
      purchase_success BOOLEAN NOT NULL,
      purchase_error TEXT,
      http_status INTEGER,
      latency_ms INTEGER,
      tx_hash TEXT,
      credits_redeemed TEXT,
      remaining_balance TEXT,
      payment_meta JSONB,
      overall_score SMALLINT,
      score_accuracy SMALLINT,
      score_speed SMALLINT,
      score_value SMALLINT,
      score_reliability SMALLINT,
      verdict TEXT,
      rationale TEXT,
      passed BOOLEAN NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT buyer_agent_judgments_protocol_check CHECK (protocol IN ('a2a', 'mcp', 'x402_http', 'unknown')),
      CONSTRAINT buyer_agent_judgments_verdict_check CHECK (verdict IS NULL OR verdict IN ('pass', 'fail')),
      CONSTRAINT buyer_agent_judgments_overall_score_check CHECK (overall_score IS NULL OR overall_score BETWEEN 1 AND 10),
      CONSTRAINT buyer_agent_judgments_accuracy_check CHECK (score_accuracy IS NULL OR score_accuracy BETWEEN 1 AND 10),
      CONSTRAINT buyer_agent_judgments_speed_check CHECK (score_speed IS NULL OR score_speed BETWEEN 1 AND 10),
      CONSTRAINT buyer_agent_judgments_value_check CHECK (score_value IS NULL OR score_value BETWEEN 1 AND 10),
      CONSTRAINT buyer_agent_judgments_reliability_check CHECK (score_reliability IS NULL OR score_reliability BETWEEN 1 AND 10)
    )
  `)

  await pool.query(`
    DO $$
    DECLARE
      constraint_record RECORD;
    BEGIN
      FOR constraint_record IN
        SELECT con.conname
        FROM pg_constraint AS con
        JOIN pg_class AS rel ON rel.oid = con.conrelid
        JOIN pg_namespace AS ns ON ns.oid = rel.relnamespace
        JOIN pg_attribute AS attr
          ON attr.attrelid = rel.oid
         AND attr.attnum = ANY(con.conkey)
        WHERE con.contype = 'f'
          AND ns.nspname = current_schema()
          AND rel.relname = 'buyer_agent_judgments'
          AND attr.attname = 'agent_id'
      LOOP
        EXECUTE format('ALTER TABLE buyer_agent_judgments DROP CONSTRAINT %I', constraint_record.conname);
      END LOOP;
    END $$;
  `)

  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_buyer_agent_judgments_run_id ON buyer_agent_judgments(run_id)`,
  )
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_buyer_agent_judgments_agent_id ON buyer_agent_judgments(agent_id)`,
  )
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_buyer_agent_judgments_passed ON buyer_agent_judgments(passed)`,
  )
}
