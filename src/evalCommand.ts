/**
 * `/eval` and `/eval-diff` commands — retrospective session evaluation.
 *
 * Reads through the same `ctx.sessionQuery` seam as `/stats` in
 * dsh-session-export, so any persistence backend works. All grading is
 * deterministic (fixed thresholds, documented in the README); no LLM judges.
 *
 * @module dsh-session-eval/evalCommand
 */
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import type { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import { adaptEvents, computeMetrics, zeroProjectionNote } from './metrics.ts'
import { loadReportArtifact, type ReadFile } from './artifact.ts'
import { readFileSync } from 'node:fs'
import { gradeSession, type GradeBands } from './grade.ts'
import { compareSessions } from './trend.ts'
import type { GradeCard, TrendReport } from './types.ts'
import { VERSION } from './version.ts'

export const EVAL_USAGE = 'Usage: /eval [--id <sessionId>] [--report <bundle-or-archive.zip>] [--json]'
export const EVAL_DIFF_USAGE = 'Usage: /eval-diff <beforeSessionId> <afterSessionId> [--json]'

export function id8(sessionId: string): string {
  return sessionId.length > 8 ? `${sessionId.slice(0, 8)}…` : sessionId
}

/** Args for /eval. */
export interface EvalArgs {
  readonly sessionId?: string
  readonly report?: string
  readonly json?: boolean
}

/** Args for /eval-diff. */
export interface EvalDiffArgs {
  readonly beforeId: string
  readonly afterId: string
  readonly json?: boolean
}

/** Parse /eval input; returns args or a usage-error string. */
export function parseEvalArgs(rawInput: string): EvalArgs | string {
  const trimmed = rawInput.trim()
  if (trimmed.length === 0) return {}
  const tokens = trimmed.split(/\s+/)
  const args: { sessionId?: string; report?: string; json?: boolean } = {}
  let i = 0
  while (i < tokens.length) {
    const token = tokens[i]
    if (token === undefined) break
    if (token === '--id') {
      const value = tokens[i + 1]
      if (value === undefined || value.startsWith('--')) return `--id requires a session id value.\n${EVAL_USAGE}`
      if (args.sessionId !== undefined) return `--id may be given only once.\n${EVAL_USAGE}`
      args.sessionId = value
      i += 2
      continue
    }
    if (token === '--report') {
      const value = tokens[i + 1]
      if (value === undefined || value.startsWith('--')) return `--report requires an artifact path value.\n${EVAL_USAGE}`
      if (args.report !== undefined) return `--report may be given only once.\n${EVAL_USAGE}`
      args.report = value
      i += 2
      continue
    }
    if (token === '--json') {
      if (args.json === true) return `--json may be given only once.\n${EVAL_USAGE}`
      args.json = true
      i += 1
      continue
    }
    return `Unknown argument: ${token}\n${EVAL_USAGE}`
  }
  if (args.sessionId !== undefined && args.report !== undefined) {
    return `--id and --report are mutually exclusive.\n${EVAL_USAGE}`
  }
  return args
}

/** Parse /eval-diff input; returns args or a usage-error string. */
export function parseEvalDiffArgs(rawInput: string): EvalDiffArgs | string {
  const tokens = rawInput.trim().split(/\s+/).filter((t) => t.length > 0)
  let json = false
  const positional: string[] = []
  for (const token of tokens) {
    if (token === '--json') {
      if (json) return `--json may be given only once.\n${EVAL_DIFF_USAGE}`
      json = true
      continue
    }
    if (token.startsWith('--')) return `Unknown argument: ${token}\n${EVAL_DIFF_USAGE}`
    positional.push(token)
  }
  if (positional.length !== 2) {
    return `Expected exactly two session ids (before, after).\n${EVAL_DIFF_USAGE}`
  }
  const [beforeId, afterId] = positional as [string, string]
  if (beforeId === afterId) return `The two session ids must differ.\n${EVAL_DIFF_USAGE}`
  return { beforeId, afterId, json }
}

/** Render a grade card as terminal text. */
export function renderCard(card: GradeCard, generator: string): string {
  const lines: string[] = [`Session eval — ${id8(card.sessionId)} (${generator})`, `Overall: ${card.overall}`]
  for (const dimension of card.dimensions) {
    lines.push(`  ${dimension.dimension.padEnd(13)} ${String(dimension.grade).padEnd(3)} ${dimension.detail}`)
  }
  if (card.notes.length > 0) {
    lines.push('Notes:')
    for (const note of card.notes) lines.push(`  • ${note}`)
  }
  return lines.join('\n')
}

/** Render a trend report as terminal text. */
export function renderTrend(report: TrendReport, generator: string): string {
  const lines = [
    `Session diff — ${id8(report.before.sessionId)} → ${id8(report.after.sessionId)} (${generator})`,
    `Overall: ${report.overall} — ${report.summary}`,
  ]
  for (const delta of report.deltas) {
    lines.push(`  ${delta.dimension.padEnd(13)} ${delta.before} → ${delta.after}   ${delta.verdict}`)
  }
  return lines.join('\n')
}

/**
 * One read through the session-query seam. The header rides along so the
 * format-version guardrail can stamp outputs; `session` is optional because
 * test seams and older backends may not carry it.
 */
interface SessionLog {
  readonly events: readonly unknown[]
  readonly session?: { readonly version?: unknown }
}

interface QuerySeam {
  readSession(id: ReturnType<typeof SessionId>): Promise<SessionLog>
}

/**
 * Session-log format version from the read snapshot's header
 * (`SessionHeader.version`), or null when the seam did not carry a header —
 * e.g. artifact grading, where the archived JSONL has no header line.
 */
export function readFormatVersion(log: { session?: { version?: unknown } }): number | null {
  const version = log.session?.version
  return typeof version === 'number' && Number.isFinite(version) ? version : null
}

async function readLog(ctx: Context, seam: QuerySeam, sessionIdRaw: string): Promise<SessionLog | string> {
  try {
    return await seam.readSession(SessionId(sessionIdRaw))
  } catch (error) {
    return `Could not read session ${id8(sessionIdRaw)}: ${error instanceof Error ? error.message : String(error)}`
  }
}

/** Execute /eval against the session-query seam or an exported artifact. */
export async function executeEval(
  ctx: Context,
  invocation: CommandInvocation,
  seam: QuerySeam = (ctx as unknown as { sessionQuery: QuerySeam }).sessionQuery,
  bands: Partial<GradeBands> = {},
  readFile: ReadFile = (path) => readFileSync(path),
): Promise<CommandResult> {
  const parsed = parseEvalArgs(invocation.rawInput)
  if (typeof parsed === 'string') return { kind: 'error', text: parsed }

  if (parsed.report !== undefined) {
    // Evidence handoff: grade the raw JSONL inside a bundle or archive ZIP —
    // the same events readSession would return, so the numbers match /eval --id.
    const artifact = loadReportArtifact(parsed.report, readFile)
    if (typeof artifact === 'string') return { kind: 'error', text: artifact }
    const metrics = computeMetrics(artifact.sessionId, adaptEvents(artifact.events))
    // The archived JSONL carries no session header, so the format version is
    // unknown here — null is an explicit "unavailable", not a zero.
    const note = `from artifact ${artifact.origin}`
    const drift = zeroProjectionNote(artifact.events)
    const graded = gradeSession(metrics, bands)
    const card = drift === null ? graded : { ...graded, notes: [...graded.notes, drift] }
    if (parsed.json === true) {
      return { kind: 'success', text: JSON.stringify({ generator: 'dsh-session-eval v' + VERSION, sessionFormatVersion: null, source: note, metrics, card }, null, 2) }
    }
    return { kind: 'success', text: `${renderCard(card, 'dsh-session-eval v' + VERSION)}\n(${note})` }
  }

  const sessionIdRaw = parsed.sessionId ?? String(invocation.agent.session.id)
  const log = await readLog(ctx, seam, sessionIdRaw)
  if (typeof log === 'string') return { kind: 'error', text: log }

  const metrics = computeMetrics(sessionIdRaw, adaptEvents(log.events))
  const drift = zeroProjectionNote(log.events)
  const graded = gradeSession(metrics, bands)
  const card = drift === null ? graded : { ...graded, notes: [...graded.notes, drift] }

  if (parsed.json === true) {
    return {
      kind: 'success',
      text: JSON.stringify({ generator: 'dsh-session-eval v' + VERSION, sessionFormatVersion: readFormatVersion(log), metrics, card }, null, 2),
    }
  }
  return { kind: 'success', text: renderCard(card, 'dsh-session-eval v' + VERSION) }
}

/** Execute /eval-diff against the session-query seam. */
export async function executeEvalDiff(
  ctx: Context,
  invocation: CommandInvocation,
  seam: QuerySeam = (ctx as unknown as { sessionQuery: QuerySeam }).sessionQuery,
): Promise<CommandResult> {
  const parsed = parseEvalDiffArgs(invocation.rawInput)
  if (typeof parsed === 'string') return { kind: 'error', text: parsed }

  const beforeLog = await readLog(ctx, seam, parsed.beforeId)
  if (typeof beforeLog === 'string') return { kind: 'error', text: beforeLog }
  const afterLog = await readLog(ctx, seam, parsed.afterId)
  if (typeof afterLog === 'string') return { kind: 'error', text: afterLog }

  const before = computeMetrics(parsed.beforeId, adaptEvents(beforeLog.events))
  const after = computeMetrics(parsed.afterId, adaptEvents(afterLog.events))
  const report = compareSessions(before, after)

  if (parsed.json === true) {
    return { kind: 'success', text: JSON.stringify({ generator: 'dsh-session-eval v' + VERSION, report }, null, 2) }
  }
  return { kind: 'success', text: renderTrend(report, 'dsh-session-eval v' + VERSION) }
}
