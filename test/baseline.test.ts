import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  appendBaselineRecord,
  bandsFingerprint,
  BASELINE_DIR,
  BASELINE_FILE,
  buildBaselineRecord,
  effectiveBands,
  latestBaseline,
  loadBaselineRecords,
  nodeBaselineIo,
  resolveBaselinePath,
} from '../src/baseline.ts'
import { computeMetrics, adaptEvents } from '../src/metrics.ts'
import { DEFAULT_GRADE_BANDS, gradeSession } from '../src/grade.ts'
import { VERSION } from '../src/version.ts'
import type { SessionMetrics } from '../src/types.ts'

const turn = (base: number, error = false) => [
  { type: 'user/message', seq: base, time: base * 100, message: { role: 'user' } },
  { type: 'assistant/message', seq: base + 1, time: (base + 1) * 100, message: { role: 'assistant' } },
  { type: 'tool/call', seq: base + 2, time: (base + 2) * 100, message: { tool: 'bash' } },
  { type: 'tool/result', seq: base + 3, time: (base + 3) * 100, message: { tool: 'bash', isError: error } },
]

function metricsFor(sessionId: string, errors = false): SessionMetrics {
  return computeMetrics(sessionId, adaptEvents([...turn(1), ...turn(5, errors)]))
}

describe('resolveBaselinePath', () => {
  it('puts the store under <cwd>/.dsh-evals/baseline.jsonl', () => {
    expect(resolveBaselinePath('/proj')).toBe(join('/proj', BASELINE_DIR, BASELINE_FILE))
    expect(BASELINE_DIR).toBe('.dsh-evals')
    expect(BASELINE_FILE).toBe('baseline.jsonl')
  })
})

describe('bandsFingerprint', () => {
  it('is a stable 16-hex fingerprint that moves when bands move', () => {
    const fp = bandsFingerprint(DEFAULT_GRADE_BANDS)
    expect(fp).toMatch(/^[0-9a-f]{16}$/)
    // Identical values in a fresh object must hash the same.
    expect(bandsFingerprint({ ...DEFAULT_GRADE_BANDS, reask: [0, 1, 2, 4] })).toBe(fp)
    expect(bandsFingerprint(effectiveBands({ reask: [0, 2, 4, 9] }))).not.toBe(fp)
  })

  it('hashes exactly sha256({v: VERSION, bands}) truncated to 16 hex', () => {
    // The formula is the contract: recompute it independently here.
    const expected = createHash('sha256').update(JSON.stringify({ v: VERSION, bands: DEFAULT_GRADE_BANDS })).digest('hex').slice(0, 16)
    expect(bandsFingerprint(DEFAULT_GRADE_BANDS)).toBe(expected)
    expect(expected).not.toContain(VERSION) // hashed, not a literal
  })
})

describe('buildBaselineRecord', () => {
  it('fills generator, fingerprint, source and the given stamps', () => {
    const metrics = metricsFor('s1')
    const card = gradeSession(metrics)
    const record = buildBaselineRecord({ sessionId: 's1', sessionFormatVersion: 3, metrics, card, bands: DEFAULT_GRADE_BANDS, at: '2026-11-25T08:00:00.000Z' })
    expect(record).toMatchObject({
      at: '2026-11-25T08:00:00.000Z',
      sessionId: 's1',
      generator: `dsh-session-eval v${VERSION}`,
      sessionFormatVersion: 3,
      bandsFingerprint: bandsFingerprint(DEFAULT_GRADE_BANDS),
      source: 'set',
    })
    expect(record.metrics).toEqual(metrics)
    expect(record.card).toEqual(card)
  })

  it('defaults at to now and keeps the format version nullable', () => {
    const metrics = metricsFor('s2')
    const record = buildBaselineRecord({ sessionId: 's2', sessionFormatVersion: null, metrics, card: gradeSession(metrics), bands: DEFAULT_GRADE_BANDS })
    expect(Number.isFinite(Date.parse(record.at))).toBe(true)
    expect(record.sessionFormatVersion).toBeNull()
  })
})

