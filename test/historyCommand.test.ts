import { describe, expect, it } from 'vitest'
import { executeEvalHistory, parseEvalHistoryArgs, renderHistory } from '../src/historyCommand.ts'
import { VERSION } from '../src/version.ts'

const turn = (base: number, error = false) => [
  { type: 'user/message', seq: base, time: base * 100, message: { role: 'user' } },
  { type: 'assistant/message', seq: base + 1, time: (base + 1) * 100, message: { role: 'assistant' } },
  { type: 'tool/call', seq: base + 2, time: (base + 2) * 100, message: { tool: 'bash' } },
  { type: 'tool/result', seq: base + 3, time: (base + 3) * 100, message: { tool: 'bash', isError: error } },
]

interface Header {
  id: string
  createdAt: number
  cwd?: string
}

function makeSeam(headers: Header[], logs: Record<string, unknown[]>) {
  return {
    async listSessions() {
      return headers.map((header) => ({ header }))
    },
    async readSession(id: { toString(): string }) {
      const key = String(id)
      if (!(key in logs)) throw new Error('session not found')
      return { events: logs[key] }
    },
  }
}

const invocation = (rawInput: string, cwd?: string) => ({
  rawInput,
  agent: { session: { id: 'current-session', ...(cwd !== undefined ? { header: { cwd } } : {}) } },
}) as never

const DAY = 86_400_000
const T0 = Date.UTC(2026, 8, 20) // 2026-09-20

const HEADERS: Header[] = [
  { id: 's-old-other', createdAt: T0 - 3 * DAY, cwd: '/other/project' },
  { id: 's-first', createdAt: T0, cwd: '/work' },
  { id: 's-mid', createdAt: T0 + DAY, cwd: '/work' },
  { id: 's-last', createdAt: T0 + 2 * DAY, cwd: '/work' },
]

const LOGS: Record<string, unknown[]> = {
  // first session: one clean turn, one errored turn (Reliability B-ish)
  's-first': [...turn(1), ...turn(5, true)],
  // mid: clean
  's-mid': [...turn(1), ...turn(5)],
  // last: clean, fewer re-asks than first
  's-last': [...turn(1), ...turn(5)],
}

describe('parseEvalHistoryArgs', () => {
  it('defaults to 5 sessions, no json', () => {
    expect(parseEvalHistoryArgs('')).toEqual({ count: 5, json: false })
  })

  it('accepts a count and --json in any order', () => {
    expect(parseEvalHistoryArgs('3 --json')).toEqual({ count: 3, json: true })
    expect(parseEvalHistoryArgs('--json 3')).toEqual({ count: 3, json: true })
  })

  it('rejects out-of-range counts, non-numbers, duplicates and unknown flags', () => {
    expect(typeof parseEvalHistoryArgs('0')).toBe('string')
    expect(typeof parseEvalHistoryArgs('21')).toBe('string')
    expect(typeof parseEvalHistoryArgs('x')).toBe('string')
    expect(typeof parseEvalHistoryArgs('3 4')).toBe('string')
    expect(typeof parseEvalHistoryArgs('--bogus')).toBe('string')
    expect(typeof parseEvalHistoryArgs('--json --json')).toBe('string')
  })
})

describe('executeEvalHistory', () => {
  it('filters by the current session cwd and grades the recent window', async () => {
    const seam = makeSeam(HEADERS, LOGS)
    const result = await executeEvalHistory({} as never, invocation('', '/work'), seam as never)
    expect(result.kind).toBe('success')
    const text = (result as { text: string }).text
    expect(text).toContain('last 3 in this workspace')
    expect(text).toContain('s-first'.slice(0, 8))
    expect(text).toContain('s-last'.slice(0, 8))
    expect(text).not.toContain('s-old-oth')
    expect(text).toContain('Trend (first → last)')
  })

  it('honors an explicit count smaller than the available sessions', async () => {
    const seam = makeSeam(HEADERS, LOGS)
    const result = await executeEvalHistory({} as never, invocation('2', '/work'), seam as never)
    const text = (result as { text: string }).text
    expect(text).toContain('last 2 in this workspace')
    expect(text).not.toContain('s-first'.slice(0, 8))
  })

  it('skips the cwd filter when the current session has no header', async () => {
    const seam = makeSeam(HEADERS, LOGS)
    const result = await executeEvalHistory({} as never, invocation('2'), seam as never)
    const text = (result as { text: string }).text
    expect(text).toContain('s-last'.slice(0, 8))
  })

  it('reports empty workspaces without erroring', async () => {
    const seam = makeSeam([{ id: 's-elsewhere', createdAt: T0, cwd: '/other' }], { elsewhere: [] })
    const result = await executeEvalHistory({} as never, invocation('', '/work'), seam as never)
    expect(result.kind).toBe('success')
    expect((result as { text: string }).text).toContain('No sessions found')
  })

  it('emits machine-readable json with the versioned generator and trend', async () => {
    const seam = makeSeam(HEADERS, LOGS)
    const result = await executeEvalHistory({} as never, invocation('--json', '/work'), seam as never)
    const parsed = JSON.parse((result as { text: string }).text)
    expect(parsed.generator).toBe(`dsh-session-eval v${VERSION}`)
    expect(parsed.report.entries).toHaveLength(3)
    expect(parsed.report.entries[0].sessionId).toBe('s-first')
    expect(parsed.report.trend.overall).toBe('improved')
  })

  it('omits the trend for a single session', async () => {
    const seam = makeSeam([HEADERS[2]!], LOGS)
    const result = await executeEvalHistory({} as never, invocation('1 --json', '/work'), seam as never)
    const parsed = JSON.parse((result as { text: string }).text)
    expect(parsed.report.entries).toHaveLength(1)
    expect(parsed.report.trend).toBeNull()
  })

  it('surfaces listSessions failures as errors', async () => {
    const seam = {
      async listSessions() {
        throw new Error('backend down')
      },
      async readSession() {
        return { events: [] }
      },
    }
    const result = await executeEvalHistory({} as never, invocation('', '/work'), seam as never)
    expect(result.kind).toBe('error')
    expect((result as { text: string }).text).toContain('Could not list sessions')
  })
})

describe('renderHistory', () => {
  it('renders a friendly line for empty input', () => {
    expect(renderHistory({ entries: [], trend: null })).toContain('No sessions found')
  })
})
