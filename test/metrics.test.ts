import { describe, expect, it } from 'vitest'
import { adaptEvents, computeMetrics } from '../src/metrics.ts'
import type { EvalEvent } from '../src/types.ts'

function e(seq: number, kind: EvalEvent['kind'], extra: Partial<EvalEvent> = {}): EvalEvent {
  return { seq, time: 1_000 + seq * 1_000, kind, ...extra }
}

describe('computeMetrics', () => {
  it('computes empty-session metrics safely', () => {
    const m = computeMetrics('s1', [])
    expect(m.events).toBe(0)
    expect(m.userTurns).toBe(0)
    expect(m.toolErrorRate).toBe(0)
    expect(m.firstTime).toBeNull()
    expect(m.wallMs).toBe(0)
  })

  it('counts turns, tools, and error rate', () => {
    const events = [
      e(1, 'user'),
      e(2, 'assistant'),
      e(3, 'tool_call', { tool: 'bash' }),
      e(4, 'tool_result', { tool: 'bash' }),
      e(5, 'tool_result', { tool: 'read', isError: true }),
      e(6, 'user'),
      e(7, 'assistant'),
    ]
    const m = computeMetrics('s1', events)
    expect(m.userTurns).toBe(2)
    expect(m.assistantMessages).toBe(2)
    expect(m.toolCalls).toBe(2)
    expect(m.toolErrors).toBe(1)
    expect(m.toolErrorRate).toBeCloseTo(0.5)
    expect(m.corrections).toBe(0)
    expect(m.toolLoad).toBe(1)
    expect(m.wallMs).toBe(6_000)
  })

  it('counts a correction for each extra message in a consecutive-user run', () => {
    const events = [
      e(1, 'user'),
      e(2, 'user'), // correction 1 (re-ask)
      e(3, 'user'), // correction 2
      e(4, 'assistant'),
      e(5, 'user'),
      e(6, 'user'), // correction 3
      e(7, 'assistant'),
      e(8, 'user'),
    ]
    const m = computeMetrics('s1', events)
    expect(m.userTurns).toBe(6)
    expect(m.corrections).toBe(3)
    expect(m.correctionRate).toBeCloseTo(5)
  })

  it('tool calls without results still count (and vice versa)', () => {
    const m = computeMetrics('s1', [e(1, 'user'), e(2, 'tool_call', { tool: 'bash' })])
    expect(m.toolCalls).toBe(1)
    expect(m.toolErrors).toBe(0)
  })
})

describe('adaptEvents', () => {
  it('projects the session event vocabulary and sorts by seq', () => {
    const raw = [
      { type: 'user/message', seq: 2, time: 2_000, message: { role: 'user' } },
      { type: 'tool/result', seq: 3, time: 3_000, message: { tool: 'bash', isError: true } },
      { type: 'assistant/message', seq: 1, time: 1_000, message: { role: 'assistant' } },
      { type: 'tool/call', seq: 4, time: 4_000, message: { tool: 'bash' } },
    ]
    const events = adaptEvents(raw)
    expect(events.map((x) => x.seq)).toEqual([1, 2, 3, 4])
    expect(events[1]?.kind).toBe('user')
    expect(events[2]?.isError).toBe(true)
    expect(events[3]?.kind).toBe('tool_call')
  })

  it('skips unknown shapes and never throws', () => {
    const events = adaptEvents([null, { type: 'system/heartbeat' }, { message: { role: 'user' } }, 'nonsense'])
    expect(events).toHaveLength(1)
    expect(events[0]?.kind).toBe('user')
  })

  it('reads snake_case is_error as an error flag', () => {
    const events = adaptEvents([{ type: 'tool/result', seq: 1, time: 1, message: { tool: 'bash', is_error: true } }])
    expect(events[0]?.isError).toBe(true)
  })
})
