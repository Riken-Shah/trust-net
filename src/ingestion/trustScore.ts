/**
 * Trust score computation — recomputes trust_scores for all active agents.
 *
 * Adaptive weighting: only signals with data contribute. Weights are
 * redistributed proportionally among available signals so the 0–100
 * scale stays meaningful regardless of which data sources exist.
 *
 * Base weights (when all data is present):
 *   score_reliability  × 0.35   ← successful_burns / total_requests
 *   score_repeat_usage × 0.25   ← repeat_buyers / unique_buyers
 *   score_reviews      × 0.20   ← avg(score) / 10
 *   score_volume       × 0.20   ← log10(total_requests + 1) normalised
 *
 * Example: no burn data + no reviews → only repeat_usage is available,
 * so it gets weight 1.0 and an agent with 100% repeat buyers scores 100.
 *
 * Tier thresholds: platinum ≥ 80, gold ≥ 60, silver ≥ 40, bronze ≥ 20, else unverified.
 */

import { type Pool } from 'pg'

export interface TrustScoreResult {
  agentsComputed: number
  errors: string[]
}

function computeTier(score: number): string {
  if (score >= 80) return 'platinum'
  if (score >= 60) return 'gold'
  if (score >= 40) return 'silver'
  if (score >= 20) return 'bronze'
  return 'unverified'
}

export async function computeTrustScores(pool: Pool): Promise<TrustScoreResult> {
  const result: TrustScoreResult = { agentsComputed: 0, errors: [] }

  // Compute trust scores for ALL active agents, not just those with stats
  const agentsResult = await pool.query<{ agent_id: string }>(
    `SELECT id AS agent_id FROM agents WHERE is_active = TRUE`,
  )

  if (agentsResult.rows.length === 0) {
    console.log('No active agents found. Skipping trust score computation.')
    return result
  }

  for (const { agent_id } of agentsResult.rows) {
    const client = await pool.connect()
    try {
      // Fetch order stats
      const orderStats = await client.query<{
        total_orders: number
        unique_buyers: number
        repeat_buyers: number
      }>(
        `SELECT
           COALESCE(SUM(total_orders), 0)::int AS total_orders,
           COALESCE(SUM(unique_buyers), 0)::int AS unique_buyers,
           COALESCE(SUM(repeat_buyers), 0)::int AS repeat_buyers
         FROM agent_computed_stats
         WHERE agent_id = $1 AND event_type = 'order'`,
        [agent_id],
      )

      // Fetch burn stats
      const burnStats = await client.query<{
        total_requests: number
        successful_burns: number
      }>(
        `SELECT
           COALESCE(SUM(total_requests), 0)::int AS total_requests,
           COALESCE(SUM(successful_burns), 0)::int AS successful_burns
         FROM agent_computed_stats
         WHERE agent_id = $1 AND event_type = 'burn'`,
        [agent_id],
      )

      // Fetch review stats
      const reviewStats = await client.query<{
        avg_score: number | null
        review_count: number
      }>(
        `SELECT
           AVG(score)::numeric AS avg_score,
           COUNT(*)::int AS review_count
         FROM reviews
         WHERE agent_id = $1`,
        [agent_id],
      )

      const orders = orderStats.rows[0]!
      const burns = burnStats.rows[0]!
      const reviews = reviewStats.rows[0]!

      // ── Compute raw signal scores (0–1 each) ──────────────────────────

      const hasBurns = burns.total_requests > 0
      const hasOrders = orders.unique_buyers > 0
      const hasReviews = reviews.avg_score !== null

      // score_reliability: successful_burns / total_requests
      const scoreReliability = hasBurns
        ? burns.successful_burns / burns.total_requests
        : 0

      // score_volume: log10(total_requests + 1) normalised to 0–1
      const scoreVolume = hasBurns
        ? Math.min(Math.log10(burns.total_requests + 1) / 3, 1)
        : 0

      // score_repeat_usage: repeat_buyers / unique_buyers
      const scoreRepeatUsage = hasOrders
        ? orders.repeat_buyers / orders.unique_buyers
        : 0

      // score_reviews: avg(score) / 10
      const scoreReviews = hasReviews
        ? Number(reviews.avg_score) / 10
        : 0

      // ── Adaptive weighting — redistribute among available signals ────
      // Base weights from v8 schema
      const baseWeights = {
        reliability: 0.35,
        repeatUsage: 0.25,
        reviews: 0.20,
        volume: 0.20,
      }

      // Only include signals that have data
      let activeWeight = 0
      if (hasBurns) activeWeight += baseWeights.reliability + baseWeights.volume
      if (hasOrders) activeWeight += baseWeights.repeatUsage
      if (hasReviews) activeWeight += baseWeights.reviews

      // If no data at all, trust score is 0
      let trustScore = 0
      if (activeWeight > 0) {
        const scale = 1 / activeWeight
        trustScore = (
          (hasBurns ? scoreReliability * baseWeights.reliability * scale : 0) +
          (hasOrders ? scoreRepeatUsage * baseWeights.repeatUsage * scale : 0) +
          (hasReviews ? scoreReviews * baseWeights.reviews * scale : 0) +
          (hasBurns ? scoreVolume * baseWeights.volume * scale : 0)
        ) * 100
      }

      const tier = computeTier(trustScore)
      const reviewCount = reviews.review_count

      await client.query(
        `INSERT INTO trust_scores (
           agent_id, score_reliability, score_volume, score_repeat_usage,
           score_reviews, trust_score, tier, review_count, last_computed
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
         ON CONFLICT (agent_id)
         DO UPDATE SET
           score_reliability = EXCLUDED.score_reliability,
           score_volume = EXCLUDED.score_volume,
           score_repeat_usage = EXCLUDED.score_repeat_usage,
           score_reviews = EXCLUDED.score_reviews,
           trust_score = EXCLUDED.trust_score,
           tier = EXCLUDED.tier,
           review_count = EXCLUDED.review_count,
           last_computed = NOW()`,
        [
          agent_id,
          Math.round(scoreReliability * 10000) / 10000,
          Math.round(scoreVolume * 10000) / 10000,
          Math.round(scoreRepeatUsage * 10000) / 10000,
          Math.round(scoreReviews * 10000) / 10000,
          Math.round(trustScore * 100) / 100,
          tier,
          reviewCount,
        ],
      )

      result.agentsComputed += 1
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error(`  Error computing trust score for ${agent_id}: ${message}`)
      result.errors.push(`${agent_id}: ${message}`)
    } finally {
      client.release()
    }
  }

  return result
}
