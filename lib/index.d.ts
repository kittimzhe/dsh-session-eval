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
  /**
   * Signed numeric difference (after − before) in the dimension's own unit:
   * an error-rate fraction for Reliability, corrections per 10 turns for
   * Re-ask, calls per turn for Tool load. Consumers format it for display;
   * see {@link ./trend.ts | formatDimensionChange}.
   */
  readonly change: number;
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
/**
 * Guardrail note: when the raw log has events but none of them project into
 * the evaluation vocabulary, the metrics are zeros because the format
 * drifted — not because the session was empty. Returns the note text for
 * the grade card, or null when the projection is trustworthy.
 */
declare function zeroProjectionNote(raw: readonly unknown[]): string | null;
//#endregion
//#region src/grade.d.ts
/**
 * Grade bands per dimension, overridable from the plugin config (#1).
 * Each array holds the A/B/C/D upper bounds in ascending order; anything
 * above the D bound grades E. Reliability bounds are error-rate fractions,
 * re-ask bounds are corrections per 10 user turns, tool-load bounds are
 * calls per turn as [lowC, lowB, highC, highD].
 */
interface GradeBands {
  readonly reliability: readonly [number, number, number, number];
  readonly reask: readonly [number, number, number, number];
  readonly toolLoad: readonly [number, number, number, number];
}
/**
 * Grade one session deterministically. `bands` may override any subset of
 * the dimensions; unspecified ones keep the documented defaults.
 */
declare function gradeSession(m: SessionMetrics, bands?: Partial<GradeBands>): GradeCard;
//#endregion
//#region src/trend.d.ts
/**
 * Format one dimension's numeric change (from {@link DimensionDelta.change})
 * as a signed human-readable string — percentage points for Reliability, raw
 * metric units for the rest. Zero rounds to `±0.0` instead of a fake sign.
 */
declare function formatDimensionChange(dimension: DimensionDelta['dimension'], change: number): string;
/** Compare two sessions dimension by dimension. */
declare function compareSessions(before: SessionMetrics, after: SessionMetrics): TrendReport;
//#endregion
//#region src/baseline.d.ts
/** Directory name inside the session cwd that holds the baseline store. */
declare const BASELINE_DIR = ".dsh-evals";
/** File name of the baseline store inside {@link BASELINE_DIR}. */
declare const BASELINE_FILE = "baseline.jsonl";
/** Filesystem seam for the baseline store (injectable for tests). */
interface BaselineIo {
  /** Create the store directory (idempotent). */
  readonly mkdir: (dir: string) => Promise<unknown>;
  /** Append one already-serialized line to the store. */
  readonly append: (path: string, data: string) => Promise<unknown>;
  /** Read the whole store as UTF-8 text. */
  readonly read: (path: string) => Promise<string>;
  /** Delete the store file. */
  readonly unlink: (path: string) => Promise<unknown>;
}
/** The default seam over `node:fs/promises`. */
declare const nodeBaselineIo: BaselineIo;
/**
 * One persisted baseline record: the full grade card of the moment, plus the
 * version stamps a later `/eval-baseline compare` checks before trusting it.
 */
interface BaselineRecord {
  /** ISO timestamp of when the record was written. */
  readonly at: string;
  /** The session that was graded. */
  readonly sessionId: string;
  /** Generator stamp, `dsh-session-eval v<VERSION>` at write time. */
  readonly generator: string;
  /** Session header format version when readable, else null. */
  readonly sessionFormatVersion: number | null;
  /** Full deterministic metrics of the graded session. */
  readonly metrics: SessionMetrics;
  /** Grade card (Overall + every dimension) of the graded session. */
  readonly card: GradeCard;
  /** Fingerprint of the grade bands that produced this record's grades. */
  readonly bandsFingerprint: string;
  /** Which command wrote the record. */
  readonly source: 'set';
}
/** What `loadBaselineRecords` found in the store. */
interface BaselineLoad {
  /** Whether the store file exists at all. */
  readonly exists: boolean;
  /** Parsed records in append order (oldest first). */
  readonly records: readonly BaselineRecord[];
  /** How many non-empty lines failed to parse into a record. */
  readonly badLines: number;
}
/** Resolve the baseline store path for a workspace cwd. */
declare function resolveBaselinePath(cwd: string): string;
/**
 * Fingerprint of the grade bands that decide this record's grades:
 * sha256 over the plugin version and the effective bands, truncated to 16
 * hex chars — enough to detect any accidental threshold change without
 * printing the whole config.
 */
declare function bandsFingerprint(bands: GradeBands): string;
/** Merge partial bands over the defaults — the bands a grade actually ran with. */
declare function effectiveBands(bands: Partial<GradeBands>): GradeBands;
/** The record `set` persists for one grading pass; `at` defaults to now. */
declare function buildBaselineRecord(input: {
  readonly sessionId: string;
  readonly sessionFormatVersion: number | null;
  readonly metrics: SessionMetrics;
  readonly card: GradeCard;
  /** The effective (fully merged) grade bands used for this card. */
  readonly bands: GradeBands;
  readonly at?: string;
}): BaselineRecord;
/** Append one record as a single JSON line (creates the directory first). */
declare function appendBaselineRecord(path: string, record: BaselineRecord, io?: BaselineIo): Promise<void>;
/**
 * Load and parse the store: one record per non-empty line; bad lines are
 * skipped and counted, never fatal. A missing file loads as
 * `{ exists: false, … }` so `clear` can be friendly about it.
 * Throws only for non-ENOENT read errors; callers report them.
 */
declare function loadBaselineRecords(path: string, io?: BaselineIo): Promise<BaselineLoad>;
/**
 * The latest baseline record: the last line. Append order is the store's
 * physical truth, so this stays deterministic even under clock skew; the
 * list renderer reads the same order backwards for "newest first".
 */
