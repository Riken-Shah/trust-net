import {
  type ConsistencyScore,
  type FailureWarning,
  type IntelAgentProfileRow,
  type IntelAgentWindowMetrics,
  type RoiEstimate,
} from './types.js'

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function round(value: number, digits = 4): number {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

export function safeRatio(numerator: number, denominator: number): number {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) {
    return 0
  }
  return numerator / denominator
}

export function computeFailureRate(failedBurns: number, totalRequests: number): number {
  return round(clamp(safeRatio(failedBurns, totalRequests), 0, 1), 6)
}

export function computeRoiEstimate(profile: IntelAgentProfileRow): RoiEstimate {
  if (profile.minPlanPriceUsd === null || profile.minPlanPriceUsd <= 0) {
    return {
      expectedCostPerSuccessUsd: null,
      minPlanPriceUsd: null,
      sourcePlanId: profile.minPlanId,
      unavailableReason: profile.roiUnavailableReason ?? 'no_supported_usd_plan',
    }
  }

  const observedReliability = profile.totalRequests > 0
    ? safeRatio(profile.successfulBurns, profile.totalRequests)
    : profile.trustReliability ?? 0

  const boundedReliability = clamp(observedReliability, 0.05, 1)
  const expectedCostPerSuccessUsd = round(profile.minPlanPriceUsd / boundedReliability, 6)

  return {
    expectedCostPerSuccessUsd,
    minPlanPriceUsd: round(profile.minPlanPriceUsd, 6),
    sourcePlanId: profile.minPlanId,
    unavailableReason: null,
  }
}

export function computeRoiScore(roi: RoiEstimate): number {
  if (roi.expectedCostPerSuccessUsd === null || roi.expectedCostPerSuccessUsd <= 0) {
    return 0
  }
  const score = 1 / roi.expectedCostPerSuccessUsd
  return clamp(score, 0, 1)
}

function normalizedText(text: string | null): string {
  return (text ?? '').trim().toLowerCase()
}

export function computeTextRelevance(profile: IntelAgentProfileRow, query: string): number {
  const q = query.trim().toLowerCase()
  if (q.length === 0) {
    return 0
  }

  const name = normalizedText(profile.name)
  const description = normalizedText(profile.description)
  const category = normalizedText(profile.category)
  const keywords = profile.keywords.map((keyword) => keyword.toLowerCase())
  const services = normalizedText(profile.servicesText)
  const plans = normalizedText(profile.planNamesText)

  let score = 0

  if (name === q) {
    score += 1
  } else if (name.startsWith(q)) {
    score += 0.85
  } else if (name.includes(q)) {
    score += 0.75
  }

  if (description.includes(q)) {
    score += 0.35
  }

  if (category.includes(q)) {
    score += 0.25
  }

  if (services.includes(q)) {
    score += 0.25
  }

  if (plans.includes(q)) {
    score += 0.15
  }

  if (keywords.some((keyword) => keyword.includes(q))) {
    score += 0.35
  }

  return round(clamp(score, 0, 1), 6)
}

export function computeConsistencyScore(
  profile: IntelAgentProfileRow,
  window: IntelAgentWindowMetrics | null,
): ConsistencyScore {
  const reliability = profile.totalRequests > 0
    ? clamp(safeRatio(profile.successfulBurns, profile.totalRequests), 0, 1)
    : clamp(profile.trustReliability ?? 0, 0, 1)

  const currentWindowFailureRate = window?.failureRate30m ?? null
  const previousWindowFailureRate = window?.previousFailureRate30m ?? null

  let volatilityComponent = 0.8
  let sampleWindows = 0

  if (currentWindowFailureRate !== null && currentWindowFailureRate !== undefined) {
    sampleWindows += 1
  }
  if (previousWindowFailureRate !== null && previousWindowFailureRate !== undefined) {
    sampleWindows += 1
  }

  if (sampleWindows >= 2 && currentWindowFailureRate !== null && previousWindowFailureRate !== null) {
    const delta = Math.abs(currentWindowFailureRate - previousWindowFailureRate)
    volatilityComponent = clamp(1 - delta, 0, 1)
  }

  const score = clamp((0.7 * reliability + 0.3 * volatilityComponent) * 100, 0, 100)
  const confidence = sampleWindows >= 2 ? 1 : sampleWindows === 1 ? 0.7 : 0.4

  return {
    score: round(score, 2),
    reliabilityComponent: round(reliability, 6),
    volatilityComponent: round(volatilityComponent, 6),
    confidence,
    sampleWindows,
  }
}

