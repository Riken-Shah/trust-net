import assert from 'node:assert/strict'
import test from 'node:test'

import { buildFailureJudgment, sanitizeJudgmentOutput } from '../judge.js'

test('sanitizeJudgmentOutput clamps scores and normalizes verdict', () => {
  const result = sanitizeJudgmentOutput({
    overall_score: 12,
    score_accuracy: 0,
    score_speed: '9.7',
    score_value: 'nan',
    score_reliability: 6,
    verdict: 'PASS',
    rationale: 'Good output',
  })

  assert.equal(result.overallScore, 10)
  assert.equal(result.scoreAccuracy, 1)
  assert.equal(result.scoreSpeed, 10)
  assert.equal(result.scoreValue, 10)
  assert.equal(result.verdict, 'pass')
})

test('buildFailureJudgment returns fail-closed score payload', () => {
  const result = buildFailureJudgment('failed to score')
  assert.equal(result.verdict, 'fail')
  assert.equal(result.overallScore, 1)
  assert.match(result.rationale, /failed/i)
})
