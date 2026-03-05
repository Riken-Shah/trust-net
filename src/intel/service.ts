import { type Pool } from 'pg'

import {
  buildOutputQualityNotes,
  computeConfidence,
  computeConsistencyScore,
  computeFailureRate,
  computeFailureWarnings,
  computeRankScore,
  computeRoiEstimate,
  computeRoiScore,
  computeTextRelevance,
  selectFailureTrend,
  safeRatio,
} from './scoring.js'
import {
  captureIntelAgentStatsSnapshot,
  fetchAgentProfileByNvmAgentId,
  fetchAgentProfilesByNvmAgentIds,
  fetchAgentSnapshotHistory,
  fetchAllAgentProfiles,
  fetchRecentReviewComments,
  fetchWindowMetrics,
  searchAgentProfiles,
} from './repository.js'
import {
  type IntelAgentProfileResponse,
  type IntelAgentProfileRow,
  type IntelAgentSummary,
  type IntelAgentWindowMetrics,
  type IntelAvoidResponse,
  type IntelCompareResponse,
  type IntelQueryError,
  type IntelSearchResponse,
  type IntelSnapshotRow,
  type IntelTrendingResponse,
  type IntelWindowMetrics,
} from './types.js'

export interface IntelServiceConfig {
  windowMinutes: number
  searchResultLimit: number
  avoidFailureThreshold: number
}

const DEFAULT_CONFIG: IntelServiceConfig = {
  windowMinutes: 30,
  searchResultLimit: 50,
  avoidFailureThreshold: 3,
}

export class IntelServiceError extends Error implements IntelQueryError {
  status: number
  code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.status = status
    this.code = code
  }
}

export interface IntelService {
  getAgentProfile(agentId: string): Promise<IntelAgentProfileResponse>
  search(query: string): Promise<IntelSearchResponse>
  getTrending(): Promise<IntelTrendingResponse>
  getAvoidList(): Promise<IntelAvoidResponse>
  compare(ids: string[]): Promise<IntelCompareResponse>
  captureSnapshotNow(now?: Date): Promise<{ inserted: number; snapshotAt: Date }>
}

function toAgentSummary(profile: IntelAgentProfileRow): IntelAgentSummary {
  return {
    id: profile.agentUuid,
    nvmAgentId: profile.nvmAgentId,
    marketplaceId: profile.marketplaceId,
    name: profile.name,
    description: profile.description,
    category: profile.category,
    endpointUrl: profile.endpointUrl,
    isActive: profile.isActive,
    trustScore: profile.trustScore,
    trustTier: profile.trustTier,
    trustReviewCount: profile.trustReviewCount,
  }
}

function toWindowByAgent(windowRows: IntelWindowMetrics[]): Map<string, IntelWindowMetrics> {
  const map = new Map<string, IntelWindowMetrics>()
  for (const row of windowRows) {
    map.set(row.agentId, row)
  }
  return map
}

function findSnapshotAtOrBefore(history: IntelSnapshotRow[], cutoff: Date): IntelSnapshotRow | null {
  for (const snapshot of history) {
    if (snapshot.snapshotAt.getTime() <= cutoff.getTime()) {
      return snapshot
    }
  }
  return null
}

function toIsoString(value: Date | null): string | null {
  return value ? value.toISOString() : null
}

function derivePreviousFailureRate(windowMinutes: number, history: IntelSnapshotRow[]): number | null {
  const latest = history[0]
  if (!latest) {
    return null
  }

  const baseline30Cutoff = new Date(latest.snapshotAt)
  baseline30Cutoff.setUTCMinutes(baseline30Cutoff.getUTCMinutes() - windowMinutes)

  const baseline60Cutoff = new Date(latest.snapshotAt)
  baseline60Cutoff.setUTCMinutes(baseline60Cutoff.getUTCMinutes() - windowMinutes * 2)

  const baseline30 = findSnapshotAtOrBefore(history, baseline30Cutoff)
  const baseline60 = findSnapshotAtOrBefore(history, baseline60Cutoff)

  if (!baseline30 || !baseline60) {
    return null
  }

  const failedDelta = Math.max(baseline30.failedBurns - baseline60.failedBurns, 0)
  const totalDelta = Math.max(baseline30.totalRequests - baseline60.totalRequests, 0)
  if (totalDelta <= 0) {
    return null
  }

  return failedDelta / totalDelta
}

