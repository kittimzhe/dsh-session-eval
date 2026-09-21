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
import { adaptEvents, computeMetrics } from './metrics.ts'
import { gradeSession } from './grade.ts'
import { compareSessions } from './trend.ts'
import type { GradeCard, TrendReport } from './types.ts'

export const EVAL_USAGE = 'Usage: /eval [--id <sessionId>] [--json]'
export const EVAL_DIFF_USAGE = 'Usage: /eval-diff <beforeSessionId> <afterSessionId> [--json]'

export function id8(sessionId: string): string {
  return sessionId.length > 8 ? `${sessionId.slice(0, 8)}…` : sessionId
}

/** Args for /eval. */
export interface EvalArgs {
  readonly sessionId?: string
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
  const args: { sessionId?: string; json?: boolean } = {}
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
    if (token === '--json') {
      if (args.json === true) return `--json may be given only once.\n${EVAL_USAGE}`
      args.json = true
      i += 1
      continue
    }
    return `Unknown argument: ${token}\n${EVAL_USAGE}`
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

interface QuerySeam {
  readSession(id: ReturnType<typeof SessionId>): Promise<{ events: readonly unknown[] }>
}

async function readEvents(ctx: Context, seam: QuerySeam, sessionIdRaw: string): Promise<readonly unknown[] | string> {
  try {
    const log = await seam.readSession(SessionId(sessionIdRaw))
    return log.events
  } catch (error) {
    return `Could not read session ${id8(sessionIdRaw)}: ${error instanceof Error ? error.message : String(error)}`
  }
}

/** Execute /eval against the session-query seam. */
export async function executeEval(
  ctx: Context,
  invocation: CommandInvocation,
  seam: QuerySeam = (ctx as unknown as { sessionQuery: QuerySeam }).sessionQuery,
): Promise<CommandResult> {
  const parsed = parseEvalArgs(invocation.rawInput)
  if (typeof parsed === 'string') return { kind: 'error', text: parsed }

  const sessionIdRaw = parsed.sessionId ?? String(invocation.agent.session.id)
  const events = await readEvents(ctx, seam, sessionIdRaw)
  if (typeof events === 'string') return { kind: 'error', text: events }

  const metrics = computeMetrics(sessionIdRaw, adaptEvents(events))
  const card = gradeSession(metrics)

  if (parsed.json === true) {
    return { kind: 'success', text: JSON.stringify({ generator: 'dsh-session-eval v0.1.0', metrics, card }, null, 2) }
  }
  return { kind: 'success', text: renderCard(card, 'dsh-session-eval v0.1.0') }
}

/** Execute /eval-diff against the session-query seam. */
export async function executeEvalDiff(
  ctx: Context,
  invocation: CommandInvocation,
  seam: QuerySeam = (ctx as unknown as { sessionQuery: QuerySeam }).sessionQuery,
): Promise<CommandResult> {
  const parsed = parseEvalDiffArgs(invocation.rawInput)
  if (typeof parsed === 'string') return { kind: 'error', text: parsed }

  const beforeEvents = await readEvents(ctx, seam, parsed.beforeId)
  if (typeof beforeEvents === 'string') return { kind: 'error', text: beforeEvents }
  const afterEvents = await readEvents(ctx, seam, parsed.afterId)
  if (typeof afterEvents === 'string') return { kind: 'error', text: afterEvents }

  const before = computeMetrics(parsed.beforeId, adaptEvents(beforeEvents))
  const after = computeMetrics(parsed.afterId, adaptEvents(afterEvents))
  const report = compareSessions(before, after)

  if (parsed.json === true) {
    return { kind: 'success', text: JSON.stringify({ generator: 'dsh-session-eval v0.1.0', report }, null, 2) }
  }
  return { kind: 'success', text: renderTrend(report, 'dsh-session-eval v0.1.0') }
}
