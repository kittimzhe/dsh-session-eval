import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { executeEvalBaseline, parseEvalBaselineArgs, EVAL_BASELINE_USAGE } from '../src/baselineCommand.ts'
import { bandsFingerprint, loadBaselineRecords, resolveBaselinePath } from '../src/baseline.ts'
import { DEFAULT_GRADE_BANDS } from '../src/grade.ts'
import { VERSION } from '../src/version.ts'

const turn = (base: number, error = false) => [
  { type: 'user/message', seq: base, time: base * 100, message: { role: 'user' } },
  { type: 'assistant/message', seq: base + 1, time: (base + 1) * 100, message: { role: 'assistant' } },
  { type: 'tool/call', seq: base + 2, time: (base + 2) * 100, message: { tool: 'bash' } },
  { type: 'tool/result', seq: base + 3, time: (base + 3) * 100, message: { tool: 'bash', isError: error } },
]

function makeSeam(logs: Record<string, unknown[]>, version?: number) {
  return {
    async readSession(id: { toString(): string }) {
      const key = String(id)
      if (!(key in logs)) throw new Error('session not found')
      return { events: logs[key]!, ...(version !== undefined ? { session: { version } } : {}) }
    },
  }
}

const invocation = (rawInput: string, cwd?: string) => ({
  rawInput,
  agent: { session: { id: 'current-session', ...(cwd !== undefined ? { header: { cwd } } : {}) } },
}) as never

async function tempCwd(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'eval-baseline-cmd-'))
}

describe('parseEvalBaselineArgs', () => {
  it('parses the four subcommands with their defaults', () => {
    expect(parseEvalBaselineArgs('set')).toEqual({ action: 'set' })
    expect(parseEvalBaselineArgs('set --id abc')).toEqual({ action: 'set', sessionId: 'abc' })
    expect(parseEvalBaselineArgs('compare')).toEqual({ action: 'compare' })
    expect(parseEvalBaselineArgs('compare --id abc')).toEqual({ action: 'compare', sessionId: 'abc' })
    expect(parseEvalBaselineArgs('list')).toEqual({ action: 'list', count: 5 })
    expect(parseEvalBaselineArgs('list 3')).toEqual({ action: 'list', count: 3 })
    expect(parseEvalBaselineArgs('clear')).toEqual({ action: 'clear' })
  })

  it('rejects a missing or unknown subcommand and trailing junk', () => {
    expect(parseEvalBaselineArgs('')).toBe(`Expected a subcommand: set, compare, list, or clear.\n${EVAL_BASELINE_USAGE}`)
    expect(typeof parseEvalBaselineArgs('bogus')).toBe('string')
    expect(typeof parseEvalBaselineArgs('clear extra')).toBe('string')
  })

  it('rejects bad --id usage and bad counts in the command style', () => {
    expect(parseEvalBaselineArgs('set --id')).toBe(`--id requires a session id value.\n${EVAL_BASELINE_USAGE}`)
    expect(parseEvalBaselineArgs('set --id a --id b')).toBe(`--id may be given only once.\n${EVAL_BASELINE_USAGE}`)
    expect(typeof parseEvalBaselineArgs('set --bogus')).toBe('string')
    expect(typeof parseEvalBaselineArgs('compare --id --json')).toBe('string')
    expect(parseEvalBaselineArgs('list 0')).toBe(`N must be between 1 and 20.\n${EVAL_BASELINE_USAGE}`)
    expect(parseEvalBaselineArgs('list 21')).toBe(`N must be between 1 and 20.\n${EVAL_BASELINE_USAGE}`)
    expect(parseEvalBaselineArgs('list x')).toBe(`N must be a positive integer.\n${EVAL_BASELINE_USAGE}`)
    expect(parseEvalBaselineArgs('list 2 3')).toBe(`Expected at most one count argument.\n${EVAL_BASELINE_USAGE}`)
    expect(typeof parseEvalBaselineArgs('list --json')).toBe('string')
  })
})

