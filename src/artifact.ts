/**
 * Evidence-handoff loader: grade a session straight from an artifact
 * dsh-session-export already wrote (#8 closure).
 *
 * A bundle ZIP (`bundle-<id8>-<timestamp>.zip`) carries the raw JSONL
 * archive as a nested `archive.zip`, and a `/archive` ZIP carries
 * `session.jsonl` at its root. Both are the canonical event log — the same
 * bytes `readSession` would return — so grading from an artifact matches
 * grading through the seam exactly, and works after the session is gone
 * from the store.
 *
 * @module dsh-session-eval/artifact
 */
import { readZipEntries, type ZipReadEntry } from './zip.ts'

/** Filesystem seam (injectable for tests). */
export type ReadFile = (path: string) => Buffer

export interface LoadedArtifact {
  readonly sessionId: string
  readonly events: readonly unknown[]
  /** Where the events came from, for the grade-card header. */
  readonly origin: string
}

function jsonlEvents(data: Buffer): unknown[] {
  const out: unknown[] = []
  for (const line of data.toString('utf8').split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    out.push(JSON.parse(trimmed) as unknown)
  }
  return out
}

function byName(entries: readonly ZipReadEntry[]): Map<string, Buffer> {
  return new Map(entries.map((entry) => [entry.name, entry.data]))
}

/** Parse one zip level; returns null when this level holds no session.jsonl. */
function loadFromZipLevel(buf: Buffer, origin: string): LoadedArtifact | null {
  const files = byName(readZipEntries(buf))
  const jsonl = files.get('session.jsonl')
  if (jsonl === undefined) return null
  const manifestRaw = files.get('manifest.json')
  const manifest =
    manifestRaw === undefined ? ({} as Record<string, unknown>) : (JSON.parse(manifestRaw.toString('utf8')) as Record<string, unknown>)
  const sessionId = typeof manifest.sessionId === 'string' ? manifest.sessionId : 'unknown-session'
  return { sessionId, events: jsonlEvents(jsonl), origin }
}

/**
 * Load a gradeable session from an exported artifact path — a bundle ZIP
 * (nested archive) or a raw `/archive` ZIP. Returns a plain error string on
 * anything unreadable or unrecognized; never throws.
 */
export function loadReportArtifact(path: string, readFile: ReadFile): LoadedArtifact | string {
  let buf: Buffer
  try {
    buf = readFile(path)
  } catch (error) {
    return `Could not read ${path}: ${error instanceof Error ? error.message : String(error)}`
  }
  try {
    // A bundle zip nests the raw archive as archive.zip; try that first.
    const nested = readZipEntries(buf).find((entry) => entry.name === 'archive.zip')
    if (nested !== undefined) {
      const loaded = loadFromZipLevel(nested.data, `${path} (archive.zip)`)
      if (loaded !== null) return loaded
    }
    const direct = loadFromZipLevel(buf, path)
    if (direct !== null) return direct
    return `${path} is a ZIP but carries no session.jsonl (neither at the root nor inside archive.zip) — is it a transcript report rather than a bundle or archive?`
  } catch (error) {
    return `Could not load artifact ${path}: ${error instanceof Error ? error.message : String(error)}`
  }
}
