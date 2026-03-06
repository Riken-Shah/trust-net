import {
  type BuyerAgentConfig,
  type JudgmentContext,
  type JudgmentResult,
} from './types.js'
import { callOpenAiJson } from './openai.js'

interface RawJudgmentOutput {
  overall_score?: unknown
  score_accuracy?: unknown
  score_speed?: unknown
  score_value?: unknown
  score_reliability?: unknown
  verdict?: unknown
  rationale?: unknown
}

function clampScore(value: number): number {
  if (value < 1) {
    return 1
  }
  if (value > 10) {
    return 10
  }
  return Math.round(value)
}

function toScore(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return clampScore(value)
  }

  if (typeof value === 'string') {
    const parsed = Number.parseFloat(value)
    if (Number.isFinite(parsed)) {
      return clampScore(parsed)
    }
  }

  return fallback
}

function toVerdict(rawVerdict: unknown, overallScore: number): 'pass' | 'fail' {
  if (rawVerdict === 'pass' || rawVerdict === 'fail') {
    return rawVerdict
  }

  return overallScore >= 6 ? 'pass' : 'fail'
}

function toRationale(value: unknown, fallback: string): string {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (trimmed) {
      return trimmed.slice(0, 1000)
    }
  }

  return fallback
}

function sanitizeJudgmentOutput(raw: RawJudgmentOutput): JudgmentResult {
  const overallScore = toScore(raw.overall_score, 1)
  const scoreAccuracy = toScore(raw.score_accuracy, overallScore)
  const scoreSpeed = toScore(raw.score_speed, overallScore)
  const scoreValue = toScore(raw.score_value, overallScore)
  const scoreReliability = toScore(raw.score_reliability, overallScore)
  const verdict = toVerdict(raw.verdict, overallScore)

  return {
    overallScore,
    scoreAccuracy,
    scoreSpeed,
    scoreValue,
    scoreReliability,
    verdict,
    rationale: toRationale(raw.rationale, 'No rationale returned by LLM judge.'),
  }
}

function buildFailureJudgment(reason: string): JudgmentResult {
  return {
    overallScore: 1,
    scoreAccuracy: 1,
    scoreSpeed: 1,
    scoreValue: 1,
    scoreReliability: 1,
    verdict: 'fail',
    rationale: reason.slice(0, 1000),
  }
}

function buildPrompt(context: JudgmentContext): string {
  return JSON.stringify(
    {
      instructions: [
        'Score this paid AI service result from 1-10.',
        'Output strict JSON with keys: overall_score, score_accuracy, score_speed, score_value, score_reliability, verdict, rationale.',
        "verdict must be exactly 'pass' or 'fail'.",
      ],
      service: {
        name: context.service.displayName,
        normalized: context.service.normalized,
      },
      protocol: context.protocol,
      seller: {
        marketplace_id: context.seller.marketplaceId,
        name: context.seller.name,
      },
      purchase: {
        success: context.purchase.purchaseSuccess,
        error: context.purchase.error,
        http_status: context.purchase.httpStatus,
        latency_ms: context.purchase.latencyMs,
        response_excerpt: context.purchase.responseExcerpt,
        credits_redeemed: context.purchase.creditsRedeemed,
        remaining_balance: context.purchase.remainingBalance,
      },
    },
    null,
    2,
  )
}

export async function scoreServiceResult(
  config: BuyerAgentConfig,
  context: JudgmentContext,
): Promise<JudgmentResult> {
  if (!context.purchase.purchaseSuccess) {
    return buildFailureJudgment(
      `Service purchase failed before evaluation: ${context.purchase.error ?? 'unknown_purchase_failure'}`,
    )
  }

  try {
    const prompt = buildPrompt(context)
    const rawOutput = await callOpenAiJson(
      config.openAiApiKey,
      config.model,
      'You are a strict reviewer. Return valid JSON only. Be conservative on quality scoring.',
      prompt,
      config.timeoutMs,
    )
    return sanitizeJudgmentOutput(rawOutput)
  } catch (error) {
    return buildFailureJudgment(
      `LLM scoring failed: ${error instanceof Error ? error.message : 'unknown_scoring_error'}`,
    )
  }
}

export { sanitizeJudgmentOutput, buildFailureJudgment }