declare function latestBaseline(records: readonly BaselineRecord[]): BaselineRecord | null;
//#endregion
//#region src/artifact.d.ts
/** Filesystem seam (injectable for tests). */
type ReadFile = (path: string) => Buffer;
//#endregion
//#region src/evalCommand.d.ts
declare const EVAL_USAGE = "Usage: /eval [--id <sessionId>] [--report <bundle-or-archive.zip>] [--json]";
declare const EVAL_DIFF_USAGE = "Usage: /eval-diff <beforeSessionId> <afterSessionId> [--json]";
declare function id8(sessionId: string): string;
/** Args for /eval. */
interface EvalArgs {
  readonly sessionId?: string;
  readonly report?: string;
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
/**
 * One read through the session-query seam. The header rides along so the
 * format-version guardrail can stamp outputs; `session` is optional because
 * test seams and older backends may not carry it.
 */
interface SessionLog {
  readonly events: readonly unknown[];
  readonly session?: {
    readonly version?: unknown;
  };
}
interface QuerySeam {
  readSession(id: ReturnType<typeof SessionId>): Promise<SessionLog>;
}
/**
 * Session-log format version from the read snapshot's header
 * (`SessionHeader.version`), or null when the seam did not carry a header —
 * e.g. artifact grading, where the archived JSONL has no header line.
 */
declare function readFormatVersion(log: {
  session?: {
    version?: unknown;
  };
}): number | null;
/** Execute /eval against the session-query seam or an exported artifact. */
declare function executeEval(ctx: Context, invocation: CommandInvocation, seam?: QuerySeam, bands?: Partial<GradeBands>, readFile?: ReadFile): Promise<CommandResult>;
/** Execute /eval-diff against the session-query seam. */
declare function executeEvalDiff(ctx: Context, invocation: CommandInvocation, seam?: QuerySeam): Promise<CommandResult>;
//#endregion
//#region src/historyCommand.d.ts
declare const EVAL_HISTORY_USAGE = "Usage: /eval-history [N] [--json] [--out PATH] [--since 24h|7d|30d]  (N = last N sessions, 1-20, default 5; --since grades only sessions whose latest activity falls inside the window)";
/** Args for /eval-history. */
interface EvalHistoryArgs {
  readonly count: number;
  readonly json: boolean;
  readonly out?: string;
  /** Time window from --since; grades only sessions whose latest activity falls inside. */
  readonly since?: {
    label: string;
    ms: number;
  };
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
  /** The --since label this report was filtered by, if any. */
  readonly sinceLabel?: string;
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
declare function executeEvalHistory(ctx: Context, invocation: CommandInvocation, seam?: HistorySeam, bands?: Partial<GradeBands>): Promise<CommandResult>;
//#endregion
//#region src/baselineCommand.d.ts
declare const EVAL_BASELINE_USAGE = "Usage: /eval-baseline set [--id <sessionId>] | compare [--id <sessionId>] | list [N] | clear";
/** The slice of sessionQuery this command consumes (structural, for testability). */
interface BaselineSeam {
  readSession(id: ReturnType<typeof SessionId>): Promise<{
    events: readonly unknown[];
    session?: {
      version?: unknown;
    };
  }>;
}
/** Args for the four /eval-baseline subcommands. */
type EvalBaselineArgs = {
  readonly action: 'set';
  readonly sessionId?: string;
} | {
  readonly action: 'compare';
  readonly sessionId?: string;
} | {
  readonly action: 'list';
  readonly count: number;
} | {
  readonly action: 'clear';
};
/** Parse /eval-baseline input; returns args or a usage-error string. */
declare function parseEvalBaselineArgs(rawInput: string): EvalBaselineArgs | string;
/**
 * Execute /eval-baseline against the session-query seam and the workspace
 * baseline store. The store directory is the session's cwd (falling back to
 * the process cwd), the same workspace a `/eval-history --out` file lands in.
 */
declare function executeEvalBaseline(ctx: Context, invocation: CommandInvocation, seam?: BaselineSeam, bands?: Partial<GradeBands>, io?: BaselineIo): Promise<CommandResult>;
//#endregion
//#region src/version.d.ts
/**
 * Single source of truth for the plugin version string.
 *
 * @module dsh-session-eval/version
 */
declare const VERSION = "0.5.0";
//#endregion
//#region src/index.d.ts
declare const name = "session-eval";
declare const inject: string[];
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
declare function apply(ctx: Context, config?: unknown): void;
//#endregion
export { BASELINE_DIR, BASELINE_FILE, type BaselineIo, type BaselineLoad, type BaselineRecord, type BaselineSeam, type DimensionDelta, type DimensionGrade, EVAL_BASELINE_USAGE, EVAL_DIFF_USAGE, EVAL_HISTORY_USAGE, EVAL_USAGE, type EvalArgs, type EvalBaselineArgs, type EvalDiffArgs, type EvalEvent, type EvalEventKind, type EvalHistoryArgs, type Grade, type GradeCard, type HistoryEntry, type HistoryReport, type HistorySeam, type SessionMetrics, type TrendReport, VERSION, adaptEvents, appendBaselineRecord, apply, bandsFingerprint, buildBaselineRecord, compareSessions, computeMetrics, effectiveBands, executeEval, executeEvalBaseline, executeEvalDiff, executeEvalHistory, formatDimensionChange, gradeSession, id8, inject, latestBaseline, loadBaselineRecords, name, nodeBaselineIo, parseEvalArgs, parseEvalBaselineArgs, parseEvalDiffArgs, parseEvalHistoryArgs, readFormatVersion, renderCard, renderHistory, renderTrend, resolveBaselinePath, zeroProjectionNote };