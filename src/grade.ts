/**
 * Deterministic grading: fixed, documented thresholds — no LLM judges.
 *
 * @module dsh-session-eval/grade
 */
import type { DimensionGrade, Grade, GradeCard, SessionMetrics } from './types.ts'

/** Reliability thresholds on tool error rate (fraction). */
const RELIABILITY: readonly [grade: Grade, max: number][] = [
  ['A', 0.05],
  ['B', 0.10],
  ['C', 0.20],
  ['D', 0.35],
]

/** Re-ask thresholds: corrections per 10 user turns. */
const REASK: readonly [grade: Grade, max: number][] = [
  ['A', 0],
  ['B', 1],
  ['C', 2],
  ['D', 4],
]

/** Tool-load thresholds: tool calls per user turn (both churn extremes graded). */
const TOOL_LOAD_LOW_B = 0.5
const TOOL_LOAD_LOW_C = 0.1
const TOOL_LOAD_HIGH_C = 8
const TOOL_LOAD_HIGH_D = 20

function gradeBy(rate: number, table: readonly [Grade, number][]): Grade {
  for (const [grade, max] of table) if (rate <= max) return grade
  return 'E'
}

const ORDER: readonly Grade[] = ['A', 'B', 'C', 'D', 'E']

function worst(a: Grade, b: Grade): Grade {
  return ORDER.indexOf(a) >= ORDER.indexOf(b) ? a : b
}

function pct(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`
}

/** Grade one session deterministically. */
export function gradeSession(m: SessionMetrics): GradeCard {
  const dimensions: DimensionGrade[] = []
  const notes: string[] = []

  if (m.toolCalls === 0) {
    dimensions.push({ dimension: 'Reliability', grade: 'n/a', detail: 'no tool calls' })
    notes.push('Reliability is n/a — the session made no tool calls.')
  } else {
    const grade = gradeBy(m.toolErrorRate, RELIABILITY)
    dimensions.push({
      dimension: 'Reliability',
      grade,
      detail: `${m.toolErrors}/${m.toolCalls} tool results errored (${pct(m.toolErrorRate)})`,
    })
  }

  if (m.userTurns === 0) {
    dimensions.push({ dimension: 'Re-ask', grade: 'n/a', detail: 'no user turns' })
  } else {
    const grade = gradeBy(m.correctionRate, REASK)
    dimensions.push({
      dimension: 'Re-ask',
      grade,
      detail: `${m.corrections} re-ask signal(s) over ${m.userTurns} turns (${m.correctionRate.toFixed(1)}/10 turns)`,
    })
  }

  if (m.userTurns === 0 || m.toolCalls === 0) {
    dimensions.push({ dimension: 'Tool load', grade: 'n/a', detail: 'no tool activity' })
  } else {
    let grade: Grade = 'A'
    if (m.toolLoad < TOOL_LOAD_LOW_B) {
      grade = m.toolLoad < TOOL_LOAD_LOW_C ? 'C' : 'B'
    }
    if (m.toolLoad > TOOL_LOAD_HIGH_C) {
      grade = worst(grade, m.toolLoad > TOOL_LOAD_HIGH_D ? 'D' : 'C')
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
