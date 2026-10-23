/**
 * `/eval-history` — grade the last N sessions in this workspace and show the trend.
 *
 * Completes the regression-tracking story: `/eval-diff` compares two sessions
 * you already know about; this command finds them for you (via
 * `ctx.sessionQuery.listSessions()`, same seam as `/archive` in
 * dsh-session-export) and answers "is the trend improving?" out of the box.
 *
 * @module dsh-session-eval/historyCommand
 */
import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import type { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import { adaptEvents, computeMetrics } from './metrics.ts'
import { gradeSession, type GradeBands } from './grade.ts'
import { compareSessions } from './trend.ts'
import { id8 } from './evalCommand.ts'
import { VERSION } from './version.ts'
import type { Grade, GradeCard, SessionMetrics, TrendReport } from './types.ts'

export const EVAL_HISTORY_USAGE = 'Usage: /eval-history [N] [--json] [--out PATH] [--since 24h|7d|30d]  (N = last N sessions, 1-20, default 5; --since grades only sessions whose latest activity falls inside the window)'

/** Args for /eval-history. */
export interface EvalHistoryArgs {
  readonly count: number
  readonly json: boolean
  readonly out?: string
  /** Time window from --since; grades only sessions whose latest activity falls inside. */
  readonly since?: { label: string; ms: number }
}

/** Parse /eval-history input; returns args or a usage-error string. */
export function parseEvalHistoryArgs(rawInput: string): EvalHistoryArgs | string {
  const tokens = rawInput.trim().split(/\s+/).filter((t) => t.length > 0)
  let count = 5
  let json = false
  let sawCount = false
  let out: string | undefined
  let since: { label: string; ms: number } | undefined
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!
    if (token === '--since') {
      if (since !== undefined) return `--since may be given only once.\n${EVAL_HISTORY_USAGE}`
      const value = tokens[++i]
      const match = /^(\d+)(h|d)$/.exec(value ?? '')
      if (!match) return `--since needs a window like 24h or 7d.\n${EVAL_HISTORY_USAGE}`
      const amount = Number(match[1])
      if (amount < 1 || amount > 365) return `--since window is out of range.\n${EVAL_HISTORY_USAGE}`
      since = { label: value!, ms: amount * (match[2] === 'h' ? 3_600_000 : 86_400_000) }
      continue
    }
    if (token === '--out') {
      if (out !== undefined) return `--out may be given only once.\n${EVAL_HISTORY_USAGE}`
      const path = tokens[++i]
      if (!path || path.startsWith('--')) return `--out requires a path.\n${EVAL_HISTORY_USAGE}`
      out = path
      continue
    }
    if (token === '--json') {
      if (json) return `--json may be given only once.\n${EVAL_HISTORY_USAGE}`
      json = true
      continue
    }
    if (token.startsWith('--')) return `Unknown argument: ${token}\n${EVAL_HISTORY_USAGE}`
    if (sawCount) return `Expected at most one count argument.\n${EVAL_HISTORY_USAGE}`
    if (!/^\d+$/.test(token)) return `N must be a positive integer.\n${EVAL_HISTORY_USAGE}`
    const value = Number(token)
    if (value < 1 || value > 20) return `N must be between 1 and 20.\n${EVAL_HISTORY_USAGE}`
    count = value
    sawCount = true
  }
  return { count, json, ...(out !== undefined ? { out } : {}), ...(since !== undefined ? { since } : {}) }
}

/** One graded session in a history report. */
export interface HistoryEntry {
  readonly sessionId: string
  readonly createdAt: number | null
  readonly metrics: SessionMetrics
  readonly card: GradeCard
}

/** The full /eval-history report. */
export interface HistoryReport {
  readonly entries: readonly HistoryEntry[]
  readonly trend: TrendReport | null
  /** The --since label this report was filtered by, if any. */
  readonly sinceLabel?: string
}

/** The slice of sessionQuery this command consumes (structural, for testability). */
export interface HistorySeam {
  listSessions(): Promise<ReadonlyArray<{ header: { id: unknown; createdAt: unknown; cwd?: unknown } }>>
  readSession(id: ReturnType<typeof SessionId>): Promise<{ events: readonly unknown[] }>
}

function toMillis(createdAt: unknown): number | null {
  if (typeof createdAt === 'number' && Number.isFinite(createdAt)) return createdAt
  if (typeof createdAt === 'string') {
    const parsed = Date.parse(createdAt)
    if (Number.isFinite(parsed)) return parsed
  }
  return null
}

function stamp(ms: number | null): string {
  if (ms === null) return '?'
  return new Date(ms).toISOString().slice(0, 16).replace('T', ' ')
}

const GRADE_ORDER: readonly Grade[] = ['A', 'B', 'C', 'D', 'E']

function gradeIndex(grade: string): number {
  const index = GRADE_ORDER.indexOf(grade as Grade)
  return index === -1 ? GRADE_ORDER.length : index
}

