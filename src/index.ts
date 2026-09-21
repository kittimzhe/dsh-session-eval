/**
 * dsh-session-eval — retrospective agent-session evaluation for DeepSeek Harness.
 *
 * The third layer of the session toolchain: dsh-session-export is the
 * evidence layer, dsh-session-recall is the memory layer, and this plugin is
 * the measurement layer. It grades sessions that already happened —
 * deterministic metrics over persisted logs (fixed thresholds, no LLM
 * judges), cross-session regression diffs, and answerable questions like
 * "did my agent get better or worse after that plugin/prompt change?"
 *
 * Commands (via ctx.commands):
 * - `/eval`   — grade card for the current session (or another via --id)
 * - `/eval-diff <beforeId> <afterId>` — regression comparison of two sessions
 *
 * Both read through the trusted ctx.sessionQuery seam, so any persistence
 * backend (JSONL or SQLite) works without touching raw artifacts.
 */
import type { Context } from '@deepseek-ai/cordis'
import { executeEval, executeEvalDiff, EVAL_USAGE, EVAL_DIFF_USAGE } from './evalCommand.ts'

export const name = 'session-eval'
export const inject = ['commands', 'sessionQuery']

export { computeMetrics, adaptEvents } from './metrics.ts'
export { gradeSession } from './grade.ts'
export { compareSessions } from './trend.ts'
export { parseEvalArgs, parseEvalDiffArgs, executeEval, executeEvalDiff, renderCard, renderTrend, id8, EVAL_USAGE, EVAL_DIFF_USAGE } from './evalCommand.ts'
export type { EvalArgs, EvalDiffArgs } from './evalCommand.ts'
export type { EvalEvent, EvalEventKind, SessionMetrics, Grade, DimensionGrade, GradeCard, DimensionDelta, TrendReport } from './types.ts'

/** Plugin entry: mount the /eval and /eval-diff commands. */
export function apply(ctx: Context): void {
  ctx.effect(
    function* () {
      yield ctx.commands.register({
        name: 'eval',
        description: 'Print a deterministic grade card for this session (or another via --id): reliability, re-ask, tool load',
        handler: (invocation) => executeEval(ctx, invocation),
      })
      yield ctx.commands.register({
        name: 'eval-diff',
        description: 'Compare two sessions (before, after) and report which dimensions improved or regressed',
        handler: (invocation) => executeEvalDiff(ctx, invocation),
      })
    },
    'session-eval lifecycle',
  )
}
