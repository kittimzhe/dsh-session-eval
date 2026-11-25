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

/**
 * Format one dimension's numeric change (from {@link DimensionDelta.change})
 * as a signed human-readable string — percentage points for Reliability, raw
 * metric units for the rest. Zero rounds to `±0.0` instead of a fake sign.
 */
export function formatDimensionChange(dimension: DimensionDelta['dimension'], change: number): string {
  const magnitude = dimension === 'Reliability' ? Math.abs(change) * 100 : Math.abs(change)
  const unit = dimension === 'Reliability' ? 'pp' : ''
  const rounded = Number(magnitude.toFixed(1))
  const sign = rounded === 0 ? '±' : change > 0 ? '+' : '-'
  return `${sign}${magnitude.toFixed(1)}${unit}`
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
      change: after.toolErrorRate - before.toolErrorRate,
    })
  }
  if (before.userTurns > 0 || after.userTurns > 0) {
    deltas.push({
      dimension: 'Re-ask',
      before: before.correctionRate.toFixed(1),
      after: after.correctionRate.toFixed(1),
      verdict: verdict(before.correctionRate, after.correctionRate, REASK_EPSILON, true),
      change: after.correctionRate - before.correctionRate,
    })
  }
  if (before.toolCalls > 0 || after.toolCalls > 0) {
    deltas.push({
      dimension: 'Tool load',
      before: before.toolLoad.toFixed(1),
      after: after.toolLoad.toFixed(1),
      verdict: verdict(before.toolLoad, after.toolLoad, TOOL_LOAD_EPSILON, false),
      change: after.toolLoad - before.toolLoad,
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
