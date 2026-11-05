import { describe, expect, it } from 'vitest'
import { buildArchiveFromLog, buildZip } from 'dsh-session-export'
import { readZipEntries, readZipEntry } from '../src/zip.ts'
import { loadReportArtifact } from '../src/artifact.ts'
import { executeEval, parseEvalArgs } from '../src/evalCommand.ts'
import type { CommandInvocation } from '@deepseek-ai/dsh-commands'
import type { SessionHeader } from '@deepseek-ai/dsh-session'

/** Real events in the vocabulary adaptEvents understands. */
const events = (base: number, error = false) => [
  { type: 'user/message', seq: base, time: base * 100, message: { role: 'user' } },
  { type: 'assistant/message', seq: base + 1, time: (base + 1) * 100, message: { role: 'assistant' } },
  { type: 'tool/call', seq: base + 2, time: (base + 2) * 100, message: { tool: 'bash' } },
  { type: 'tool/result', seq: base + 3, time: (base + 3) * 100, message: { tool: 'bash', isError: error } },
]

const header: SessionHeader = {
  version: 3,
  id: 'session-aaaabbbb-0000-0000-0000-000000000000' as never,
  createdAt: 1_700_000_000_000,
  isSeeded: false,
}

/** Build a bundle-style zip: transcript.json + nested archive.zip, exactly like /transcript --bundle. */
function buildBundleZip(sessionEvents: readonly unknown[]): Buffer {
  const archive = buildArchiveFromLog({ session: header, events: sessionEvents as never })
  return Buffer.from(
    buildZip([
      { name: 'transcript.json', data: new TextEncoder().encode('{"format":"dsh-session-transcript"}') },
      { name: 'archive.zip', data: archive.zip },
      { name: 'manifest.json', data: new TextEncoder().encode('{}') },
    ]),
  )
}

const invocation = (rawInput: string): CommandInvocation => ({ rawInput, agent: { session: { id: 'current' } } }) as never

/** In-memory filesystem for the loader seam. */
function fsWith(files: Record<string, Buffer>) {
  return (path: string): Buffer => {
    const found = files[path]
    if (found === undefined) {
      const err = new Error(`ENOENT: no such file ${path}`) as NodeJS.ErrnoException
      err.code = 'ENOENT'
      throw err
    }
    return found
  }
}

describe('readZipEntries (mirror of dsh-session-export writer)', () => {
  it('round-trips a real buildZip archive entry by entry', () => {
    const zip = buildZip([
      { name: 'a.txt', data: new TextEncoder().encode('hello') },
      { name: 'dir/b.json', data: new TextEncoder().encode('{"x":1}') },
    ])
    const entries = readZipEntries(Buffer.from(zip))
    expect(entries.map((e) => e.name)).toEqual(['a.txt', 'dir/b.json'])
    expect(entries[0]?.data.toString()).toBe('hello')
    expect(entries[1]?.data.toString()).toBe('{"x":1}')
    expect(readZipEntry(Buffer.from(zip), 'a.txt')?.toString()).toBe('hello')
    expect(readZipEntry(Buffer.from(zip), 'missing')).toBeNull()
  })

  it('rejects non-zip bytes and corrupted CRC with clear errors', () => {
    expect(() => readZipEntries(Buffer.from('not a zip'))).toThrow(/not a ZIP archive/)
    const zip = Buffer.from(buildZip([{ name: 'a', data: new TextEncoder().encode('hello') }]))
    const flipAt = zip.length - 1 - 20
    if (flipAt >= 0) zip[flipAt] = (zip[flipAt] ?? 0) ^ 0xff // flip a byte inside the EOCD/CD region
    expect(() => readZipEntries(zip)).toThrow()
  })
})

describe('loadReportArtifact (#8 closure)', () => {
  it('loads a bundle zip through the nested archive.zip', () => {
    const artifact = loadReportArtifact('/x/bundle-aaaabbbb-20261104-120000.zip', fsWith({
      '/x/bundle-aaaabbbb-20261104-120000.zip': buildBundleZip(events(10)),
    }))
    expect(artifact).not.toBeTypeOf('string')
    const loaded = artifact as { sessionId: string; events: unknown[]; origin: string }
    expect(loaded.sessionId).toBe(header.id)
    expect(loaded.events).toHaveLength(4)
    expect(loaded.origin).toContain('archive.zip')
  })

  it('loads a raw /archive zip directly', () => {
    const archive = Buffer.from(buildArchiveFromLog({ session: header, events: events(20) as never }).zip)
    const artifact = loadReportArtifact('/x/archive.zip', fsWith({ '/x/archive.zip': archive }))
    expect(artifact).not.toBeTypeOf('string')
    const loaded = artifact as unknown as { sessionId: string; events: unknown[] }
    expect(loaded.sessionId).toBe(header.id)
    expect(loaded.events).toHaveLength(4)
  })

  it('reports a friendly error for a missing file', () => {
    expect(loadReportArtifact('/x/none.zip', fsWith({}))).toMatch(/Could not read \/x\/none\.zip/)
  })

  it('reports a friendly error for a zip without session.jsonl', () => {
    const zip = Buffer.from(buildZip([{ name: 'transcript.md', data: new TextEncoder().encode('# nope') }]))
    expect(loadReportArtifact('/x/t.zip', fsWith({ '/x/t.zip': zip }))).toMatch(/carries no session\.jsonl/)
  })
})

describe('/eval --report', () => {
  it('grades from a bundle artifact and matches /eval --id numbers exactly', async () => {
    const logs: Record<string, readonly unknown[]> = { [header.id]: events(10) }
    const seam = {
      async readSession(id: { toString(): string }) {
        return { events: logs[String(id)] ?? [] }
      },
    }
    const bundle = buildBundleZip(events(10))
    const byPath = fsWith({ '/x/bundle.zip': bundle })

    const fromSeam = await executeEval({} as never, invocation('--id ' + header.id), seam as never, {}, () => { throw new Error('no fs') })
    const fromArtifact = await executeEval({} as never, invocation('--report /x/bundle.zip'), seam as never, {}, byPath)

    expect(fromSeam.kind).toBe('success')
    expect(fromArtifact.kind).toBe('success')
    // deterministic comparison via --json mode
    const seamJson2 = await executeEval({} as never, invocation(`--id ${header.id} --json`), seam as never, {}, () => { throw new Error('no fs') })
    const artifactJson = await executeEval({} as never, invocation('--report /x/bundle.zip --json'), seam as never, {}, byPath)
    const a = JSON.parse((seamJson2 as { text: string }).text)
    const b = JSON.parse((artifactJson as { text: string }).text)
    expect(b.source).toBe('from artifact /x/bundle.zip (archive.zip)')
    expect(b.metrics).toEqual(a.metrics)
    expect(b.card).toEqual(a.card)
    expect((fromArtifact as { text: string }).text).toContain('(from artifact /x/bundle.zip (archive.zip))')
  })

  it('parses and rejects --report arguments', () => {
    expect(parseEvalArgs('--report /x/b.zip')).toEqual({ report: '/x/b.zip' })
    expect(parseEvalArgs('--report /x/b.zip --json')).toEqual({ report: '/x/b.zip', json: true })
    expect(typeof parseEvalArgs('--report')).toBe('string')
    expect(typeof parseEvalArgs('--id a --report b')).toBe('string')
  })
})
