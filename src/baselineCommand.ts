/**
 * `/eval-baseline` — persist grade cards per workspace and compare later
 * sessions against them.
 *
 * The store is `<session cwd>/.dsh-evals/baseline.jsonl` (see baseline.ts):
 * one JSON record per line, append-only, bad lines skipped and counted.
 * `set` pins the current grade card as the reference point; `compare` diffs
 * a session against the latest record with the same noise bands as
 * `/eval-diff`; `list` and `clear` round out the lifecycle.
 *
 * Every record carries version stamps (generator, session-format version,
 * bands fingerprint); `compare` warns loudly before comparing across
 * versions instead of quietly mixing incompatible measurements.
 *
 * @module dsh-session-eval/baselineCommand
 */
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import type { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import { adaptEvents, computeMetrics, zeroProjectionNote } from './metrics.ts'
import { gradeSession, type GradeBands } from './grade.ts'
import { compareSessions, formatDimensionChange } from './trend.ts'
import { readFormatVersion, id8 } from './evalCommand.ts'
import {
  appendBaselineRecord,
  bandsFingerprint,
  buildBaselineRecord,
  effectiveBands,
  latestBaseline,
  loadBaselineRecords,
  resolveBaselinePath,
  type BaselineIo,
  type BaselineLoad,
  nodeBaselineIo,
} from './baseline.ts'
import type { GradeCard, SessionMetrics } from './types.ts'
import { VERSION } from './version.ts'

export const EVAL_BASELINE_USAGE = 'Usage: /eval-baseline set [--id <sessionId>] | compare [--id <sessionId>] | list [N] | clear'

/** The slice of sessionQuery this command consumes (structural, for testability). */
export interface BaselineSeam {
  readSession(id: ReturnType<typeof SessionId>): Promise<{ events: readonly unknown[]; session?: { version?: unknown } }>
}

/** Args for the four /eval-baseline subcommands. */
export type EvalBaselineArgs =
  | { readonly action: 'set'; readonly sessionId?: string }
  | { readonly action: 'compare'; readonly sessionId?: string }
  | { readonly action: 'list'; readonly count: number }
  | { readonly action: 'clear' }

/** Parse /eval-baseline input; returns args or a usage-error string. */
export function parseEvalBaselineArgs(rawInput: string): EvalBaselineArgs | string {
  const tokens = rawInput.trim().split(/\s+/).filter((t) => t.length > 0)
  if (tokens.length === 0) return `Expected a subcommand: set, compare, list, or clear.\n${EVAL_BASELINE_USAGE}`
  const subcommand = tokens[0]!
  if (subcommand === 'set' || subcommand === 'compare') {
    let sessionId: string | undefined
    let i = 1
    while (i < tokens.length) {
      const token = tokens[i]!
      if (token === '--id') {
        const value = tokens[i + 1]
        if (value === undefined || value.startsWith('--')) return `--id requires a session id value.\n${EVAL_BASELINE_USAGE}`
        if (sessionId !== undefined) return `--id may be given only once.\n${EVAL_BASELINE_USAGE}`
        sessionId = value
        i += 2
        continue
      }
      return `Unknown argument: ${token}\n${EVAL_BASELINE_USAGE}`
    }
    return subcommand === 'set'
      ? { action: 'set', ...(sessionId !== undefined ? { sessionId } : {}) }
      : { action: 'compare', ...(sessionId !== undefined ? { sessionId } : {}) }
  }
  if (subcommand === 'list') {
    let count = 5
    let sawCount = false
    for (let i = 1; i < tokens.length; i++) {
      const token = tokens[i]!
      if (token.startsWith('--')) return `Unknown argument: ${token}\n${EVAL_BASELINE_USAGE}`
      if (sawCount) return `Expected at most one count argument.\n${EVAL_BASELINE_USAGE}`
      if (!/^\d+$/.test(token)) return `N must be a positive integer.\n${EVAL_BASELINE_USAGE}`
      const value = Number(token)
      if (value < 1 || value > 20) return `N must be between 1 and 20.\n${EVAL_BASELINE_USAGE}`
      count = value
      sawCount = true
    }
    return { action: 'list', count }
  }
  if (subcommand === 'clear') {
    if (tokens.length > 1) return `Unknown argument: ${tokens[1]}\n${EVAL_BASELINE_USAGE}`
    return { action: 'clear' }
  }
  return `Expected a subcommand: set, compare, list, or clear.\n${EVAL_BASELINE_USAGE}`
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** `v3` for a known header version, `unknown` when the seam carried none. */
function formatVersionLabel(version: number | null): string {
  return version === null ? 'unknown' : `v${version}`
}

/** Local timestamp rendering for ISO `at` stamps (mirrors /eval-history). */
function stampIso(at: string): string {
  const ms = Date.parse(at)
  if (!Number.isFinite(ms)) return '?'
  return new Date(ms).toISOString().slice(0, 16).replace('T', ' ')
}

interface SeamLog {
  readonly events: readonly unknown[]
  readonly session?: { readonly version?: unknown }
}

async function readSeamSession(seam: BaselineSeam, sessionIdRaw: string): Promise<SeamLog | string> {
  try {
    return await seam.readSession(SessionId(sessionIdRaw))
  } catch (error) {
    return `Could not read session ${id8(sessionIdRaw)}: ${message(error)}`
  }
}

/** Grade one session through the seam, with the zero-projection guard applied. */
async function gradeSeamSession(
  seam: BaselineSeam,
  sessionIdRaw: string,
  bands: Partial<GradeBands>,
): Promise<{ metrics: SessionMetrics; card: GradeCard; formatVersion: number | null; drift: string | null } | string> {
  const log = await readSeamSession(seam, sessionIdRaw)
  if (typeof log === 'string') return log
  const metrics = computeMetrics(sessionIdRaw, adaptEvents(log.events))
  const drift = zeroProjectionNote(log.events)
  const graded = gradeSession(metrics, bands)
  const card = drift === null ? graded : { ...graded, notes: [...graded.notes, drift] }
  return { metrics, card, formatVersion: readFormatVersion(log), drift }
}

async function runSet(
  seam: BaselineSeam,
  sessionIdRaw: string,
  storePath: string,
  bands: Partial<GradeBands>,
  effective: GradeBands,
  io: BaselineIo,
): Promise<CommandResult> {
  const graded = await gradeSeamSession(seam, sessionIdRaw, bands)
  if (typeof graded === 'string') return { kind: 'error', text: graded }
  const record = buildBaselineRecord({
    sessionId: sessionIdRaw,
    sessionFormatVersion: graded.formatVersion,
    metrics: graded.metrics,
    card: graded.card,
    bands: effective,
  })
  try {
    await appendBaselineRecord(storePath, record, io)
  } catch (error) {
    return { kind: 'error', text: `Could not write baseline record to ${storePath}: ${message(error)}` }
  }
  return {
    kind: 'success',
    text: `Baseline saved — ${id8(sessionIdRaw)} · Overall ${record.card.overall} · ${record.generator} · session format ${formatVersionLabel(record.sessionFormatVersion)}\n→ ${storePath}`,
  }
}

async function runCompare(
  seam: BaselineSeam,
  sessionIdRaw: string,
  storePath: string,
  bands: Partial<GradeBands>,
  effective: GradeBands,
  io: BaselineIo,
): Promise<CommandResult> {
  let load: BaselineLoad
  try {
    load = await loadBaselineRecords(storePath, io)
  } catch (error) {
    return { kind: 'error', text: `Could not read baseline store ${storePath}: ${message(error)}` }
  }
  if (!load.exists || load.records.length === 0) {
    return { kind: 'error', text: `No baseline recorded yet — run /eval-baseline set first (${storePath}).` }
  }
  const baseline = latestBaseline(load.records)!

  const graded = await gradeSeamSession(seam, sessionIdRaw, bands)
  if (typeof graded === 'string') return { kind: 'error', text: graded }

  const generator = `dsh-session-eval v${VERSION}`
  const fingerprint = bandsFingerprint(effective)
  const crossVersion =
    baseline.generator !== generator || baseline.bandsFingerprint !== fingerprint || baseline.sessionFormatVersion !== graded.formatVersion

  const lines: string[] = []
  if (crossVersion) {
    lines.push(
      `Warning: baseline recorded under ${baseline.generator} / bands ${baseline.bandsFingerprint || 'unknown'} / format ${formatVersionLabel(baseline.sessionFormatVersion)}, current ${generator} / bands ${fingerprint} / format ${formatVersionLabel(graded.formatVersion)}; comparison crosses versions.`,
    )
  }
  if (graded.drift !== null) lines.push(`Note: ${graded.drift}`)

  // Same noise-band comparison /eval-diff uses — not a reimplementation.
  const report = compareSessions(baseline.metrics, graded.metrics)
  lines.push(`Baseline comparison — ${id8(baseline.sessionId)} → ${id8(sessionIdRaw)} · baseline of ${stampIso(baseline.at)} (${generator})`)
  lines.push(`Overall: ${report.overall} — ${report.summary}`)
  for (const delta of report.deltas) {
    lines.push(`  ${delta.dimension.padEnd(13)} ${delta.before} → ${delta.after}  (${formatDimensionChange(delta.dimension, delta.change)})  ${delta.verdict}`)
  }
  return { kind: 'success', text: lines.join('\n') }
}

async function runList(storePath: string, io: BaselineIo, count: number): Promise<CommandResult> {
  let load: BaselineLoad
  try {
    load = await loadBaselineRecords(storePath, io)
  } catch (error) {
    return { kind: 'error', text: `Could not read baseline store ${storePath}: ${message(error)}` }
  }
  if (!load.exists || load.records.length === 0) {
    return { kind: 'success', text: 'No baseline records yet — run /eval-baseline set first.' }
  }
  const shown = [...load.records].reverse().slice(0, count)
  const lines = [`Baseline records — ${load.records.length} stored, showing ${shown.length} (newest first)`]
  for (const record of shown) {
    lines.push(`  ${stampIso(record.at)}  ${id8(record.sessionId)}  ${String(record.card.overall).padEnd(3)}  ${record.generator}`)
  }
  return { kind: 'success', text: lines.join('\n') }
}

async function runClear(storePath: string, io: BaselineIo): Promise<CommandResult> {
  let load: BaselineLoad
  try {
    load = await loadBaselineRecords(storePath, io)
  } catch (error) {
    return { kind: 'error', text: `Could not read baseline store ${storePath}: ${message(error)}` }
  }
  if (!load.exists) {
    return { kind: 'success', text: `No baseline store at ${storePath} — nothing to clear.` }
  }
  try {
    await io.unlink(storePath)
  } catch (error) {
    return { kind: 'error', text: `Could not delete baseline store ${storePath}: ${message(error)}` }
  }
  const badNote = load.badLines > 0 ? ` (${load.badLines} unparseable line(s) included)` : ''
  return { kind: 'success', text: `Cleared baseline store — deleted ${load.records.length} record(s) from ${storePath}${badNote}.` }
}

/**
 * Execute /eval-baseline against the session-query seam and the workspace
 * baseline store. The store directory is the session's cwd (falling back to
 * the process cwd), the same workspace a `/eval-history --out` file lands in.
 */
export async function executeEvalBaseline(
  ctx: Context,
  invocation: CommandInvocation,
  seam: BaselineSeam = (ctx as unknown as { sessionQuery: BaselineSeam }).sessionQuery,
  bands: Partial<GradeBands> = {},
  io: BaselineIo = nodeBaselineIo,
): Promise<CommandResult> {
  const parsed = parseEvalBaselineArgs(invocation.rawInput)
  if (typeof parsed === 'string') return { kind: 'error', text: parsed }

  const headerCwd = (invocation.agent.session as { header?: { cwd?: unknown } }).header?.cwd
  const cwd = typeof headerCwd === 'string' ? headerCwd : process.cwd()
  const storePath = resolveBaselinePath(cwd)
  const effective = effectiveBands(bands)

  switch (parsed.action) {
    case 'set': {
      const sessionIdRaw = parsed.sessionId ?? String(invocation.agent.session.id)
      return runSet(seam, sessionIdRaw, storePath, bands, effective, io)
    }
    case 'compare': {
      const sessionIdRaw = parsed.sessionId ?? String(invocation.agent.session.id)
      return runCompare(seam, sessionIdRaw, storePath, bands, effective, io)
    }
    case 'list':
      return runList(storePath, io, parsed.count)
    case 'clear':
      return runClear(storePath, io)
  }
}
