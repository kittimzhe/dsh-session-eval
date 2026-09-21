import { describe, expect, it } from 'vitest'
import { compareSessions } from '../src/trend.ts'
import { computeMetrics } from '../src/metrics.ts'
import type { EvalEvent } from '../src/types.ts'

function cleanTurn(base: number, error = false): EvalEvent[] {
  return [
    { seq: base, time: base * 100, kind: 'user' },
    { seq: base + 1, time: (base + 1) * 100, kind: 'assistant' },
    { seq: base + 2, time: (base + 2) * 100, kind: 'tool_call', tool: 'bash' },
    { seq: base + 3, time: (base + 3) * 100, kind: 'tool_result', tool: 'bash', isError: error },
  ]
}

describe('compareSessions', () => {
  it('flags regression when the error rate jumps past the noise band', () => {
    const before = computeMetrics('a', [...cleanTurn(1), ...cleanTurn(5), ...cleanTurn(9), ...cleanTurn(13)])
    // after: same 4 turns but 2 of 4 tools error → 12.5pp worse → regressed
    const after = computeMetrics('b', [...cleanTurn(1), ...cleanTurn(5, true), ...cleanTurn(9), ...cleanTurn(13, true)])
    const report = compareSessions(before, after)
    const reliability = report.deltas.find((d) => d.dimension === 'Reliability')
    expect(reliability?.verdict).toBe('regressed')
    expect(report.overall).toBe('regressed')
  })

  it('treats small changes inside the epsilon band as flat', () => {
    // 10 tools: 0 errors vs 1 error = 10pp — above 2pp → regressed.
    // Instead use 50 tools: 1 vs 2 errors = 2pp → flat.
    const mk = (errors: number): EvalEvent[] => {
      const events: EvalEvent[] = []
      let seq = 1
      for (let i = 0; i < 50; i += 1) {
        events.push({ seq: seq++, time: seq * 100, kind: i === 0 ? 'user' : 'assistant' })
        events.push({ seq: seq++, time: seq * 100, kind: 'tool_call', tool: 'bash' })
        events.push({ seq: seq++, time: seq * 100, kind: 'tool_result', tool: 'bash', isError: i < errors })
      }
      return events
    }
    const report = compareSessions(computeMetrics('a', mk(1)), computeMetrics('b', mk(2)))
    expect(report.deltas.find((d) => d.dimension === 'Reliability')?.verdict).toBe('flat')
  })

  it('reports improved when the after session is cleaner', () => {
    const before = computeMetrics('a', [...cleanTurn(1, true), ...cleanTurn(5), ...cleanTurn(9), ...cleanTurn(13)])
    const after = computeMetrics('b', [...cleanTurn(1), ...cleanTurn(5), ...cleanTurn(9), ...cleanTurn(13)])
    const report = compareSessions(before, after)
    expect(report.deltas.find((d) => d.dimension === 'Reliability')?.verdict).toBe('improved')
    expect(report.overall).toBe('improved')
  })

  it('returns an empty-dimension report for two inactive sessions', () => {
    const report = compareSessions(computeMetrics('a', []), computeSessions_empty('b'))
    expect(report.deltas).toHaveLength(0)
    expect(report.overall).toBe('flat')
  })
})

function computeSessions_empty(id: string) {
  return computeMetrics(id, [])
}
