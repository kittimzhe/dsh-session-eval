/**
 * Baseline persistence: the per-workspace store `/eval-baseline` grades
 * against.
 *
 * One JSON record per line, append-only, at
 * `<session cwd>/.dsh-evals/baseline.jsonl` — the same
 * "directory inside the session cwd" convention dsh-session-export uses for
 * its report artifacts. Reading skips unparseable lines and counts them
 * instead of rejecting the whole file (the same tolerance adaptEvents and
 * the artifact loader apply); a record is only as trusted as the version
 * stamps it carries, so every line records the generator version, the
 * session format version, and a fingerprint of the grade bands that were
 * active when it was written.
 *
 * All filesystem effects sit behind one injectable seam ({@link BaselineIo}),
 * so every function here is testable without the command layer.
 *
 * @module dsh-session-eval/baseline
 */
import { appendFile, mkdir, readFile, unlink } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { DEFAULT_GRADE_BANDS, type GradeBands } from './grade.ts'
import type { GradeCard, SessionMetrics } from './types.ts'
import { VERSION } from './version.ts'

/** Directory name inside the session cwd that holds the baseline store. */
export const BASELINE_DIR = '.dsh-evals'
/** File name of the baseline store inside {@link BASELINE_DIR}. */
export const BASELINE_FILE = 'baseline.jsonl'

/** Filesystem seam for the baseline store (injectable for tests). */
export interface BaselineIo {
  /** Create the store directory (idempotent). */
  readonly mkdir: (dir: string) => Promise<unknown>
  /** Append one already-serialized line to the store. */
  readonly append: (path: string, data: string) => Promise<unknown>
  /** Read the whole store as UTF-8 text. */
  readonly read: (path: string) => Promise<string>
  /** Delete the store file. */
  readonly unlink: (path: string) => Promise<unknown>
}

/** The default seam over `node:fs/promises`. */
export const nodeBaselineIo: BaselineIo = {
  mkdir: (dir) => mkdir(dir, { recursive: true }),
  append: (path, data) => appendFile(path, data, 'utf8'),
  read: (path) => readFile(path, 'utf8'),
  unlink: (path) => unlink(path),
}

/**
 * One persisted baseline record: the full grade card of the moment, plus the
 * version stamps a later `/eval-baseline compare` checks before trusting it.
 */
export interface BaselineRecord {
  /** ISO timestamp of when the record was written. */
  readonly at: string
  /** The session that was graded. */
  readonly sessionId: string
  /** Generator stamp, `dsh-session-eval v<VERSION>` at write time. */
  readonly generator: string
  /** Session header format version when readable, else null. */
  readonly sessionFormatVersion: number | null
  /** Full deterministic metrics of the graded session. */
  readonly metrics: SessionMetrics
  /** Grade card (Overall + every dimension) of the graded session. */
  readonly card: GradeCard
  /** Fingerprint of the grade bands that produced this record's grades. */
  readonly bandsFingerprint: string
  /** Which command wrote the record. */
  readonly source: 'set'
}

/** What `loadBaselineRecords` found in the store. */
export interface BaselineLoad {
  /** Whether the store file exists at all. */
  readonly exists: boolean
  /** Parsed records in append order (oldest first). */
  readonly records: readonly BaselineRecord[]
  /** How many non-empty lines failed to parse into a record. */
  readonly badLines: number
}

/** Resolve the baseline store path for a workspace cwd. */
export function resolveBaselinePath(cwd: string): string {
  return join(cwd, BASELINE_DIR, BASELINE_FILE)
}

/**
 * Fingerprint of the grade bands that decide this record's grades:
 * sha256 over the plugin version and the effective bands, truncated to 16
 * hex chars — enough to detect any accidental threshold change without
 * printing the whole config.
 */
export function bandsFingerprint(bands: GradeBands): string {
  return createHash('sha256').update(JSON.stringify({ v: VERSION, bands })).digest('hex').slice(0, 16)
}

