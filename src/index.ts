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
 * - `/eval-history [N]` — grade the last N sessions in this workspace and show the trend
 * - `/eval-baseline set|compare|list|clear` — persist grade baselines per
 *   workspace (`<cwd>/.dsh-evals/baseline.jsonl`) and compare later sessions
 *   against them
 *
 * All output is stamped with guardrails: `/eval --json` carries the session
 * format version from the session header, and a non-empty log that projects
 * to zero events warns that the session format may have drifted.
 *
 * Both read through the trusted ctx.sessionQuery seam, so any persistence
 * backend (JSONL or SQLite) works without touching raw artifacts.
 */
import type { Context } from '@deepseek-ai/cordis'
import { executeEval, executeEvalDiff, EVAL_USAGE, EVAL_DIFF_USAGE } from './evalCommand.ts'
import { executeEvalHistory, EVAL_HISTORY_USAGE } from './historyCommand.ts'
import { executeEvalBaseline, EVAL_BASELINE_USAGE } from './baselineCommand.ts'
import { parseGradeBands } from './config.ts'

export const name = 'session-eval'
export const inject = ['commands', 'sessionQuery']

export { computeMetrics, adaptEvents, zeroProjectionNote } from './metrics.ts'
export { gradeSession } from './grade.ts'
export { compareSessions, formatDimensionChange } from './trend.ts'
export { resolveBaselinePath, bandsFingerprint, effectiveBands, buildBaselineRecord, appendBaselineRecord, loadBaselineRecords, latestBaseline, nodeBaselineIo, BASELINE_DIR, BASELINE_FILE } from './baseline.ts'
export type { BaselineRecord, BaselineLoad, BaselineIo } from './baseline.ts'
export { parseEvalArgs, parseEvalDiffArgs, executeEval, executeEvalDiff, renderCard, renderTrend, id8, readFormatVersion, EVAL_USAGE, EVAL_DIFF_USAGE } from './evalCommand.ts'
export { parseEvalHistoryArgs, executeEvalHistory, renderHistory, EVAL_HISTORY_USAGE } from './historyCommand.ts'
export { parseEvalBaselineArgs, executeEvalBaseline, EVAL_BASELINE_USAGE } from './baselineCommand.ts'
export type { EvalArgs, EvalDiffArgs } from './evalCommand.ts'
export type { EvalHistoryArgs, HistoryEntry, HistoryReport, HistorySeam } from './historyCommand.ts'
export type { EvalBaselineArgs, BaselineSeam } from './baselineCommand.ts'
export type { EvalEvent, EvalEventKind, SessionMetrics, Grade, DimensionGrade, GradeCard, DimensionDelta, TrendReport } from './types.ts'
export { VERSION } from './version.ts'

/**
 * Plugin entry: mount the /eval, /eval-diff, /eval-history and /eval-baseline
 * commands.
 *
 * `config` is the plugin's node in the host config tree (per-profile): its
 * `gradeBands` block overrides the default grade thresholds — see config.ts.
 * Invalid config fails fast here, at plugin load, rather than mid-grade.
 * The effective bands also feed the baseline fingerprint, so a config change
 * makes `/eval-baseline compare` warn about crossing band sets.
 */
export function apply(ctx: Context, config?: unknown): void {
  const bands = parseGradeBands(config)
  ctx.effect(
    function* () {
      yield ctx.commands.register({
        name: 'eval',
        description: 'Print a deterministic grade card for this session (or another via --id): reliability, re-ask, tool load',
        handler: (invocation) => executeEval(ctx, invocation, undefined, bands),
      })
      yield ctx.commands.register({
        name: 'eval-diff',
        description: 'Compare two sessions (before, after) and report which dimensions improved or regressed',
        handler: (invocation) => executeEvalDiff(ctx, invocation),
      })
      yield ctx.commands.register({
        name: 'eval-history',
        description: 'Grade the last N sessions in this workspace (default 5) and show whether the trend is improving',
        handler: (invocation) => executeEvalHistory(ctx, invocation, undefined, bands),
      })
      yield ctx.commands.register({
        name: 'eval-baseline',
        description: 'Save a grade baseline for this workspace (set), compare against it (compare), list records (list), or clear the store (clear)',
        handler: (invocation) => executeEvalBaseline(ctx, invocation, undefined, bands),
      })
    },
    'session-eval lifecycle',
  )
}
