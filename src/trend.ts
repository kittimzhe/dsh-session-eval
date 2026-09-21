/**
 * Cross-session regression comparison with noise tolerance.
 *
 * @module dsh-session-eval/trend
 */
import type { DimensionDelta, SessionMetrics, TrendReport } from './types.ts'

/** Minimum absolute change treated as signal (not noise). */
const ERROR_RATE_EPSILON = 0.02
const REASK_EPSILON = 0.5
const TOOL_LOAD_EPSILON = 1

function verdict(before: number, after: number, eps: number, lowerIsBetter: boolean): 'improved' | 'regressed' | 'flat' {
  const delta = after - before
  if (Math.abs(delta) <= eps) return 'flat'
  const better = lowerIsBetter ? delta < 0 : delta > 0
  return better ? 'improved' : 'regressed'
}

/** Compare two sessions dimension by dimension. */
export function compareSessions(before: SessionMetrics, after: SessionMetrics): TrendReport {
  const deltas: DimensionDelta[] = []

  if (before.toolCalls > 0 || after.toolCalls > 0) {
    deltas.push({
      dimension: 'Reliability',
      before: `${(before.toolErrorRate * 100).toFixed(1)}%`,
      after: `${(after.toolErrorRate * 100).toFixed(1)}%`,
      verdict: verdict(before.toolErrorRate, after.toolErrorRate, ERROR_RATE_EPSILON, true),
    })
  }
  if (before.userTurns > 0 || after.userTurns > 0) {
    deltas.push({
      dimension: 'Re-ask',
      before: before.correctionRate.toFixed(1),
      after: after.correctionRate.toFixed(1),
      verdict: verdict(before.correctionRate, after.correctionRate, REASK_EPSILON, true),
    })
  }
  if (before.toolCalls > 0 || after.toolCalls > 0) {
    deltas.push({
      dimension: 'Tool load',
      before: before.toolLoad.toFixed(1),
      after: after.toolLoad.toFixed(1),
      verdict: verdict(before.toolLoad, after.toolLoad, TOOL_LOAD_EPSILON, false),
    })
  }

  const improved = deltas.filter((d) => d.verdict === 'improved').length
  const regressed = deltas.filter((d) => d.verdict === 'regressed').length
  const overall = regressed > improved ? 'regressed' : improved > regressed ? 'improved' : 'flat'
  const summary =
    deltas.length === 0
      ? 'No comparable dimensions — both sessions lack tool or turn activity.'
      : `${improved} improved, ${regressed} regressed, ${deltas.length - improved - regressed} flat.`

  return { before, after, deltas, overall, summary }
}
