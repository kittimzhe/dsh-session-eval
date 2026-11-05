/**
 * Minimal single-file ZIP reader (methods 0 and 8, no external dependency).
 *
 * The mirror of dsh-session-export's `util/zip.ts` writer: parses the
 * End-of-Central-Directory record, walks the central directory, and inflates
 * each entry with raw DEFLATE (`node:zlib.inflateRawSync`, ZIP method 8) or
 * copies stored entries (method 0). Data descriptors are not needed because
 * the writer emits none; CRC32 is verified per entry. Only the features the
 * toolchain's own archives use are supported — a ZIP using extensions beyond
 * that is rejected with a clear error, not misread.
 *
 * @module dsh-session-eval/zip
 */
import { crc32, inflateRawSync } from 'node:zlib'

const EOCD_SIG = 0x06054b50
const CD_SIG = 0x02014b50
const LFH_SIG = 0x04034b50

/** One decompressed archive entry. */
export interface ZipReadEntry {
  readonly name: string
  readonly data: Buffer
}

/** Locate the EOCD record: normally the last 22 bytes; scan back over a comment if present. */
function findEocd(buf: Buffer): number {
  const limit = Math.max(0, buf.length - 22 - 65_536)
  for (let i = buf.length - 22; i >= limit; i -= 1) {
    if (buf.readUInt32LE(i) === EOCD_SIG) return i
  }
  return -1
}

/**
 * Read every entry of a ZIP archive. Throws `Error` with a plain message on
 * anything that is not a supported archive (truncated, unknown method, or a
 * CRC mismatch) — callers surface the message to the user.
 */
export function readZipEntries(buf: Buffer): ZipReadEntry[] {
  const eocd = findEocd(buf)
  if (eocd < 0) throw new Error('not a ZIP archive (no end-of-central-directory record)')
  const entryCount = buf.readUInt16LE(eocd + 10)
  const cdOffset = buf.readUInt32LE(eocd + 16)

  const entries: ZipReadEntry[] = []
  let p = cdOffset
  for (let i = 0; i < entryCount; i += 1) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== CD_SIG) {
      throw new Error(`corrupt ZIP: central directory entry ${i} is unreadable`)
    }
    const method = buf.readUInt16LE(p + 10)
    const crcExpected = buf.readUInt32LE(p + 16)
    const compressedSize = buf.readUInt32LE(p + 20)
    const rawSize = buf.readUInt32LE(p + 24)
    const nameLength = buf.readUInt16LE(p + 28)
    const extraLength = buf.readUInt16LE(p + 30)
    const commentLength = buf.readUInt16LE(p + 32)
    const localOffset = buf.readUInt32LE(p + 42)
    const name = buf.toString('utf8', p + 46, p + 46 + nameLength)

    if (buf.readUInt32LE(localOffset) !== LFH_SIG) {
      throw new Error(`corrupt ZIP: entry "${name}" has no local file header`)
    }
    const lfhNameLength = buf.readUInt16LE(localOffset + 26)
    const lfhExtraLength = buf.readUInt16LE(localOffset + 28)
    const dataStart = localOffset + 30 + lfhNameLength + lfhExtraLength
    const compressed = buf.subarray(dataStart, dataStart + compressedSize)

    let raw: Buffer
    if (method === 0) raw = Buffer.from(compressed)
    else if (method === 8) raw = inflateRawSync(compressed)
    else throw new Error(`unsupported ZIP compression method ${method} for entry "${name}"`)
    if (raw.length !== rawSize) throw new Error(`corrupt ZIP: entry "${name}" decompressed to the wrong size`)
    if ((crc32(raw) >>> 0) !== crcExpected) throw new Error(`corrupt ZIP: CRC mismatch for entry "${name}"`)

    entries.push({ name, data: raw })
    p += 46 + nameLength + extraLength + commentLength
  }
  return entries
}

/** Read one named entry, or null when absent. */
export function readZipEntry(buf: Buffer, name: string): Buffer | null {
  for (const entry of readZipEntries(buf)) {
    if (entry.name === name) return entry.data
  }
  return null
}
