import { mkdtemp, readFile, rm, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
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


describe('history report files', () => {
  it('parses output paths in either flag order and rejects missing or repeated paths', () => {
    expect(parseEvalHistoryArgs('--out report.md 2 --json')).toEqual({ count: 2, json: true, out: 'report.md' })
    expect(parseEvalHistoryArgs('--json 2 --out report.json')).toEqual({ count: 2, json: true, out: 'report.json' })
    for (const input of ['--out', '--out --json', '--out a --out b']) {
      expect(typeof parseEvalHistoryArgs(input)).toBe('string')
    }
  })

  it('writes Markdown relative to session cwd while keeping the terminal card', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'eval-history-'))
    try {
      const headers = HEADERS.slice(1).map((header) => ({ ...header, cwd }))
      const seam = makeSeam(headers, LOGS)
      const result = await executeEvalHistory({} as never, invocation('--out report.md', cwd), seam as never)
      const baseline = await executeEvalHistory({} as never, invocation('', cwd), seam as never)
      expect(result).toEqual(baseline)
      expect(result.kind).toBe('success')
      expect(await readFile(join(cwd, 'report.md'), 'utf8')).toBe(`\`\`\`text\n${(result as { text: string }).text}\n\`\`\`\n`)
      expect((result as { text: string }).text).toContain('Session history — last 3')
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  it('writes the same JSON payload to an absolute path, including empty workspaces', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'eval-history-'))
    try {
      const path = join(cwd, 'report.json')
      const result = await executeEvalHistory({} as never, invocation(`--json --out ${path}`, '/empty'), makeSeam([], {}) as never)
      expect(result.kind).toBe('success')
      const text = (result as { text: string }).text
      expect(await readFile(path, 'utf8')).toBe(`${text}\n`)
      expect(JSON.parse(text).report).toEqual({ entries: [], trend: null })
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  it('returns a useful error without creating missing parent directories', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'eval-history-'))
    try {
      const result = await executeEvalHistory({} as never, invocation('--out missing/report.md', cwd), makeSeam([], {}) as never)
      expect(result.kind).toBe('error')
      expect((result as { text: string }).text).toContain('Could not write history report')
      await expect(access(join(cwd, 'missing'))).rejects.toThrow()
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })
})

describe('/eval-history --since (#2)', () => {
  const at = (time: number, error = false) => [
    { type: 'user/message', seq: 1, time, message: { role: 'user' } },
    { type: 'assistant/message', seq: 2, time: time + 1, message: { role: 'assistant' } },
    { type: 'tool/call', seq: 3, time: time + 2, message: { tool: 'bash' } },
    { type: 'tool/result', seq: 4, time: time + 3, message: { tool: 'bash', isError: error } },
  ]

  it('parses 7d, 24h and 30d and rejects garbage', () => {
    expect(parseEvalHistoryArgs('--since 7d')).toMatchObject({ since: { label: '7d' } })
    expect(parseEvalHistoryArgs('--since 24h')).toMatchObject({ since: { label: '24h' } })
    expect(parseEvalHistoryArgs('--since 30d')).toMatchObject({ since: { label: '30d' } })
    expect(typeof parseEvalHistoryArgs('--since')).toBe('string')
    expect(typeof parseEvalHistoryArgs('--since 7x')).toBe('string')
    expect(typeof parseEvalHistoryArgs('--since -1d')).toBe('string')
    expect(typeof parseEvalHistoryArgs('--since 7d --since 24h')).toBe('string')
  })

  it('grades only sessions whose latest activity is inside the window — not by createdAt', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(T0 + 3 * DAY)
    try {
      const headers: Header[] = [
        // created long ago, but active an hour ago: inside
        { id: 's-old-created-active-now', createdAt: T0 - 5 * DAY, cwd: '/work' },
        // created now, but silent for 10 days: outside
        { id: 's-new-created-silent-10d', createdAt: T0 + 3 * DAY, cwd: '/work' },
        { id: 's-active-now-2', createdAt: T0, cwd: '/work' },
      ]
      const logs = {
        's-old-created-active-now': at(T0 + 3 * DAY - 3_600_000),
        's-new-created-silent-10d': at(T0 - 10 * DAY),
        's-active-now-2': at(T0 + 3 * DAY - 7_200_000),
      }
      const result = await executeEvalHistory({} as never, invocation('--since 24h'), makeSeam(headers, logs) as never)
      expect(result.kind).toBe('success')
      if (result.kind !== 'success') return
      expect(result.text).toContain('s-old-cr')  // id8 truncates session ids
      expect(result.text).toContain('s-active')
      expect(result.text).not.toContain('silent')
    } finally {
      vi.useRealTimers()
    }
  })

  it('prints a clear message when the window matches nothing', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(T0 + 3 * DAY)
    try {
      const result = await executeEvalHistory(
        {} as never,
        invocation('--since 24h'),
        makeSeam([{ id: 's-only', createdAt: T0, cwd: '/work' }], { 's-only': at(T0 - 10 * DAY) }) as never,
      )
      expect(result.kind).toBe('success')
      if (result.kind !== 'success') return
      expect(result.text).toContain('last 24h')
      expect(result.text).not.toContain('Trend')
    } finally {
      vi.useRealTimers()
    }
  })

  it('bounds the result to N in-window sessions', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(T0 + 3 * DAY)
    try {
      const headers: Header[] = [1, 2, 3].map((n) => ({ id: `s-in-${n}`, createdAt: T0 + n * 1000, cwd: '/work' }))
      const logs: Record<string, unknown[]> = Object.fromEntries(headers.map((h) => [h.id, at(T0 + 3 * DAY - h.createdAt % 1000)]))
      const result = await executeEvalHistory({} as never, invocation('2 --since 7d'), makeSeam(headers, logs) as never)
      expect(result.kind).toBe('success')
      if (result.kind !== 'success') return
      expect(result.text).toContain('last 2')
    } finally {
      vi.useRealTimers()
    }
  })
})
