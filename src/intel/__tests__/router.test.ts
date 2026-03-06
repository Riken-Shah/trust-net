import assert from 'node:assert/strict'
import test from 'node:test'

import { createIntelRouter, parseCompareIds, parseSearchQuery } from '../router.js'
import { IntelServiceError, type IntelService } from '../service.js'

function buildMockService(): IntelService {
  return {
    async getAgentProfile(agentId: string) {
      if (!agentId.trim()) {
        throw new IntelServiceError(400, 'invalid_agent_id', 'bad id')
      }
      return {
        agent: {
          id: '1',
          nvmAgentId: agentId,
          marketplaceId: 'mk',
          name: 'Agent',
          description: null,
          category: null,
          endpointUrl: null,
          isActive: true,
          trustScore: null,
          trustTier: null,
          trustReviewCount: 0,
        },
        trust: { trustScore: null, tier: null, scoreReliability: null, scoreReviews: null, reviewCount: 0 },
        lifetimeMetrics: {
          totalOrders: 0,
          uniqueBuyers: 0,
          repeatBuyers: 0,
          totalRequests: 0,
          successfulBurns: 0,
          failedBurns: 0,
          totalCreditsBurned: 0,
          failureRate: 0,
        },
        failureHistory: {
          lifetime: { failedBurns: 0, totalRequests: 0, failureRate: 0 },
          last30m: {
            windowDataAvailable: false,
            failedBurns: 0,
            totalRequests: 0,
            failureRate: null,
            windowStart: null,
            windowEnd: null,
            dataFreshnessSeconds: null,
          },
          trend: 'unknown' as const,
        },
        consistencyScore: {
          score: 0,
          reliabilityComponent: 0,
          volatilityComponent: 0,
          confidence: 0,
          sampleWindows: 0,
        },
        outputQualityNotes: [],
        cheaperAlternatives: [],
      }
    },
    async search(query: string) {
      if (!query.trim()) {
        throw new IntelServiceError(400, 'invalid_query', 'bad query')
      }
      return {
        query,
        generatedAt: new Date().toISOString(),
        resultCount: 0,
        results: [],
      }
    },
    async getTrending() {
      return {
        windowMinutes: 30,
        insufficientWindowData: true,
        windowStart: null,
        windowEnd: null,
        dataFreshnessSeconds: null,
        generatedAt: new Date().toISOString(),
        agents: [],
      }
    },
    async getAvoidList() {
      return {
        windowMinutes: 30,
        threshold: 3,
        insufficientWindowData: true,
        windowStart: null,
        windowEnd: null,
        dataFreshnessSeconds: null,
        generatedAt: new Date().toISOString(),
        agents: [],
      }
    },
    async compare(ids: string[]) {
      if (ids.length < 2) {
        throw new IntelServiceError(400, 'invalid_ids', 'need ids')
      }
      return {
        generatedAt: new Date().toISOString(),
        agents: [],
        summary: {
          bestReliability: null,
          bestRoi: null,
          bestConsistency: null,
          lowestRecentFailures: null,
        },
      }
    },
    async captureSnapshotNow() {
      return { inserted: 0, snapshotAt: new Date() }
    },
  }
}

test('parse helpers normalize query inputs', () => {
  assert.deepEqual(parseCompareIds('a,b, c '), ['a', 'b', 'c'])
  assert.equal(parseSearchQuery('  hello  '), 'hello')
  assert.deepEqual(parseCompareIds(undefined), [])
  assert.equal(parseSearchQuery(undefined), '')
})

test('createIntelRouter builds router instance', () => {
  const router = createIntelRouter(buildMockService())
  assert.ok(router)
})
