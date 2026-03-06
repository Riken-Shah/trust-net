import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildOutputQualityNotes,
  computeConfidence,
  computeConsistencyScore,
  computeFailureRate,
  computeRankScore,
  computeRoiEstimate,
  computeTextRelevance,
} from '../scoring.js'
import { type IntelAgentProfileRow, type IntelAgentWindowMetrics } from '../types.js'

function buildProfile(overrides: Partial<IntelAgentProfileRow> = {}): IntelAgentProfileRow {
  return {
    agentUuid: 'agent-1',
    nvmAgentId: 'nvm-1',
    marketplaceId: 'market-1',
    name: 'Alpha Search Agent',
    description: 'Fast web search and synthesis',
    category: 'search',
    endpointUrl: 'https://agent.example',
    isActive: true,
    keywords: ['search', 'analysis'],
    servicesText: 'web search summarize',
    planNamesText: 'starter pro',
    totalOrders: 100,
    uniqueBuyers: 60,
    repeatBuyers: 25,
    totalRequests: 200,
    successfulBurns: 180,
    failedBurns: 20,
    totalCreditsBurned: 300,
    trustScore: 81,
    trustTier: 'gold',
    trustReliability: 0.9,
    trustReviewScore: 0.82,
    trustReviewCount: 12,
    avgReviewScore: 8.2,
    avgScoreAccuracy: 8.5,
    avgScoreSpeed: 7.2,
    avgScoreValue: 7.9,
    avgScoreReliability: 8.1,
    minPlanPriceUsd: 0.12,
    minPlanId: 'plan-1',
    roiUnavailableReason: null,
    ...overrides,
  }
}

function buildWindow(overrides: Partial<IntelAgentWindowMetrics> = {}): IntelAgentWindowMetrics {
  return {
    windowDataAvailable: true,
    windowStart: new Date(Date.now() - 30 * 60_000).toISOString(),
    windowEnd: new Date().toISOString(),
    orderDelta30m: 20,
    uniqueBuyersDelta30m: 8,
    repeatBuyersDelta30m: 3,
    repeatPurchases30m: 12,
    totalRequestsDelta30m: 40,
    successfulBurnsDelta30m: 34,
    failedBurnsDelta30m: 6,
    totalCreditsBurnedDelta30m: 55,
    failureRate30m: 0.15,
    dataFreshnessSeconds: 10,
    previousFailureRate30m: 0.1,
    ...overrides,
  }
}

test('computeRoiEstimate uses reliability-adjusted expected cost', () => {
  const profile = buildProfile({ minPlanPriceUsd: 0.2, successfulBurns: 80, totalRequests: 100 })
  const roi = computeRoiEstimate(profile)

  assert.equal(roi.expectedCostPerSuccessUsd, 0.25)
  assert.equal(roi.minPlanPriceUsd, 0.2)
  assert.equal(roi.unavailableReason, null)
})

test('computeFailureRate handles division safely', () => {
  assert.equal(computeFailureRate(0, 0), 0)
  assert.equal(computeFailureRate(5, 20), 0.25)
})

test('computeTextRelevance rewards exact and field matches', () => {
  const profile = buildProfile()
  const relevance = computeTextRelevance(profile, 'alpha search agent')
  assert.ok(relevance > 0.9)

  const lower = computeTextRelevance(profile, 'nonexistent')
  assert.equal(lower, 0)
})

test('computeConsistencyScore incorporates volatility with window rates', () => {
  const profile = buildProfile({ successfulBurns: 90, totalRequests: 100 })
  const consistency = computeConsistencyScore(profile, buildWindow({ failureRate30m: 0.2, previousFailureRate30m: 0.05 }))

  assert.ok(consistency.score < 95)
  assert.equal(consistency.sampleWindows, 2)
})

test('computeRankScore and computeConfidence remain in range', () => {
  const profile = buildProfile()
  const roi = computeRoiEstimate(profile)
  const rank = computeRankScore({ textRelevance: 0.8, roiScore: 0.7, trustScore: 75, consistencyScore: 70 })
  const confidence = computeConfidence({ textRelevance: 0.8, profile, roiEstimate: roi })

  assert.ok(rank >= 0 && rank <= 1)
  assert.ok(confidence >= 0 && confidence <= 1)
})

test('buildOutputQualityNotes emits review and comment notes', () => {
  const notes = buildOutputQualityNotes(buildProfile(), ['Great quality', 'Fast response'])
  assert.ok(notes.some((note) => note.includes('Overall review score')))
  assert.ok(notes.some((note) => note.includes('Recent feedback')))
})