/** Render a history report as terminal text. */
export function renderHistory(report: HistoryReport): string {
  const lines: string[] = []
  if (report.entries.length === 0) {
    if (report.sinceLabel !== undefined) return `No sessions with activity in the last ${report.sinceLabel} in this workspace; nothing to grade.`
    return 'No sessions found in this workspace; nothing to grade.'
  }
  lines.push(`Session history — last ${report.entries.length} in this workspace`)
  for (const entry of report.entries) {
    const m = entry.metrics
    lines.push(
      `  ${stamp(entry.createdAt)}  ${id8(entry.sessionId)}  ${String(entry.card.overall).padEnd(2)}  ${m.userTurns} turns, ${m.toolCalls} tools`,
    )
  }
  const trend = report.trend
  if (trend !== null) {
    lines.push(`Trend (first → last): ${trend.overall} — ${trend.summary}`)
  }
  return lines.join('\n')
}

/** Execute /eval-history against the session-query seam. */
export async function executeEvalHistory(
  ctx: Context,
  invocation: CommandInvocation,
  seam: HistorySeam = (ctx as unknown as { sessionQuery: HistorySeam }).sessionQuery,
  bands: Partial<GradeBands> = {},
): Promise<CommandResult> {
  const parsed = parseEvalHistoryArgs(invocation.rawInput)
  if (typeof parsed === 'string') return { kind: 'error', text: parsed }

  const ownCwd = (invocation.agent.session as { header?: { cwd?: unknown } }).header?.cwd
  let records: Awaited<ReturnType<HistorySeam['listSessions']>>
  try {
    records = await seam.listSessions()
  } catch (error) {
    return { kind: 'error', text: `Could not list sessions: ${error instanceof Error ? error.message : String(error)}` }
  }

  const headers = records
    .map((record) => record.header)
    .filter((header): header is { id: unknown; createdAt: unknown; cwd?: unknown } => header != null)
    .filter((header) => ownCwd === undefined || header.cwd === ownCwd)
    .map((header) => ({ id: String(header.id), createdAt: toMillis(header.createdAt) }))
    .sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0))

  // --since filters by each session's latest activity (last event time), not
  // its createdAt: a session opened long ago but active an hour ago stays; a
  // freshly created but silent one drops. Walk newest→oldest, grading-window
  // candidates only, and stop once N in-window sessions are found.
  const activityCache = new Map<string, readonly unknown[]>()
  let recent = headers.slice(-parsed.count)
  if (parsed.since !== undefined) {
    const cutoff = Date.now() - parsed.since.ms
    const chosen: { id: string; createdAt: number | null }[] = []
    for (let i = headers.length - 1; i >= 0 && chosen.length < parsed.count; i--) {
      const header = headers[i]!
      let log: { events: readonly unknown[] }
      try {
        log = await seam.readSession(SessionId(header.id))
      } catch (error) {
        return { kind: 'error', text: `Could not read session ${id8(header.id)}: ${error instanceof Error ? error.message : String(error)}` }
      }
      activityCache.set(header.id, log.events)
      const lastActivity = adaptEvents(log.events).reduce((max, event) => Math.max(max, event.time), Number.NEGATIVE_INFINITY)
      if (lastActivity >= cutoff) chosen.unshift(header)
    }
    recent = chosen
  }

  const entries: HistoryEntry[] = []
  for (const header of recent) {
    const cached = activityCache.get(header.id)
    let events: readonly unknown[]
    if (cached !== undefined) {
      events = cached
    } else {
      try {
        const log = await seam.readSession(SessionId(header.id))
        events = log.events
      } catch (error) {
        return { kind: 'error', text: `Could not read session ${id8(header.id)}: ${error instanceof Error ? error.message : String(error)}` }
      }
    }
    const metrics = computeMetrics(header.id, adaptEvents(events))
    entries.push({ sessionId: header.id, createdAt: header.createdAt, metrics, card: gradeSession(metrics, bands) })
  }

  const trend = entries.length >= 2 ? compareSessions(entries[0]!.metrics, entries[entries.length - 1]!.metrics) : null
  const report: HistoryReport = { entries, trend, ...(parsed.since !== undefined ? { sinceLabel: parsed.since.label } : {}) }

  const text = parsed.json
    ? JSON.stringify({ generator: `dsh-session-eval v${VERSION}`, report }, null, 2)
    : renderHistory(report)
  if (parsed.out !== undefined) {
    const path = resolve(typeof ownCwd === 'string' ? ownCwd : process.cwd(), parsed.out)
    try {
      const output = parsed.json ? text : `\`\`\`text\n${text}\n\`\`\``
      await writeFile(path, `${output}\n`, 'utf8')
    } catch (error) {
      return { kind: 'error', text: `Could not write history report to ${path}: ${error instanceof Error ? error.message : String(error)}` }
    }
  }
  return { kind: 'success', text }
}

// gradeIndex is exported for tests that want to assert ordering without depending on render internals.
export { gradeIndex }
