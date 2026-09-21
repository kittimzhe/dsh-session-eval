/**
 * Core types for retrospective session evaluation.
 *
 * The plugin projects raw session events into a small event vocabulary once
 * (see {@link adaptEvents}), then every metric, grade, and trend computation
 * is pure over plain data — no LLM judges, no network, no nondeterminism.
 *
 * @module dsh-session-eval/types
 */

/** Event kinds the evaluation layer reasons about. */
export type EvalEventKind = 'user' | 'assistant' | 'tool_call' | 'tool_result'

/** One projected session event. */
export interface EvalEvent {
  /** Raw-log sequence number of the source event. */
  readonly seq: number
  /** Event time in epoch milliseconds. */
  readonly time: number
  /** Projected kind. */
  readonly kind: EvalEventKind
  /** Tool name for `tool_call` / `tool_result` events. */
  readonly tool?: string
  /** Whether a `tool_result` reported an error. */
  readonly isError?: boolean
}

/** Deterministic per-session metrics. */
export interface SessionMetrics {
  readonly sessionId: string
  readonly events: number
  readonly userTurns: number
  readonly assistantMessages: number
  readonly toolCalls: number
  readonly toolErrors: number
  /** toolErrors / max(1, toolCalls). 0 when no tool calls. */
  readonly toolErrorRate: number
  /** Extra user messages inside consecutive-user runs (re-ask signals). */
  readonly corrections: number
  /** corrections per 10 user turns. */
  readonly correctionRate: number
  /** toolCalls / max(1, userTurns). */
  readonly toolLoad: number
  /** wall-clock span in ms (last.time - first.time); 0 for empty sessions. */
  readonly wallMs: number
  readonly firstTime: number | null
  readonly lastTime: number | null
}

/** Letter grade for one dimension. */
export type Grade = 'A' | 'B' | 'C' | 'D' | 'E'

/** One graded dimension. */
export interface DimensionGrade {
  readonly dimension: 'Reliability' | 'Re-ask' | 'Tool load'
  readonly grade: Grade | 'n/a'
  readonly detail: string
}

/** Deterministic grade card for one session. */
export interface GradeCard {
  readonly sessionId: string
  readonly dimensions: readonly DimensionGrade[]
  /** Worst non-n/a dimension grade; 'n/a' when all dimensions are n/a. */
  readonly overall: Grade | 'n/a'
  readonly notes: readonly string[]
}

/** Verdict for one dimension between two sessions. */
export interface DimensionDelta {
  readonly dimension: DimensionGrade['dimension']
  readonly before: string
  readonly after: string
  readonly verdict: 'improved' | 'regressed' | 'flat'
}

/** Cross-session regression report. */
export interface TrendReport {
  readonly before: SessionMetrics
  readonly after: SessionMetrics
  readonly deltas: readonly DimensionDelta[]
  readonly overall: 'improved' | 'regressed' | 'flat'
  readonly summary: string
}