describe('/eval-baseline set', () => {
  it('grades the current session and writes one record', async () => {
    const cwd = await tempCwd()
    try {
      const seam = makeSeam({ 'current-session': [...turn(1), ...turn(5, true)] }, 3)
      const result = await executeEvalBaseline({} as never, invocation('set', cwd), seam as never)
      expect(result.kind).toBe('success')
      const text = (result as { text: string }).text
      expect(text).toContain('Baseline saved')
      expect(text).toContain('current-…')
      expect(text).toContain(`dsh-session-eval v${VERSION}`)
      expect(text).toContain('session format v3')
      expect(text).toContain(resolveBaselinePath(cwd))

      const load = await loadBaselineRecords(resolveBaselinePath(cwd))
      expect(load.records).toHaveLength(1)
      const record = load.records[0]!
      expect(record.sessionId).toBe('current-session')
      expect(record.source).toBe('set')
      expect(record.generator).toBe(`dsh-session-eval v${VERSION}`)
      expect(record.sessionFormatVersion).toBe(3)
      expect(record.card.overall).toBeTruthy()
      expect(record.metrics.toolCalls).toBe(2)
      expect(record.metrics.toolErrors).toBe(1)
      expect(record.bandsFingerprint).toBe(bandsFingerprint(DEFAULT_GRADE_BANDS))
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  it('honors --id and records null when the header carries no version', async () => {
    const cwd = await tempCwd()
    try {
      const seam = makeSeam({ 'other-session': [...turn(1)] }) // no header version
      const result = await executeEvalBaseline({} as never, invocation('set --id other-session', cwd), seam as never)
      expect(result.kind).toBe('success')
      expect((result as { text: string }).text).toContain('session format unknown')
      const record = (await loadBaselineRecords(resolveBaselinePath(cwd))).records[0]!
      expect(record.sessionId).toBe('other-session')
      expect(record.sessionFormatVersion).toBeNull()
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  it('adds the zero-projection note when the log projects to nothing', async () => {
    const cwd = await tempCwd()
    try {
      // Non-empty raw log, but nothing the evaluation vocabulary understands.
      const seam = makeSeam({ 'current-session': [{ type: 'system/heartbeat', seq: 1, time: 1 }, { type: 'system/heartbeat', seq: 2, time: 2 }] }, 3)
      const result = await executeEvalBaseline({} as never, invocation('set', cwd), seam as never)
      expect(result.kind).toBe('success')
      const record = (await loadBaselineRecords(resolveBaselinePath(cwd))).records[0]!
      expect(record.card.notes.join(' ')).toContain('Projected 0 events from a non-empty log')
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  it('surfaces seam read errors without writing a record', async () => {
    const cwd = await tempCwd()
    try {
      const seam = makeSeam({})
      const result = await executeEvalBaseline({} as never, invocation('set', cwd), seam as never)
      expect(result.kind).toBe('error')
      expect((result as { text: string }).text).toContain('Could not read session')
      const load = await loadBaselineRecords(resolveBaselinePath(cwd))
      expect(load.exists).toBe(false)
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })
})

describe('/eval-baseline compare', () => {
  const logs = {
    // baseline: 2/2 tools error; current: 0/2 → 100pp better, above the 2pp band
    baseline: [...turn(1, true), ...turn(5, true)],
    current: [...turn(1), ...turn(5)],
  }

  it('compares against the latest baseline with the /eval-diff noise bands', async () => {
    const cwd = await tempCwd()
    try {
      const seam = makeSeam(logs, 3)
      await executeEvalBaseline({} as never, invocation('set --id baseline', cwd), seam as never)
      const result = await executeEvalBaseline({} as never, invocation('compare --id current', cwd), seam as never)
      expect(result.kind).toBe('success')
      const text = (result as { text: string }).text
      expect(text).toContain('Baseline comparison')
      expect(text).toContain('Overall: improved')
      expect(text).toContain('Reliability')
      // Signed delta vs the baseline, in percentage points.
      expect(text).toMatch(/-100\.0pp/)
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  it('treats sub-noise differences as flat (noise bands reused, not reimplemented)', async () => {
    const cwd = await tempCwd()
    try {
      // 50 tools with 1 vs 2 errors = 2pp — inside the ±2pp epsilon band.
      const noisy = (errors: number): unknown[] => {
        const events: unknown[] = []
        let seq = 1
        for (let i = 0; i < 50; i += 1) {
          events.push({ type: 'user/message', seq: seq++, time: seq * 100, message: { role: 'user' } })
          events.push({ type: 'tool/call', seq: seq++, time: seq * 100, message: { tool: 'bash' } })
          events.push({ type: 'tool/result', seq: seq++, time: seq * 100, message: { tool: 'bash', isError: i < errors } })
        }
        return events
      }
      const seam = makeSeam({ baseline: noisy(1), current: noisy(2) }, 3)
      await executeEvalBaseline({} as never, invocation('set --id baseline', cwd), seam as never)
      const result = await executeEvalBaseline({} as never, invocation('compare --id current', cwd), seam as never)
      const text = (result as { text: string }).text
      // +2.0pp is printed but stays inside the band: the verdict is flat.
      expect(text).toMatch(/\+2\.0pp/)
      expect(text).toContain('Overall: flat')
      expect(text).not.toContain('Overall: regressed')
      expect(text).not.toContain('Overall: improved')
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  it('stays silent when generator, fingerprint and format version all match', async () => {
    const cwd = await tempCwd()
    try {
      const seam = makeSeam(logs, 3)
      await executeEvalBaseline({} as never, invocation('set --id baseline', cwd), seam as never)
      const result = await executeEvalBaseline({} as never, invocation('compare --id current', cwd), seam as never)
      expect((result as { text: string }).text).not.toContain('comparison crosses versions')
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  it('warns when the recorded generator or fingerprint differs', async () => {
    const cwd = await tempCwd()
    try {
      const seam = makeSeam(logs, 3)
      await executeEvalBaseline({} as never, invocation('set --id baseline', cwd), seam as never)
      const storePath = resolveBaselinePath(cwd)
      const raw = await readFile(storePath, 'utf8')

      // Different bands fingerprint in the store: current run grades with the
      // defaults, the record claims another set.
      await rm(storePath)
      await writeFile(storePath, raw.replace(/"bandsFingerprint":"[0-9a-f]{16}"/, '"bandsFingerprint":"deadbeefdeadbeef"'), 'utf8')
      const fpResult = await executeEvalBaseline({} as never, invocation('compare --id current', cwd), seam as never)
      const fpText = (fpResult as { text: string }).text
      expect(fpText).toContain('bands deadbeefdeadbeef')
      expect(fpText).toContain('comparison crosses versions')

      // Different generator stamp in the store.
      await rm(storePath)
      await writeFile(storePath, raw.replace(`dsh-session-eval v${VERSION}`, 'dsh-session-eval v0.3.0'), 'utf8')
      const genResult = await executeEvalBaseline({} as never, invocation('compare --id current', cwd), seam as never)
      const genText = (genResult as { text: string }).text
      expect(genText).toContain('baseline recorded under dsh-session-eval v0.3.0')
      expect(genText).toContain('comparison crosses versions')
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  it('warns when the recorded session format version differs from the header', async () => {
    const cwd = await tempCwd()
    try {
      // Record written while the header said v2; compare reads a v3 log.
      const seamV2 = makeSeam(logs, 2)
      await executeEvalBaseline({} as never, invocation('set --id baseline', cwd), seamV2 as never)
      const seamV3 = makeSeam(logs, 3)
      const result = await executeEvalBaseline({} as never, invocation('compare --id current', cwd), seamV3 as never)
      const text = (result as { text: string }).text
      expect(text).toContain('format v2')
      expect(text).toContain('format v3')
      expect(text).toContain('comparison crosses versions')
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  it('errors with guidance when no baseline exists', async () => {
    const cwd = await tempCwd()
    try {
      const seam = makeSeam(logs, 3)
      const result = await executeEvalBaseline({} as never, invocation('compare', cwd), seam as never)
      expect(result.kind).toBe('error')
      expect((result as { text: string }).text).toContain('No baseline recorded yet')
      expect((result as { text: string }).text).toContain('/eval-baseline set')
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  it('adds a note when the compared log projects to nothing', async () => {
    const cwd = await tempCwd()
    try {
      const seam = makeSeam({ baseline: [...turn(1)], drifted: [{ type: 'unknown/kind', seq: 1, time: 1 }] }, 3)
      await executeEvalBaseline({} as never, invocation('set --id baseline', cwd), seam as never)
      const result = await executeEvalBaseline({} as never, invocation('compare --id drifted', cwd), seam as never)
      expect(result.kind).toBe('success')
      expect((result as { text: string }).text).toContain('Projected 0 events from a non-empty log')
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })
})

describe('/eval-baseline list', () => {
  it('lists records newest first with date, id, Overall and generator', async () => {
    const cwd = await tempCwd()
    try {
      const seam = makeSeam({ s1: [...turn(1)], s2: [...turn(5, true)], s3: [...turn(9)] }, 3)
      await executeEvalBaseline({} as never, invocation('set --id s1', cwd), seam as never)
      await executeEvalBaseline({} as never, invocation('set --id s2', cwd), seam as never)
      await executeEvalBaseline({} as never, invocation('set --id s3', cwd), seam as never)
      const result = await executeEvalBaseline({} as never, invocation('list', cwd), seam as never)
      expect(result.kind).toBe('success')
      const lines = (result as { text: string }).text.split('\n')
      expect(lines[0]).toContain('3 stored, showing 3 (newest first)')
      expect(lines[1]).toContain('s3')
      expect(lines[3]).toContain('s1')
      expect((result as { text: string }).text).toContain(`dsh-session-eval v${VERSION}`)
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  it('honors N and greets an empty store', async () => {
    const cwd = await tempCwd()
    try {
      const seam = makeSeam({ s1: [...turn(1)], s2: [...turn(5)], s3: [...turn(9)] }, 3)
      await executeEvalBaseline({} as never, invocation('set --id s1', cwd), seam as never)
      await executeEvalBaseline({} as never, invocation('set --id s2', cwd), seam as never)
      await executeEvalBaseline({} as never, invocation('set --id s3', cwd), seam as never)
      const two = (await executeEvalBaseline({} as never, invocation('list 2', cwd), seam as never)) as { text: string }
      expect(two.text).toContain('3 stored, showing 2')
      expect(two.text).not.toContain('  s1 ')

      const empty = await tempCwd()
      try {
        const fresh = (await executeEvalBaseline({} as never, invocation('list', empty), seam as never)) as { text: string }
        expect(fresh.text).toContain('No baseline records yet')
      } finally {
        await rm(empty, { recursive: true, force: true })
      }
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })
})

describe('/eval-baseline clear', () => {
  it('counts records, then deletes the store', async () => {
    const cwd = await tempCwd()
    try {
      const seam = makeSeam({ s1: [...turn(1)] }, 3)
      await executeEvalBaseline({} as never, invocation('set --id s1', cwd), seam as never)
      await executeEvalBaseline({} as never, invocation('set --id s1', cwd), seam as never)
      const result = (await executeEvalBaseline({} as never, invocation('clear', cwd), seam as never)) as { text: string }
      expect(result.text).toContain('deleted 2 record(s)')
      const load = await loadBaselineRecords(resolveBaselinePath(cwd))
      expect(load.exists).toBe(false)
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  it('is a friendly no-op when no store exists', async () => {
    const cwd = await tempCwd()
    try {
      const seam = makeSeam({}, 3)
      const result = await executeEvalBaseline({} as never, invocation('clear', cwd), seam as never)
      expect(result.kind).toBe('success')
      expect((result as { text: string }).text).toContain('nothing to clear')
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  it('mentions the bad lines it removed along with the records', async () => {
    const cwd = await tempCwd()
    try {
      const storePath = resolveBaselinePath(cwd)
      const seam = makeSeam({ s1: [...turn(1)] }, 3)
      await executeEvalBaseline({} as never, invocation('set --id s1', cwd), seam as never)
      const raw = await readFile(storePath, 'utf8')
      await rm(storePath)
      await writeFile(storePath, `${raw}garbage line\n`, 'utf8')
      const result = (await executeEvalBaseline({} as never, invocation('clear', cwd), seam as never)) as { text: string }
      expect(result.text).toContain('deleted 1 record(s)')
      expect(result.text).toContain('1 unparseable line(s)')
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })
})