describe('append/load round-trip (real filesystem)', () => {
  it('appends records and loads them back in order', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'eval-baseline-'))
    try {
      const path = resolveBaselinePath(cwd)
      const m1 = metricsFor('s1')
      const m2 = computeMetrics('s2', adaptEvents([...turn(1, true), ...turn(5, true)]))
      await appendBaselineRecord(path, buildBaselineRecord({ sessionId: 's1', sessionFormatVersion: 3, metrics: m1, card: gradeSession(m1), bands: DEFAULT_GRADE_BANDS, at: '2026-11-25T08:00:00.000Z' }), nodeBaselineIo)
      await appendBaselineRecord(path, buildBaselineRecord({ sessionId: 's2', sessionFormatVersion: 2, metrics: m2, card: gradeSession(m2), bands: DEFAULT_GRADE_BANDS, at: '2026-11-25T09:00:00.000Z' }), nodeBaselineIo)

      const load = await loadBaselineRecords(path, nodeBaselineIo)
      expect(load.exists).toBe(true)
      expect(load.badLines).toBe(0)
      expect(load.records.map((r) => r.sessionId)).toEqual(['s1', 's2'])
      expect(load.records[0]!.metrics).toEqual(m1)
      expect(load.records[1]!.sessionFormatVersion).toBe(2)
      // The store is exactly one JSON line per record.
      const lines = (await readFile(path, 'utf8')).split('\n').filter((l) => l.trim() !== '')
      expect(lines).toHaveLength(2)
      expect(() => JSON.parse(lines[0]!)).not.toThrow()
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  it('creates the store directory on first write', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'eval-baseline-'))
    try {
      const path = resolveBaselinePath(cwd)
      const m = metricsFor('s1')
      await appendBaselineRecord(path, buildBaselineRecord({ sessionId: 's1', sessionFormatVersion: null, metrics: m, card: gradeSession(m), bands: DEFAULT_GRADE_BANDS }), nodeBaselineIo)
      const load = await loadBaselineRecords(path, nodeBaselineIo)
      expect(load.exists).toBe(true)
      expect(load.records).toHaveLength(1)
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })
})

describe('loadBaselineRecords tolerance', () => {
  it('reports a missing file as exists: false instead of throwing', async () => {
    const load = await loadBaselineRecords(join(tmpdir(), 'eval-baseline-absent', 'baseline.jsonl'), nodeBaselineIo)
    expect(load).toEqual({ exists: false, records: [], badLines: 0 })
  })

  it('loads an empty file as zero records', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'eval-baseline-'))
    try {
      const path = resolveBaselinePath(cwd)
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, '', 'utf8')
      const load = await loadBaselineRecords(path, nodeBaselineIo)
      expect(load).toEqual({ exists: true, records: [], badLines: 0 })
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  it('skips and counts bad lines without rejecting the file', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'eval-baseline-'))
    try {
      const path = resolveBaselinePath(cwd)
      await mkdir(dirname(path), { recursive: true })
      const m = metricsFor('s1')
      const good = JSON.stringify(buildBaselineRecord({ sessionId: 's1', sessionFormatVersion: 3, metrics: m, card: gradeSession(m), bands: DEFAULT_GRADE_BANDS, at: '2026-11-25T08:00:00.000Z' }))
      await writeFile(path, ['', good, 'not json at all', '   ', '"a bare string"', '{"at":"no metrics"}', good, '', ''].join('\n'), 'utf8')
      const load = await loadBaselineRecords(path, nodeBaselineIo)
      expect(load.exists).toBe(true)
      expect(load.records.map((r) => r.sessionId)).toEqual(['s1', 's1'])
      expect(load.badLines).toBe(3) // bare string + shapeless object + garbage
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  it('normalizes absent stamps to safe defaults', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'eval-baseline-'))
    try {
      const path = resolveBaselinePath(cwd)
      await mkdir(dirname(path), { recursive: true })
      const m = metricsFor('s1')
      const line = JSON.stringify({ at: '2026-11-25T08:00:00.000Z', sessionId: 's1', generator: 'dsh-session-eval v0.4.3', metrics: m, card: gradeSession(m) })
      await writeFile(path, `${line}\n`, 'utf8')
      const load = await loadBaselineRecords(path, nodeBaselineIo)
      expect(load.records[0]!.sessionFormatVersion).toBeNull()
      expect(load.records[0]!.bandsFingerprint).toBe('')
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })
})

describe('latestBaseline', () => {
  it('returns the last appended record, or null for none', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'eval-baseline-'))
    try {
      const path = resolveBaselinePath(cwd)
      const m1 = metricsFor('s1')
      const m2 = computeMetrics('s2', adaptEvents([...turn(1, true)]))
      const r1 = buildBaselineRecord({ sessionId: 's1', sessionFormatVersion: 3, metrics: m1, card: gradeSession(m1), bands: DEFAULT_GRADE_BANDS })
      const r2 = buildBaselineRecord({ sessionId: 's2', sessionFormatVersion: 3, metrics: m2, card: gradeSession(m2), bands: DEFAULT_GRADE_BANDS })
      expect(latestBaseline([])).toBeNull()
      await appendBaselineRecord(path, r1, nodeBaselineIo)
      await appendBaselineRecord(path, r2, nodeBaselineIo)
      const load = await loadBaselineRecords(path, nodeBaselineIo)
      expect(latestBaseline(load.records)?.sessionId).toBe('s2')
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })
})
