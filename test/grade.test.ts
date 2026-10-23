import { describe, expect, it } from 'vitest'
import { gradeSession } from '../src/grade.ts'
import { computeMetrics } from '../src/metrics.ts'
import type { EvalEvent } from '../src/types.ts'

function session(events: EvalEvent[]) {
  return gradeSession(computeMetrics('session-xxxx', events))
}

function turn(seqs: [number, number, number, number], errorLast = false): EvalEvent[] {
  const [u, a, c, r] = seqs
  return [
    { seq: u, time: u * 100, kind: 'user' },
    { seq: a, time: a * 100, kind: 'assistant' },
    { seq: c, time: c * 100, kind: 'tool_call', tool: 'bash' },
    { seq: r, time: r * 100, kind: 'tool_result', tool: 'bash', isError: errorLast },
  ]
}

describe('gradeSession', () => {
  it('grades an empty session as all n/a', () => {
    const card = session([])
    expect(card.dimensions.every((d) => d.grade === 'n/a')).toBe(true)
    expect(card.overall).toBe('n/a')
  })

  it('grades a clean session A across dimensions', () => {
    const events = [...turn([1, 2, 3, 4]), ...turn([5, 6, 7, 8]), ...turn([9, 10, 11, 12])]
    const card = session(events)
    expect(card.dimensions.find((d) => d.dimension === 'Reliability')?.grade).toBe('A')
    expect(card.dimensions.find((d) => d.dimension === 'Re-ask')?.grade).toBe('A')
    expect(card.dimensions.find((d) => d.dimension === 'Tool load')?.grade).toBe('A')
    expect(card.overall).toBe('A')
  })

  it('Reliability degrades stepwise with the tool error rate', () => {
    // 5 calls, 1 error = exactly 20% → C band boundary
    const events = [
      ...turn([1, 2, 3, 4], true),
      ...turn([5, 6, 7, 8]),
      ...turn([9, 10, 11, 12]),
      ...turn([13, 14, 15, 16]),
      ...turn([17, 18, 19, 20]),
    ]
    const card = session(events)
    expect(card.dimensions.find((d) => d.dimension === 'Reliability')?.grade).toBe('C')
  })

  it('Re-ask grades corrections per 10 turns', () => {
    // run of 3 users + 2 solo = 2 corrections over 5 turns → 4/10 → D band boundary
    const events: EvalEvent[] = [
      { seq: 1, time: 100, kind: 'user' },
      { seq: 2, time: 200, kind: 'user' },
      { seq: 3, time: 300, kind: 'user' },
      { seq: 4, time: 400, kind: 'assistant' },
      { seq: 5, time: 500, kind: 'user' },
      { seq: 6, time: 600, kind: 'assistant' },
      { seq: 7, time: 700, kind: 'user' },
    ]
    const card = session(events)
    expect(card.dimensions.find((d) => d.dimension === 'Re-ask')?.grade).toBe('D')
  })

  it('Tool load penalizes both extremes', () => {
    // 1 turn, 30 tool calls → churn → D
    const events: EvalEvent[] = [{ seq: 1, time: 100, kind: 'user' }]
    for (let i = 2; i <= 61; i += 1) {
      events.push({ seq: i, time: i * 100, kind: i % 2 === 0 ? 'tool_call' : 'tool_result' })
    }
    const churn = session(events)
    expect(churn.dimensions.find((d) => d.dimension === 'Tool load')?.grade).toBe('D')
  })

  it('overall is the worst graded dimension', () => {
    // clean tools (A) + D-band re-ask + light tooling (B) → overall D
    const events: EvalEvent[] = [
      { seq: 1, time: 100, kind: 'user' },
      { seq: 2, time: 200, kind: 'user' },
      { seq: 3, time: 300, kind: 'assistant' },
      { seq: 4, time: 400, kind: 'user' },
      { seq: 5, time: 500, kind: 'assistant' },
      { seq: 6, time: 600, kind: 'user' },
      { seq: 7, time: 700, kind: 'assistant' },
      { seq: 8, time: 800, kind: 'tool_call', tool: 'bash' },
      { seq: 9, time: 900, kind: 'tool_result', tool: 'bash' },
    ]
    const card = session(events)
    expect(card.overall).toBe('D')
  })
})

describe('gradeSession with custom bands (#1)', () => {
  // 32% tool error rate: default D (<=0.35), custom [4,8,15,30]% → E (>30%)
  it('grades reliability against the configured bands, not the defaults', () => {
    const events: EvalEvent[] = [
      ...Array.from({ length: 25 }, (_, i) => [
        { seq: i * 2, time: i * 10, kind: 'tool_call' as const, tool: 'bash' },
        { seq: i * 2 + 1, time: i * 10 + 1, kind: 'tool_result' as const, tool: 'bash', isError: i < 8 },
      ]).flat(),
    ]
    const m = computeMetrics('session-bands', events)
    const dim = (card: ReturnType<typeof gradeSession>) => card.dimensions.find((d) => d.dimension === 'Reliability')!
    expect(dim(gradeSession(m)).grade).toBe('D')
    expect(dim(gradeSession(m, { reliability: [0.04, 0.08, 0.15, 0.3] })).grade).toBe('E')
    expect(dim(gradeSession(m, { reliability: [0.05, 0.2, 0.4, 0.7] })).grade).toBe('C')
  })

  it('grades tool load against configured bands on both sides', () => {
    const events: EvalEvent[] = [
      { seq: 0, time: 0, kind: 'user' },
      ...Array.from({ length: 10 }, (_, i) => [
        { seq: i * 2 + 1, time: i * 10, kind: 'tool_call' as const, tool: 'bash' },
        { seq: i * 2 + 2, time: i * 10 + 1, kind: 'tool_result' as const, tool: 'bash' },
      ]).flat(),
    ]
    const m = computeMetrics('session-load', events)
    const dim = (card: ReturnType<typeof gradeSession>) => card.dimensions.find((d) => d.dimension === 'Tool load')!
    expect(dim(gradeSession(m)).grade).toBe('C')
    expect(dim(gradeSession(m, { toolLoad: [0.2, 0.6, 4, 8] })).grade).toBe('D')
  })
})
