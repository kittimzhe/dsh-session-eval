import { SessionId } from "@deepseek-ai/dsh-session";
import { Context } from "@deepseek-ai/cordis";
import { CommandInvocation, CommandResult } from "@deepseek-ai/dsh-commands";
//#region src/types.d.ts
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
type EvalEventKind = 'user' | 'assistant' | 'tool_call' | 'tool_result';
/** One projected session event. */
interface EvalEvent {
  /** Raw-log sequence number of the source event. */
  readonly seq: number;
  /** Event time in epoch milliseconds. */
  readonly time: number;
  /** Projected kind. */
  readonly kind: EvalEventKind;
  /** Tool name for `tool_call` / `tool_result` events. */
  readonly tool?: string;
  /** Whether a `tool_result` reported an error. */
  readonly isError?: boolean;
}
/** Deterministic per-session metrics. */
interface SessionMetrics {
  readonly sessionId: string;
  readonly events: number;
  readonly userTurns: number;
  readonly assistantMessages: number;
  readonly toolCalls: number;
  readonly toolErrors: number;
  /** toolErrors / max(1, toolCalls). 0 when no tool calls. */
  readonly toolErrorRate: number;
  /** Extra user messages inside consecutive-user runs (re-ask signals). */
  readonly corrections: number;
  /** corrections per 10 user turns. */
  readonly correctionRate: number;
  /** toolCalls / max(1, userTurns). */
  readonly toolLoad: number;
  /** wall-clock span in ms (last.time - first.time); 0 for empty sessions. */
  readonly wallMs: number;
  readonly firstTime: number | null;
  readonly lastTime: number | null;
}
/** Letter grade for one dimension. */
type Grade = 'A' | 'B' | 'C' | 'D' | 'E';
/** One graded dimension. */
interface DimensionGrade {
  readonly dimension: 'Reliability' | 'Re-ask' | 'Tool load';
  readonly grade: Grade | 'n/a';
  readonly detail: string;
}
/** Deterministic grade card for one session. */
interface GradeCard {
  readonly sessionId: string;
  readonly dimensions: readonly DimensionGrade[];
  /** Worst non-n/a dimension grade; 'n/a' when all dimensions are n/a. */
  readonly overall: Grade | 'n/a';
  readonly notes: readonly string[];
}
/** Verdict for one dimension between two sessions. */
interface DimensionDelta {
  readonly dimension: DimensionGrade['dimension'];
  readonly before: string;
  readonly after: string;
  readonly verdict: 'improved' | 'regressed' | 'flat';
}
/** Cross-session regression report. */
interface TrendReport {
  readonly before: SessionMetrics;
  readonly after: SessionMetrics;
  readonly deltas: readonly DimensionDelta[];
  readonly overall: 'improved' | 'regressed' | 'flat';
  readonly summary: string;
}
//#endregion
//#region src/metrics.d.ts
/** Compute the deterministic metric set for one session. */
declare function computeMetrics(sessionId: string, events: readonly EvalEvent[]): SessionMetrics;
/**
 * Project raw session-log events into the evaluation vocabulary.
 *
 * Defensive by design: the adapter matches the `user/message`,
 * `assistant/message`, `tool/call`, `tool/result` event-type vocabulary
 * (plus role-based fallbacks) and never throws — unknown shapes are skipped.
 */
