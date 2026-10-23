/**
 * Deterministic grading: fixed, documented thresholds — no LLM judges.
 *
 * @module dsh-session-eval/grade
 */
import type { DimensionGrade, Grade, GradeCard, SessionMetrics } from './types.ts'

/**
 * Grade bands per dimension, overridable from the plugin config (#1).
 * Each array holds the A/B/C/D upper bounds in ascending order; anything
 * above the D bound grades E. Reliability bounds are error-rate fractions,
 * re-ask bounds are corrections per 10 user turns, tool-load bounds are
 * calls per turn as [lowC, lowB, highC, highD].
 */
export interface GradeBands {
  readonly reliability: readonly [number, number, number, number]
  readonly reask: readonly [number, number, number, number]
  readonly toolLoad: readonly [number, number, number, number]
}

/** The documented defaults; unchanged when no config is given. */
export const DEFAULT_GRADE_BANDS: GradeBands = {
  reliability: [0.05, 0.10, 0.20, 0.35],
  reask: [0, 1, 2, 4],
  toolLoad: [0.1, 0.5, 8, 20],
}

function gradeBy(rate: number, bands: readonly number[]): Grade {
  const grades: readonly Grade[] = ['A', 'B', 'C', 'D']
  for (let i = 0; i < bands.length; i++) if (rate <= bands[i]!) return grades[i]!
  return 'E'
}

const ORDER: readonly Grade[] = ['A', 'B', 'C', 'D', 'E']

function worst(a: Grade, b: Grade): Grade {
  return ORDER.indexOf(a) >= ORDER.indexOf(b) ? a : b
}

function pct(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`
}

/**
 * Grade one session deterministically. `bands` may override any subset of
 * the dimensions; unspecified ones keep the documented defaults.
 */
export function gradeSession(m: SessionMetrics, bands: Partial<GradeBands> = {}): GradeCard {
  const b: GradeBands = { ...DEFAULT_GRADE_BANDS, ...bands }
  const dimensions: DimensionGrade[] = []
  const notes: string[] = []

  if (m.toolCalls === 0) {
    dimensions.push({ dimension: 'Reliability', grade: 'n/a', detail: 'no tool calls' })
    notes.push('Reliability is n/a — the session made no tool calls.')
  } else {
    const grade = gradeBy(m.toolErrorRate, b.reliability)
    dimensions.push({
      dimension: 'Reliability',
      grade,
      detail: `${m.toolErrors}/${m.toolCalls} tool results errored (${pct(m.toolErrorRate)})`,
    })
  }

  if (m.userTurns === 0) {
    dimensions.push({ dimension: 'Re-ask', grade: 'n/a', detail: 'no user turns' })
  } else {
    const grade = gradeBy(m.correctionRate, b.reask)
    dimensions.push({
      dimension: 'Re-ask',
      grade,
      detail: `${m.corrections} re-ask signal(s) over ${m.userTurns} turns (${m.correctionRate.toFixed(1)}/10 turns)`,
    })
  }

  if (m.userTurns === 0 || m.toolCalls === 0) {
    dimensions.push({ dimension: 'Tool load', grade: 'n/a', detail: 'no tool activity' })
  } else {
    const [lowC, lowB, highC, highD] = b.toolLoad
    let grade: Grade = 'A'
    if (m.toolLoad < lowB) {
      grade = m.toolLoad < lowC ? 'C' : 'B'
    }
    if (m.toolLoad > highC) {
      grade = worst(grade, m.toolLoad > highD ? 'D' : 'C')
    }
    dimensions.push({ dimension: 'Tool load', grade, detail: `${m.toolLoad.toFixed(1)} tool calls per turn` })
  }

  if (m.events === 0) notes.push('Session is empty — all dimensions are provisional.')
  if (m.wallMs > 0 && m.userTurns > 0) {
    notes.push(`Wall time ${(m.wallMs / 60_000).toFixed(1)} min over ${m.userTurns} turns.`)
  }

  const graded = dimensions.filter((d): d is DimensionGrade & { grade: Grade } => d.grade !== 'n/a')
  const overall = graded.length === 0 ? 'n/a' : graded.reduce<Grade>((acc, d) => worst(acc, d.grade), 'A')

  return { sessionId: m.sessionId, dimensions, overall, notes }
}