export function computeRankScore(params: {
  textRelevance: number
  roiScore: number
  trustScore: number | null
  consistencyScore: number
}): number {
  const trustScoreNorm = clamp((params.trustScore ?? 0) / 100, 0, 1)
  const consistencyNorm = clamp(params.consistencyScore / 100, 0, 1)

  return round(
    clamp(
      0.45 * params.textRelevance +
        0.2 * params.roiScore +
        0.2 * trustScoreNorm +
        0.15 * consistencyNorm,
      0,
      1,
    ),
    6,
  )
}

export function computeConfidence(params: {
  textRelevance: number
  profile: IntelAgentProfileRow
  roiEstimate: RoiEstimate
}): number {
  const hasTrust = params.profile.trustScore !== null ? 1 : 0
  const hasReviews = params.profile.trustReviewCount > 0 ? 1 : 0
  const hasPricing = params.roiEstimate.expectedCostPerSuccessUsd !== null ? 1 : 0
  const dataCompleteness = (hasTrust + hasReviews + hasPricing) / 3

  const sampleStrengthRaw = Math.log10(params.profile.totalRequests + params.profile.totalOrders + 1) / 3
  const sampleStrength = clamp(sampleStrengthRaw, 0, 1)

  return round(
    clamp(
      0.5 * params.textRelevance + 0.3 * dataCompleteness + 0.2 * sampleStrength,
      0,
      1,
    ),
    6,
  )
}

export function computeFailureWarnings(
  profile: IntelAgentProfileRow,
  window: IntelAgentWindowMetrics | null,
): FailureWarning[] {
  const warnings: FailureWarning[] = []
  const lifetimeFailureRate = computeFailureRate(profile.failedBurns, profile.totalRequests)

  if (window?.windowDataAvailable && window.failedBurnsDelta30m >= 3) {
    warnings.push({
      code: 'recent_failed_burns',
      message: `${window.failedBurnsDelta30m} failed burns observed in last 30 minutes.`,
      severity: 'high',
    })
  }

  if (
    window?.windowDataAvailable &&
    window.failureRate30m !== null &&
    window.totalRequestsDelta30m >= 5 &&
    window.failureRate30m >= 0.2
  ) {
    warnings.push({
      code: 'recent_failure_rate',
      message: `Recent failure rate is ${(window.failureRate30m * 100).toFixed(1)}%.`,
      severity: 'medium',
    })
  }

  if (profile.totalRequests >= 20 && lifetimeFailureRate >= 0.2) {
    warnings.push({
      code: 'lifetime_reliability_risk',
      message: `Lifetime failure rate is ${(lifetimeFailureRate * 100).toFixed(1)}%.`,
      severity: 'medium',
    })
  }

  return warnings
}

function noteForDimension(label: string, value: number | null): string | null {
  if (value === null) {
    return null
  }
  if (value >= 8) {
    return `${label} is strong (${value.toFixed(1)}/10).`
  }
  if (value >= 6) {
    return `${label} is acceptable (${value.toFixed(1)}/10).`
  }
  return `${label} needs improvement (${value.toFixed(1)}/10).`
}

export function buildOutputQualityNotes(profile: IntelAgentProfileRow, recentComments: string[]): string[] {
  const notes: string[] = []

  if (profile.trustReviewCount === 0) {
    notes.push('No verified review data yet.')
    return notes
  }

  if (profile.avgReviewScore !== null) {
    notes.push(`Overall review score is ${profile.avgReviewScore.toFixed(1)}/10 across ${profile.trustReviewCount} reviews.`)
  }

  const accuracy = noteForDimension('Accuracy', profile.avgScoreAccuracy)
  if (accuracy) {
    notes.push(accuracy)
  }

  const speed = noteForDimension('Speed', profile.avgScoreSpeed)
  if (speed) {
    notes.push(speed)
  }

  const value = noteForDimension('Value', profile.avgScoreValue)
  if (value) {
    notes.push(value)
  }

  const reliability = noteForDimension('Reliability', profile.avgScoreReliability)
  if (reliability) {
    notes.push(reliability)
  }

  for (const comment of recentComments.slice(0, 2)) {
    notes.push(`Recent feedback: "${comment}"`)
  }

  return notes
}

export function selectFailureTrend(
  currentFailureRate30m: number | null,
  previousFailureRate30m: number | null,
): 'improving' | 'stable' | 'worsening' | 'unknown' {
  if (currentFailureRate30m === null || previousFailureRate30m === null) {
    return 'unknown'
  }

  const delta = currentFailureRate30m - previousFailureRate30m
  if (delta <= -0.05) {
    return 'improving'
  }
  if (delta >= 0.05) {
    return 'worsening'
  }
  return 'stable'
}