declare function adaptEvents(raw: readonly unknown[]): EvalEvent[];
//#endregion
//#region src/grade.d.ts
/** Grade one session deterministically. */
declare function gradeSession(m: SessionMetrics): GradeCard;
//#endregion
//#region src/trend.d.ts
/** Compare two sessions dimension by dimension. */
declare function compareSessions(before: SessionMetrics, after: SessionMetrics): TrendReport;
//#endregion
//#region src/evalCommand.d.ts
declare const EVAL_USAGE = "Usage: /eval [--id <sessionId>] [--json]";
declare const EVAL_DIFF_USAGE = "Usage: /eval-diff <beforeSessionId> <afterSessionId> [--json]";
declare function id8(sessionId: string): string;
/** Args for /eval. */
interface EvalArgs {
  readonly sessionId?: string;
  readonly json?: boolean;
}
/** Args for /eval-diff. */
interface EvalDiffArgs {
  readonly beforeId: string;
  readonly afterId: string;
  readonly json?: boolean;
}
/** Parse /eval input; returns args or a usage-error string. */
declare function parseEvalArgs(rawInput: string): EvalArgs | string;
/** Parse /eval-diff input; returns args or a usage-error string. */
declare function parseEvalDiffArgs(rawInput: string): EvalDiffArgs | string;
/** Render a grade card as terminal text. */
declare function renderCard(card: GradeCard, generator: string): string;
/** Render a trend report as terminal text. */
declare function renderTrend(report: TrendReport, generator: string): string;
interface QuerySeam {
  readSession(id: ReturnType<typeof SessionId>): Promise<{
    events: readonly unknown[];
  }>;
}
/** Execute /eval against the session-query seam. */
declare function executeEval(ctx: Context, invocation: CommandInvocation, seam?: QuerySeam): Promise<CommandResult>;
/** Execute /eval-diff against the session-query seam. */
declare function executeEvalDiff(ctx: Context, invocation: CommandInvocation, seam?: QuerySeam): Promise<CommandResult>;
//#endregion
//#region src/historyCommand.d.ts
declare const EVAL_HISTORY_USAGE = "Usage: /eval-history [N] [--json]  (N = last N sessions, 1-20, default 5)";
/** Args for /eval-history. */
interface EvalHistoryArgs {
  readonly count: number;
  readonly json: boolean;
}
/** Parse /eval-history input; returns args or a usage-error string. */
declare function parseEvalHistoryArgs(rawInput: string): EvalHistoryArgs | string;
/** One graded session in a history report. */
interface HistoryEntry {
  readonly sessionId: string;
  readonly createdAt: number | null;
  readonly metrics: SessionMetrics;
  readonly card: GradeCard;
}
/** The full /eval-history report. */
interface HistoryReport {
  readonly entries: readonly HistoryEntry[];
  readonly trend: TrendReport | null;
}
/** The slice of sessionQuery this command consumes (structural, for testability). */
interface HistorySeam {
  listSessions(): Promise<ReadonlyArray<{
    header: {
      id: unknown;
      createdAt: unknown;
      cwd?: unknown;
    };
  }>>;
  readSession(id: ReturnType<typeof SessionId>): Promise<{
    events: readonly unknown[];
  }>;
}
/** Render a history report as terminal text. */
declare function renderHistory(report: HistoryReport): string;
/** Execute /eval-history against the session-query seam. */
declare function executeEvalHistory(ctx: Context, invocation: CommandInvocation, seam?: HistorySeam): Promise<CommandResult>;
//#endregion
//#region src/version.d.ts
/**
 * Single source of truth for the plugin version string.
 *
 * @module dsh-session-eval/version
 */
declare const VERSION = "0.2.3";
//#endregion
//#region src/index.d.ts
declare const name = "session-eval";
declare const inject: string[];
/** Plugin entry: mount the /eval, /eval-diff and /eval-history commands. */
declare function apply(ctx: Context): void;
//#endregion
export { type DimensionDelta, type DimensionGrade, EVAL_DIFF_USAGE, EVAL_HISTORY_USAGE, EVAL_USAGE, type EvalArgs, type EvalDiffArgs, type EvalEvent, type EvalEventKind, type EvalHistoryArgs, type Grade, type GradeCard, type HistoryEntry, type HistoryReport, type HistorySeam, type SessionMetrics, type TrendReport, VERSION, adaptEvents, apply, compareSessions, computeMetrics, executeEval, executeEvalDiff, executeEvalHistory, gradeSession, id8, inject, name, parseEvalArgs, parseEvalDiffArgs, parseEvalHistoryArgs, renderCard, renderHistory, renderTrend };