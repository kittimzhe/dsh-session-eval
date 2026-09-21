/**
 * Deterministic metric extraction over projected session events.
 *
 * @module dsh-session-eval/metrics
 */
import type { EvalEvent, EvalEventKind, SessionMetrics } from './types.ts'

/** Count a correction signal for every extra user message inside a consecutive-user run. */
function countCorrections(events: readonly EvalEvent[]): number {
  let corrections = 0
  let runLength = 0
  for (const event of events) {
    if (event.kind === 'user') {
      runLength += 1
      if (runLength >= 2) corrections += 1
    } else {
      runLength = 0
    }
  }
  return corrections
}

/** Compute the deterministic metric set for one session. */
export function computeMetrics(sessionId: string, events: readonly EvalEvent[]): SessionMetrics {
  const userTurns = events.filter((e) => e.kind === 'user').length
  const assistantMessages = events.filter((e) => e.kind === 'assistant').length
  const toolEvents = events.filter((e) => e.kind === 'tool_call')
  const toolResults = events.filter((e) => e.kind === 'tool_result')
  const toolCalls = Math.max(toolEvents.length, toolResults.length)
  const toolErrors = toolResults.filter((e) => e.isError === true).length
  const corrections = countCorrections(events)
  const times = events.map((e) => e.time).filter((t) => Number.isFinite(t))
  const firstTime = times.length > 0 ? Math.min(...times) : null
  const lastTime = times.length > 0 ? Math.max(...times) : null

  return {
    sessionId,
    events: events.length,
    userTurns,
    assistantMessages,
    toolCalls,
    toolErrors,
    toolErrorRate: toolCalls > 0 ? toolErrors / toolCalls : 0,
    corrections,
    correctionRate: userTurns > 0 ? (corrections / userTurns) * 10 : 0,
    toolLoad: userTurns > 0 ? toolCalls / userTurns : 0,
    wallMs: firstTime !== null && lastTime !== null ? lastTime - firstTime : 0,
    firstTime,
    lastTime,
  }
}

/**
 * Project raw session-log events into the evaluation vocabulary.
 *
 * Defensive by design: the adapter matches the `user/message`,
 * `assistant/message`, `tool/call`, `tool/result` event-type vocabulary
 * (plus role-based fallbacks) and never throws — unknown shapes are skipped.
 */
export function adaptEvents(raw: readonly unknown[]): EvalEvent[] {
  const out: EvalEvent[] = []
  for (let i = 0; i < raw.length; i += 1) {
    const event = raw[i] as Record<string, unknown> | null
    if (event == null || typeof event !== 'object') continue
    const seq = typeof event.seq === 'number' ? event.seq : i
    const time = typeof event.time === 'number' ? event.time : 0
    const message = (event.message ?? event.payload) as Record<string, unknown> | undefined
    const typeRaw = String(event.type ?? message?.type ?? '')
    const kind = classify(typeRaw, message)
    if (kind === null) continue
    const isError = readBool(message, 'isError') ?? readBool(message, 'is_error') ?? readBool(event, 'isError')
    const tool = typeof message?.tool === 'string' ? message.tool : typeof message?.name === 'string' ? message.name : undefined
    out.push({ seq, time, kind, tool: kind === 'tool_call' || kind === 'tool_result' ? tool : undefined, isError: kind === 'tool_result' ? isError === true : undefined })
  }
  return out.sort((a, b) => a.seq - b.seq)
}

function classify(type: string, message: Record<string, unknown> | undefined): EvalEventKind | null {
  const t = type.toLowerCase()
  if (t.includes('user/message') || t === 'user') return 'user'
  if (t.includes('assistant/message') || t === 'assistant') return 'assistant'
  if (t.includes('tool/call') || t.includes('tool_call')) return 'tool_call'
  if (t.includes('tool/result') || t.includes('tool_result')) return 'tool_result'
  const role = message?.role
  if (role === 'user') return 'user'
  if (role === 'assistant') return 'assistant'
  return null
}

function readBool(source: Record<string, unknown> | undefined, key: string): boolean | undefined {
  const value = source?.[key]
  return typeof value === 'boolean' ? value : undefined
}
