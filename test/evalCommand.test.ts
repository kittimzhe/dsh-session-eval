import { describe, expect, it } from 'vitest'
import { executeEval, executeEvalDiff, parseEvalArgs, parseEvalDiffArgs, renderCard, renderTrend, id8 } from '../src/evalCommand.ts'

const cleanTurn = (base: number, error = false) => [
  { type: 'user/message', seq: base, time: base * 100, message: { role: 'user' } },
  { type: 'assistant/message', seq: base + 1, time: (base + 1) * 100, message: { role: 'assistant' } },
  { type: 'tool/call', seq: base + 2, time: (base + 2) * 100, message: { tool: 'bash' } },
  { type: 'tool/result', seq: base + 3, time: (base + 3) * 100, message: { tool: 'bash', isError: error } },
]

function makeSeam(logs: Record<string, unknown[]>) {
  return {
    async readSession(id: { toString(): string }) {
      const key = String(id)
      if (!(key in logs)) throw new Error('session not found')
      return { events: logs[key] }
    },
  }
}

const invocation = (rawInput: string) => ({
  rawInput,
  agent: { session: { id: 'current-session' } },
}) as never

describe('parseEvalArgs', () => {
  it('parses flags and rejects unknowns', () => {
    expect(parseEvalArgs('')).toEqual({})
    expect(parseEvalArgs('--id abc --json')).toEqual({ sessionId: 'abc', json: true })
    expect(typeof parseEvalArgs('--id')).toBe('string')
    expect(typeof parseEvalArgs('--bogus')).toBe('string')
  })
})

describe('parseEvalDiffArgs', () => {
  it('requires exactly two distinct ids', () => {
    expect(parseEvalDiffArgs('a b')).toEqual({ beforeId: 'a', afterId: 'b', json: false })
    expect(typeof parseEvalDiffArgs('a')).toBe('string')
    expect(typeof parseEvalDiffArgs('a a')).toBe('string')
    expect(parseEvalDiffArgs('a b --json')).toEqual({ beforeId: 'a', afterId: 'b', json: true })
  })
})

describe('executeEval', () => {
  const seam = makeSeam({ 'current-session': [...cleanTurn(1), ...cleanTurn(5)] })

  it('grades the current session by default', async () => {
    const result = await executeEval({} as never, invocation(''), seam as never)
    expect(result.kind).toBe('success')
    const text = (result as { text: string }).text
    expect(text).toContain('Overall: A')
    expect(text).toContain('Reliability')
    expect(id8('current-session')).toBe('current-…')
  })

  it('emits machine-readable json on demand', async () => {
    const result = await executeEval({} as never, invocation('--json'), seam as never)
    const parsed = JSON.parse((result as { text: string }).text)
    expect(parsed.card.overall).toBe('A')
    expect(parsed.metrics.toolCalls).toBe(2)
  })

  it('surfaces read errors', async () => {
    const result = await executeEval({} as never, invocation('--id missing'), seam as never)
    expect(result.kind).toBe('error')
  })
})

describe('executeEvalDiff', () => {
  it('compares two sessions end to end', async () => {
    const seam = makeSeam({
      a: [...cleanTurn(1), ...cleanTurn(5), ...cleanTurn(9), ...cleanTurn(13)],
      b: [...cleanTurn(1, true), ...cleanTurn(5, true), ...cleanTurn(9), ...cleanTurn(13)],
    })
    const result = await executeEvalDiff({} as never, invocation('a b'), seam as never)
    expect(result.kind).toBe('success')
    const text = (result as { text: string }).text
    expect(text).toContain('regressed')
    expect(text).toContain('→')
  })
})

describe('renderers', () => {
  it('renderCard and renderTrend produce stable one-line-per-dimension text', async () => {
    const seam = makeSeam({ a: cleanTurn(1), b: cleanTurn(5, true) })
    const ok = (await executeEval({} as never, invocation('--id a'), seam as never)) as { text: string }
    expect(renderCard.length).toBeGreaterThan(0)
    expect(ok.text.split('\n').length).toBeGreaterThanOrEqual(4)
    const diff = (await executeEvalDiff({} as never, invocation('a b'), seam as never)) as { text: string }
    expect(diff.text).toContain('Session diff')
    expect(typeof renderTrend).toBe('function')
  })
})
