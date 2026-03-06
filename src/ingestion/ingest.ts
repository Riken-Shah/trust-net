/**
 * Blockchain order scanner — reads blockchain_sync checkpoints, fetches USDC
 * transfers from Etherscan, inserts into orders table, and upserts agent_computed_stats.
 *
 * All DB writes for a given wallet happen in a single transaction for crash safety.
 */

import { type Pool, type PoolClient } from 'pg'

import { fetchTokenTransfers, usdcToHuman, type TokenTransfer, USDC_CONTRACT } from './etherscan.js'

// ── Types ────────────────────────────────────────────────────────────────────

interface BlockchainSyncRow {
  event_type: string
  filter_key: string
  network: string
  last_block: string // bigint comes as string from pg
}

interface AgentLookup {
  id: string
  wallet_address: string
}

export interface OrderScanOptions {
  etherscanApiKey: string
  /** Delay between Etherscan calls (ms). Default 250 to stay under rate limits. */
  delayMs?: number
  fetchImpl?: typeof fetch
}

export interface OrderScanResult {
  walletsScanned: number
  walletsSkipped: number
  ordersInserted: number
  errors: string[]
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

// ── Core scan ────────────────────────────────────────────────────────────────

async function getOrderCheckpoints(pool: Pool): Promise<BlockchainSyncRow[]> {
  const result = await pool.query<BlockchainSyncRow>(
    `SELECT event_type, filter_key, network, last_block::text
     FROM blockchain_sync
     WHERE event_type = 'order'
     ORDER BY filter_key`,
  )
  return result.rows
}

async function resolveAgentByWallet(client: PoolClient, walletAddress: string): Promise<AgentLookup | null> {
  const result = await client.query<AgentLookup>(
    `SELECT id, wallet_address FROM agents WHERE wallet_address = $1 LIMIT 1`,
    [walletAddress.toLowerCase()],
  )
  return result.rows[0] ?? null
}

async function insertOrders(
  client: PoolClient,
  agentId: string,
  transfers: TokenTransfer[],
  network: string,
): Promise<number> {
  let inserted = 0

  for (const tx of transfers) {
    const result = await client.query(
      `INSERT INTO orders (
        agent_id, tx_hash, block_number, from_wallet, to_wallet,
        raw_value, usdc_amount, tx_timestamp,
        token_address, token_symbol, network, method_id, function_name
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, to_timestamp($8::bigint), $9, $10, $11, $12, $13)
      ON CONFLICT (tx_hash) DO NOTHING`,
      [
        agentId,
        tx.hash,
        Number(tx.blockNumber),
        tx.from.toLowerCase(),
        tx.to.toLowerCase(),
        tx.value,
        usdcToHuman(tx.value),
        tx.timeStamp,
        USDC_CONTRACT.toLowerCase(),
        tx.tokenSymbol || 'USDC',
        network,
        tx.methodId || null,
        tx.functionName || null,
      ],
    )
    inserted += result.rowCount ?? 0
  }

  return inserted
}

async function upsertComputedStats(
  client: PoolClient,
  agentId: string,
): Promise<void> {
  // Use the agent's first plan from agent_services as the stats key.
  // Blockchain transfers don't carry plan IDs, so we resolve from the DB.
  const planResult = await client.query<{ nvm_plan_id: string }>(
    `SELECT nvm_plan_id FROM agent_services WHERE agent_id = $1 AND is_active = TRUE ORDER BY synced_at LIMIT 1`,
    [agentId],
  )
  const planId = planResult.rows[0]?.nvm_plan_id
  if (!planId) {
    // No plan linked — skip stats rather than violate FK
    return
  }

  // Recompute from orders table for this agent — single source of truth
  await client.query(
    `INSERT INTO agent_computed_stats (agent_id, nvm_plan_id, event_type, total_orders, unique_buyers, repeat_buyers, last_event_block, last_event_at, updated_at)
     SELECT
       $1::uuid,
       $2,
       'order',
       COUNT(*)::int,
       COUNT(DISTINCT o.from_wallet)::int,
       (SELECT COUNT(*)::int FROM (
         SELECT from_wallet FROM orders WHERE agent_id = $1::uuid GROUP BY from_wallet HAVING COUNT(*) > 1
       ) r),
       MAX(o.block_number),
       MAX(o.tx_timestamp),
       NOW()
     FROM orders o
     WHERE o.agent_id = $1::uuid
     ON CONFLICT (agent_id, nvm_plan_id, event_type)
     DO UPDATE SET
       total_orders     = EXCLUDED.total_orders,
       unique_buyers    = EXCLUDED.unique_buyers,
       repeat_buyers    = EXCLUDED.repeat_buyers,
       last_event_block = GREATEST(agent_computed_stats.last_event_block, EXCLUDED.last_event_block),
       last_event_at    = GREATEST(agent_computed_stats.last_event_at, EXCLUDED.last_event_at),
       updated_at       = NOW()`,
    [agentId, planId],
  )
}

async function updateCheckpoint(
  client: PoolClient,
  filterKey: string,
  network: string,
  newBlock: number,
): Promise<void> {
  await client.query(
    `UPDATE blockchain_sync
     SET last_block = GREATEST(last_block, $1),
         last_polled_at = NOW()
     WHERE event_type = 'order' AND filter_key = $2 AND network = $3`,
    [newBlock, filterKey, network],
  )
}

// ── Public entry point ───────────────────────────────────────────────────────

export async function runOrderScan(pool: Pool, options: OrderScanOptions): Promise<OrderScanResult> {
  const delayMs = options.delayMs ?? 250
  const result: OrderScanResult = {
    walletsScanned: 0,
    walletsSkipped: 0,
    ordersInserted: 0,
    errors: [],
  }

  const checkpoints = await getOrderCheckpoints(pool)

  if (checkpoints.length === 0) {
    console.log('No order checkpoints found in blockchain_sync. Run marketplace ingestion first.')
    return result
  }

  console.log(`Found ${checkpoints.length} order checkpoint(s) to scan.`)

  for (const checkpoint of checkpoints) {
    const walletAddress = checkpoint.filter_key
    const lastBlock = Number(checkpoint.last_block)
    const startBlock = lastBlock + 1

    console.log(`\nScanning wallet ${walletAddress} from block ${startBlock}...`)

    let transfers: TokenTransfer[]
    try {
      transfers = await fetchTokenTransfers(
        {
          walletAddress,
          apiKey: options.etherscanApiKey,
          startBlock,
        },
        options.fetchImpl,
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error(`  Error fetching transfers for ${walletAddress}: ${message}`)
      result.errors.push(`${walletAddress}: ${message}`)
      result.walletsSkipped += 1
      continue
    }

    // Rate-limit politeness
    if (delayMs > 0) {
      await sleep(delayMs)
    }

    // Filter to received-only transfers (someone paid this agent)
    const received = transfers.filter(
      (tx) => tx.to.toLowerCase() === walletAddress.toLowerCase(),
    )

    if (received.length === 0) {
      console.log(`  No new incoming transfers.`)
      result.walletsScanned += 1

      // Still update checkpoint if there were outgoing transfers
      if (transfers.length > 0) {
        const maxBlock = Math.max(...transfers.map((tx) => Number(tx.blockNumber)))
        const client = await pool.connect()
        try {
          await client.query('BEGIN')
          await updateCheckpoint(client, walletAddress, checkpoint.network, maxBlock)
          await client.query('COMMIT')
        } catch (error) {
          await client.query('ROLLBACK')
          console.error(`  Error updating checkpoint for ${walletAddress}:`, error)
        } finally {
          client.release()
        }
      }
      continue
    }

    // All DB writes for this wallet in a single transaction
    const client = await pool.connect()
    try {
      await client.query('BEGIN')

      const agent = await resolveAgentByWallet(client, walletAddress)
      if (!agent) {
        console.warn(`  No agent found for wallet ${walletAddress}, skipping.`)
        await client.query('ROLLBACK')
        result.walletsSkipped += 1
        continue
      }

      const inserted = await insertOrders(client, agent.id, received, checkpoint.network)
      console.log(`  Inserted ${inserted} new order(s) (${received.length} received transfers).`)

      await upsertComputedStats(client, agent.id)

      const maxBlock = Math.max(...received.map((tx) => Number(tx.blockNumber)))
      await updateCheckpoint(client, walletAddress, checkpoint.network, maxBlock)

      await client.query('COMMIT')

      result.ordersInserted += inserted
      result.walletsScanned += 1
    } catch (error) {
      await client.query('ROLLBACK')
      const message = error instanceof Error ? error.message : String(error)
      console.error(`  Transaction failed for ${walletAddress}: ${message}`)
      result.errors.push(`${walletAddress}: ${message}`)
      result.walletsSkipped += 1
    } finally {
      client.release()
    }
  }

  return result
}