function buildAgentWindowMetrics(
  windowRow: IntelWindowMetrics | null,
  previousFailureRate30m: number | null,
  now: Date,
): IntelAgentWindowMetrics {
  if (!windowRow) {
    return {
      windowDataAvailable: false,
      windowStart: null,
      windowEnd: null,
      orderDelta30m: 0,
      uniqueBuyersDelta30m: 0,
      repeatBuyersDelta30m: 0,
      repeatPurchases30m: 0,
      totalRequestsDelta30m: 0,
      successfulBurnsDelta30m: 0,
      failedBurnsDelta30m: 0,
      totalCreditsBurnedDelta30m: 0,
      failureRate30m: null,
      dataFreshnessSeconds: null,
      previousFailureRate30m: null,
    }
  }

  const repeatPurchases30m = Math.max(windowRow.orderDelta30m - windowRow.uniqueBuyersDelta30m, 0)
  const failureRate30m = windowRow.totalRequestsDelta30m > 0
    ? windowRow.failedBurnsDelta30m / windowRow.totalRequestsDelta30m
    : null

  const freshnessSeconds = Math.max(
    0,
    Math.floor((now.getTime() - windowRow.latestSnapshotAt.getTime()) / 1000),
  )

  return {
    windowDataAvailable: windowRow.windowDataAvailable,
    windowStart: toIsoString(windowRow.baselineSnapshotAt),
    windowEnd: toIsoString(windowRow.latestSnapshotAt),
    orderDelta30m: windowRow.orderDelta30m,
    uniqueBuyersDelta30m: windowRow.uniqueBuyersDelta30m,
    repeatBuyersDelta30m: windowRow.repeatBuyersDelta30m,
    repeatPurchases30m,
    totalRequestsDelta30m: windowRow.totalRequestsDelta30m,
    successfulBurnsDelta30m: windowRow.successfulBurnsDelta30m,
    failedBurnsDelta30m: windowRow.failedBurnsDelta30m,
    totalCreditsBurnedDelta30m: windowRow.totalCreditsBurnedDelta30m,
    failureRate30m,
    dataFreshnessSeconds: freshnessSeconds,
    previousFailureRate30m,
  }
}

function validateAgentId(agentId: string): string {
  const trimmed = agentId.trim()
  if (!trimmed) {
    throw new IntelServiceError(400, 'invalid_agent_id', 'agentId must be a non-empty nvm_agent_id.')
  }
  return trimmed
}

function validateSearchQuery(query: string): string {
  const trimmed = query.trim()
  if (trimmed.length < 2 || trimmed.length > 120) {
    throw new IntelServiceError(400, 'invalid_query', 'q must be between 2 and 120 characters.')
  }
  return trimmed
}

function validateCompareIds(ids: string[]): string[] {
  const cleaned = ids.map((id) => id.trim()).filter((id) => id.length > 0)
  const unique = [...new Set(cleaned)]

  if (unique.length < 2 || unique.length > 3) {
    throw new IntelServiceError(400, 'invalid_ids', 'ids must contain 2 to 3 unique nvm_agent_id values.')
  }

  return unique
}

function reliabilityFromProfile(profile: IntelAgentProfileRow): number {
  if (profile.totalRequests > 0) {
    return safeRatio(profile.successfulBurns, profile.totalRequests)
  }
  return profile.trustReliability ?? 0
}

function buildCheaperAlternatives(
  target: IntelAgentProfileRow,
  allProfiles: IntelAgentProfileRow[],
): IntelAgentProfileResponse['cheaperAlternatives'] {
  const targetRoi = computeRoiEstimate(target)
  if (targetRoi.expectedCostPerSuccessUsd === null) {
    return []
  }
  const targetExpectedCost = targetRoi.expectedCostPerSuccessUsd

  const targetReliability = reliabilityFromProfile(target)

  const candidates = allProfiles
    .filter((candidate) => candidate.agentUuid !== target.agentUuid)
    .filter((candidate) => candidate.category === target.category)
    .map((candidate) => {
      const roi = computeRoiEstimate(candidate)
      const reliability = reliabilityFromProfile(candidate)

      if (roi.expectedCostPerSuccessUsd === null) {
        return null
      }

      if (roi.expectedCostPerSuccessUsd >= targetExpectedCost) {
        return null
      }

      if (reliability < Math.max(targetReliability - 0.05, 0)) {
        return null
      }

      const deltaPercent =
        ((targetExpectedCost - roi.expectedCostPerSuccessUsd) /
          targetExpectedCost) *
        100

      return {
        nvmAgentId: candidate.nvmAgentId,
        name: candidate.name,
        category: candidate.category,
        expectedCostPerSuccessUsd: Number(roi.expectedCostPerSuccessUsd.toFixed(6)),
        deltaPercent: Number(deltaPercent.toFixed(2)),
        reliability: Number(reliability.toFixed(4)),
        trustScore: candidate.trustScore,
        reason: `Lower expected cost per successful request with comparable reliability.`,
      }
    })
    .filter((item): item is NonNullable<typeof item> => item !== null)
    .sort((a, b) => {
      if (a.expectedCostPerSuccessUsd !== b.expectedCostPerSuccessUsd) {
        return a.expectedCostPerSuccessUsd - b.expectedCostPerSuccessUsd
      }
      return b.reliability - a.reliability
    })

  return candidates.slice(0, 3)
}