/** Merge partial bands over the defaults — the bands a grade actually ran with. */
export function effectiveBands(bands: Partial<GradeBands>): GradeBands {
  return { ...DEFAULT_GRADE_BANDS, ...bands }
}

/** The record `set` persists for one grading pass; `at` defaults to now. */
export function buildBaselineRecord(input: {
  readonly sessionId: string
  readonly sessionFormatVersion: number | null
  readonly metrics: SessionMetrics
  readonly card: GradeCard
  /** The effective (fully merged) grade bands used for this card. */
  readonly bands: GradeBands
  readonly at?: string
}): BaselineRecord {
  return {
    at: input.at ?? new Date().toISOString(),
    sessionId: input.sessionId,
    generator: `dsh-session-eval v${VERSION}`,
    sessionFormatVersion: input.sessionFormatVersion,
    metrics: input.metrics,
    card: input.card,
    bandsFingerprint: bandsFingerprint(input.bands),
    source: 'set',
  }
}

/** Append one record as a single JSON line (creates the directory first). */
export async function appendBaselineRecord(path: string, record: BaselineRecord, io: BaselineIo = nodeBaselineIo): Promise<void> {
  await io.mkdir(dirname(path))
  await io.append(path, `${JSON.stringify(record)}\n`)
}

/** The fields a parsed line must carry to count as a record (stamps beyond these may be absent). */
interface ValidatedRecord {
  readonly at: string
  readonly sessionId: string
  readonly generator: string
  readonly metrics: unknown
  readonly card: unknown
}

function isRecordShape(value: unknown): value is ValidatedRecord {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return (
    typeof record.at === 'string' &&
    typeof record.sessionId === 'string' &&
    typeof record.generator === 'string' &&
    record.metrics != null &&
    typeof record.metrics === 'object' &&
    !Array.isArray(record.metrics) &&
    record.card != null &&
    typeof record.card === 'object' &&
    !Array.isArray(record.card)
  )
}

/**
 * Load and parse the store: one record per non-empty line; bad lines are
 * skipped and counted, never fatal. A missing file loads as
 * `{ exists: false, … }` so `clear` can be friendly about it.
 * Throws only for non-ENOENT read errors; callers report them.
 */
export async function loadBaselineRecords(path: string, io: BaselineIo = nodeBaselineIo): Promise<BaselineLoad> {
  let text: string
  try {
    text = await io.read(path)
  } catch (error) {
    const code = (error as { code?: unknown }).code
    if (code === 'ENOENT') return { exists: false, records: [], badLines: 0 }
    throw error
  }
  const records: BaselineRecord[] = []
  let badLines = 0
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      badLines += 1
      continue
    }
    if (!isRecordShape(parsed)) {
      badLines += 1
      continue
    }
    // Normalize the optional stamps downstream code compares; anything
    // missing or malformed degrades to the safe defaults (unknown version,
    // empty fingerprint) which compare treats as a mismatch.
    const raw = parsed as unknown as Record<string, unknown>
    const stamp = raw.sessionFormatVersion
    records.push({
      at: parsed.at,
      sessionId: parsed.sessionId,
      generator: parsed.generator,
      sessionFormatVersion: typeof stamp === 'number' && Number.isFinite(stamp) ? stamp : null,
      metrics: parsed.metrics as SessionMetrics,
      card: parsed.card as GradeCard,
      bandsFingerprint: typeof raw.bandsFingerprint === 'string' ? raw.bandsFingerprint : '',
      source: 'set',
    })
  }
  return { exists: true, records, badLines }
}

/**
 * The latest baseline record: the last line. Append order is the store's
 * physical truth, so this stays deterministic even under clock skew; the
 * list renderer reads the same order backwards for "newest first".
 */
export function latestBaseline(records: readonly BaselineRecord[]): BaselineRecord | null {
  return records.length > 0 ? records[records.length - 1]! : null
}