function ensureFoundProfiles(requestedIds: string[], profiles: IntelAgentProfileRow[]): void {
  const found = new Set(profiles.map((profile) => profile.nvmAgentId))
  const missing = requestedIds.filter((id) => !found.has(id))
  if (missing.length > 0) {
    throw new IntelServiceError(404, 'agent_not_found', `Some requested agents were not found: ${missing.join(', ')}`)
  }
}

export function createIntelService(pool: Pool, config: Partial<IntelServiceConfig> = {}): IntelService {
  const resolvedConfig: IntelServiceConfig = {
    ...DEFAULT_CONFIG,
    ...config,
  }

  return {
    async getAgentProfile(agentId: string): Promise<IntelAgentProfileResponse> {
      const validatedId = validateAgentId(agentId)
      const profile = await fetchAgentProfileByNvmAgentId(pool, validatedId)
      if (!profile) {
        throw new IntelServiceError(404, 'agent_not_found', `No active agent found for nvm_agent_id '${validatedId}'.`)
      }

      const [windowRows, recentCommentsRows, allProfiles, history] = await Promise.all([
        fetchWindowMetrics(pool, resolvedConfig.windowMinutes),
        fetchRecentReviewComments(pool, profile.agentUuid, 3),
        fetchAllAgentProfiles(pool),
        fetchAgentSnapshotHistory(pool, profile.agentUuid, 20),
      ])

      const windowRow = toWindowByAgent(windowRows).get(profile.agentUuid) ?? null
      const now = new Date()
      const previousFailureRate30m = derivePreviousFailureRate(resolvedConfig.windowMinutes, history)
      const windowMetrics = buildAgentWindowMetrics(windowRow, previousFailureRate30m, now)
      const consistency = computeConsistencyScore(profile, windowMetrics)
      const recentComments = recentCommentsRows.map((row) => row.comment)
      const outputQualityNotes = buildOutputQualityNotes(profile, recentComments)
      const cheaperAlternatives = buildCheaperAlternatives(profile, allProfiles)

      return {
        agent: toAgentSummary(profile),
        trust: {
          trustScore: profile.trustScore,
          tier: profile.trustTier,
          scoreReliability: profile.trustReliability,
          scoreReviews: profile.trustReviewScore,
          reviewCount: profile.trustReviewCount,
        },
        lifetimeMetrics: {
          totalOrders: profile.totalOrders,
          uniqueBuyers: profile.uniqueBuyers,
          repeatBuyers: profile.repeatBuyers,
          totalRequests: profile.totalRequests,
          successfulBurns: profile.successfulBurns,
          failedBurns: profile.failedBurns,
          totalCreditsBurned: profile.totalCreditsBurned,
          failureRate: computeFailureRate(profile.failedBurns, profile.totalRequests),
        },
        failureHistory: {
          lifetime: {
            failedBurns: profile.failedBurns,
            totalRequests: profile.totalRequests,
            failureRate: computeFailureRate(profile.failedBurns, profile.totalRequests),
          },
          last30m: {
            windowDataAvailable: windowMetrics.windowDataAvailable,
            failedBurns: windowMetrics.failedBurnsDelta30m,
            totalRequests: windowMetrics.totalRequestsDelta30m,
            failureRate: windowMetrics.failureRate30m,
            windowStart: windowMetrics.windowStart,
            windowEnd: windowMetrics.windowEnd,
            dataFreshnessSeconds: windowMetrics.dataFreshnessSeconds,
          },
          trend: selectFailureTrend(windowMetrics.failureRate30m, windowMetrics.previousFailureRate30m),
        },
        consistencyScore: consistency,
        outputQualityNotes,
        cheaperAlternatives,
      }
    },

    async search(query: string): Promise<IntelSearchResponse> {
      const validatedQuery = validateSearchQuery(query)

      const [profiles, windowRows] = await Promise.all([
        searchAgentProfiles(pool, validatedQuery),
        fetchWindowMetrics(pool, resolvedConfig.windowMinutes),
      ])

      const windowByAgent = toWindowByAgent(windowRows)
      const now = new Date()

      const results = profiles
        .map((profile) => {
          const windowMetrics = buildAgentWindowMetrics(windowByAgent.get(profile.agentUuid) ?? null, null, now)
          const roiEstimate = computeRoiEstimate(profile)
          const textRelevance = computeTextRelevance(profile, validatedQuery)
          const consistency = computeConsistencyScore(profile, windowMetrics)
          const roiScore = computeRoiScore(roiEstimate)
          const rankScore = computeRankScore({
            textRelevance,
            roiScore,
            trustScore: profile.trustScore,
            consistencyScore: consistency.score,
          })
          const confidence = computeConfidence({
            textRelevance,
            profile,
            roiEstimate,
          })
          const failureWarnings = computeFailureWarnings(profile, windowMetrics)

          return {
            agent: toAgentSummary(profile),
            rankScore,
            confidence,
            textRelevance,
            roiEstimate,
            consistencyScore: consistency,
            failureWarnings,
          }
        })
        .sort((a, b) => {
          if (b.rankScore !== a.rankScore) {
            return b.rankScore - a.rankScore
          }
          return (b.agent.trustScore ?? 0) - (a.agent.trustScore ?? 0)
        })
        .slice(0, resolvedConfig.searchResultLimit)

      return {
        query: validatedQuery,
        generatedAt: new Date().toISOString(),
        resultCount: results.length,
        results,
      }
    },

    async getTrending(): Promise<IntelTrendingResponse> {
      const [profiles, windowRows] = await Promise.all([
        fetchAllAgentProfiles(pool),
        fetchWindowMetrics(pool, resolvedConfig.windowMinutes),
      ])

      const profileByAgent = new Map(profiles.map((profile) => [profile.agentUuid, profile]))
      const now = new Date()

      const entries = windowRows
        .map((row) => {
          const profile = profileByAgent.get(row.agentId)
          if (!profile) {
            return null
          }

          const windowMetrics = buildAgentWindowMetrics(row, null, now)
          const repeatPurchases30m = windowMetrics.repeatPurchases30m

          return {
            agent: toAgentSummary(profile),
            repeatPurchases30m,
            orders30m: windowMetrics.orderDelta30m,
            uniqueBuyers30m: windowMetrics.uniqueBuyersDelta30m,
            trustScore: profile.trustScore,
            windowMetrics,
          }
        })
        .filter((entry): entry is NonNullable<typeof entry> => entry !== null)

      const insufficientWindowData = entries.some((entry) => !entry.windowMetrics.windowDataAvailable) || entries.length === 0

      const sorted = entries
        .filter((entry) => entry.repeatPurchases30m > 0)
        .sort((a, b) => {
          if (b.repeatPurchases30m !== a.repeatPurchases30m) {
            return b.repeatPurchases30m - a.repeatPurchases30m
          }
          if (b.orders30m !== a.orders30m) {
            return b.orders30m - a.orders30m
          }
          return (b.trustScore ?? 0) - (a.trustScore ?? 0)
        })

      const firstWindow = sorted[0]?.windowMetrics ?? entries[0]?.windowMetrics

      return {
        windowMinutes: resolvedConfig.windowMinutes,
        insufficientWindowData,
        windowStart: firstWindow?.windowStart ?? null,
        windowEnd: firstWindow?.windowEnd ?? null,
        dataFreshnessSeconds: firstWindow?.dataFreshnessSeconds ?? null,
        generatedAt: now.toISOString(),
        agents: sorted.map((entry) => ({
          agent: entry.agent,
          repeatPurchases30m: entry.repeatPurchases30m,
          orders30m: entry.orders30m,
          uniqueBuyers30m: entry.uniqueBuyers30m,
          trustScore: entry.trustScore,
        })),
      }
    },

    async getAvoidList(): Promise<IntelAvoidResponse> {
      const [profiles, windowRows] = await Promise.all([
        fetchAllAgentProfiles(pool),
        fetchWindowMetrics(pool, resolvedConfig.windowMinutes),
      ])

      const profileByAgent = new Map(profiles.map((profile) => [profile.agentUuid, profile]))
      const now = new Date()

      const entries = windowRows
        .map((row) => {
          const profile = profileByAgent.get(row.agentId)
          if (!profile) {
            return null
          }

          const windowMetrics = buildAgentWindowMetrics(row, null, now)
          return {
            agent: toAgentSummary(profile),
            failedBurns30m: windowMetrics.failedBurnsDelta30m,
            totalRequests30m: windowMetrics.totalRequestsDelta30m,
            failureRate30m: windowMetrics.failureRate30m,
            warning: `${windowMetrics.failedBurnsDelta30m} failed burns in last ${resolvedConfig.windowMinutes} minutes.`,
            windowMetrics,
          }
        })
        .filter((entry): entry is NonNullable<typeof entry> => entry !== null)

      const insufficientWindowData = entries.some((entry) => !entry.windowMetrics.windowDataAvailable) || entries.length === 0

      const filtered = entries
        .filter((entry) => entry.failedBurns30m >= resolvedConfig.avoidFailureThreshold)
        .sort((a, b) => {
          if (b.failedBurns30m !== a.failedBurns30m) {
            return b.failedBurns30m - a.failedBurns30m
          }
          return (b.failureRate30m ?? 0) - (a.failureRate30m ?? 0)
        })

      const firstWindow = filtered[0]?.windowMetrics ?? entries[0]?.windowMetrics

      return {
        windowMinutes: resolvedConfig.windowMinutes,
        threshold: resolvedConfig.avoidFailureThreshold,
        insufficientWindowData,
        windowStart: firstWindow?.windowStart ?? null,
        windowEnd: firstWindow?.windowEnd ?? null,
        dataFreshnessSeconds: firstWindow?.dataFreshnessSeconds ?? null,
        generatedAt: now.toISOString(),
        agents: filtered.map((entry) => ({
          agent: entry.agent,
          failedBurns30m: entry.failedBurns30m,
          totalRequests30m: entry.totalRequests30m,
          failureRate30m: entry.failureRate30m,
          warning: entry.warning,
        })),
      }
    },

    async compare(ids: string[]): Promise<IntelCompareResponse> {
      const validatedIds = validateCompareIds(ids)

      const [profiles, windowRows] = await Promise.all([
        fetchAgentProfilesByNvmAgentIds(pool, validatedIds),
        fetchWindowMetrics(pool, resolvedConfig.windowMinutes),
      ])

      ensureFoundProfiles(validatedIds, profiles)

      const windowByAgent = toWindowByAgent(windowRows)
      const now = new Date()

      const resultRows = profiles.map((profile) => {
        const windowMetrics = buildAgentWindowMetrics(windowByAgent.get(profile.agentUuid) ?? null, null, now)
        const consistency = computeConsistencyScore(profile, windowMetrics)
        const roiEstimate = computeRoiEstimate(profile)
        const lifetimeFailureRate = computeFailureRate(profile.failedBurns, profile.totalRequests)

        return {
          agent: toAgentSummary(profile),
          trustScore: profile.trustScore,
          consistencyScore: consistency,
          roiEstimate,
          lifetimeFailureRate,
          failedBurns30m: windowMetrics.failedBurnsDelta30m,
          failureRate30m: windowMetrics.failureRate30m,
          reviewCount: profile.trustReviewCount,
        }
      })

      const bestReliability = [...resultRows].sort((a, b) => a.lifetimeFailureRate - b.lifetimeFailureRate)[0]?.agent.nvmAgentId ?? null
      const bestRoi = [...resultRows]
        .filter((row) => row.roiEstimate.expectedCostPerSuccessUsd !== null)
        .sort((a, b) => (a.roiEstimate.expectedCostPerSuccessUsd ?? Number.POSITIVE_INFINITY) - (b.roiEstimate.expectedCostPerSuccessUsd ?? Number.POSITIVE_INFINITY))[0]
        ?.agent.nvmAgentId ?? null
      const bestConsistency = [...resultRows].sort((a, b) => b.consistencyScore.score - a.consistencyScore.score)[0]?.agent.nvmAgentId ?? null
      const lowestRecentFailures = [...resultRows].sort((a, b) => a.failedBurns30m - b.failedBurns30m)[0]?.agent.nvmAgentId ?? null

      return {
        generatedAt: now.toISOString(),
        agents: resultRows.sort((a, b) => validatedIds.indexOf(a.agent.nvmAgentId) - validatedIds.indexOf(b.agent.nvmAgentId)),
        summary: {
          bestReliability,
          bestRoi,
          bestConsistency,
          lowestRecentFailures,
        },
      }
    },

    async captureSnapshotNow(now?: Date): Promise<{ inserted: number; snapshotAt: Date }> {
      return captureIntelAgentStatsSnapshot(pool, now)
    },
  }
}

export function asIntelServiceError(error: unknown): IntelServiceError {
  if (error instanceof IntelServiceError) {
    return error
  }
  return new IntelServiceError(500, 'internal_error', error instanceof Error ? error.message : 'Unknown intel service failure.')
}

export function isIntelServiceError(error: unknown): error is IntelServiceError {
  return error instanceof IntelServiceError
}
