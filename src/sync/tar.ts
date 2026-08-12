import { InvalidPathError } from '../validation.js'
import { SyncTargetError } from './errors.js'

const BLOCK_SIZE = 512
const END_BLOCKS = 2
const USTAR_MAGIC = 'ustar\0'
const USTAR_VERSION = '00'
const textDecoder = new TextDecoder('utf-8', { fatal: true })

/** A regular file carried by a PAX archive. Paths are archive-relative. */
export interface PaxTarEntry {
  readonly path: string
  readonly bytes: Buffer
}

/** Parser safeguards for members emitted by an untrusted target. */
export interface ParsePaxTarOptions {
  /** Require every member to equal this path or be below it. */
  readonly expectedPrefix?: string
  /** Apply caller-owned path validation after the intrinsic archive checks. */
  readonly validatePath?: (path: string) => void | boolean
}

/** A malformed, truncated, unsafe, or otherwise unsupported tar archive. */
export class TarParseError extends SyncTargetError {
  readonly offset: number | undefined

  constructor(reason: string, offset?: number, memberPath?: string) {
    super(`tar parse error: ${reason}`, {}, memberPath === undefined ? undefined : { path: memberPath })
    this.name = 'TarParseError'
    this.offset = offset
  }
}

/**
 * Write a deterministic POSIX PAX archive containing regular files only.
 *
 * Every member has a PAX extended header with a length-prefixed UTF-8 `path=`
 * record. The following ustar header uses a short placeholder name because the
 * PAX path is authoritative; this avoids ustar's 100/155-byte name split.
 */
export function writePaxTar(entries: readonly PaxTarEntry[]): Buffer {
  const parts: Buffer[] = []
  const seen = new Set<string>()

  for (const [index, entry] of entries.entries()) {
    if (typeof entry.path !== 'string' || entry.path.length === 0) {
      throw new InvalidPathError(entry.path, 'tar member path must be a non-empty string')
    }
    validateArchivePath(entry.path)
    if (seen.has(entry.path)) {
      throw new InvalidPathError(entry.path, 'tar member paths must be unique')
    }
    seen.add(entry.path)
    if (!Buffer.isBuffer(entry.bytes)) {
      throw new TypeError('writer input bytes must be a Buffer')
    }

    const paxPayload = paxPathRecord(entry.path)
    parts.push(createHeader(`PaxHeaders.0/${index}`, 'x', paxPayload.length))
    parts.push(paxPayload, zeroPadding(paxPayload.length))
    parts.push(createHeader('pax-entry', '0', entry.bytes.length))
    parts.push(entry.bytes, zeroPadding(entry.bytes.length))
  }

  parts.push(Buffer.alloc(BLOCK_SIZE * END_BLOCKS))
  return Buffer.concat(parts)
}

/**
 * Parse a POSIX PAX/ustar archive without filesystem or process access.
 *
 * The returned map preserves archive order. Unknown PAX records are ignored;
 * `path` and `size` override their corresponding ustar fields as specified by
 * POSIX. Every malformed or incomplete archive fails instead of returning a
 * partial map.
 */
export function parsePaxTar(archive: Buffer, options: ParsePaxTarOptions = {}): ReadonlyMap<string, Buffer> {
  if (!Buffer.isBuffer(archive)) throw new TarParseError('archive must be a Buffer')
  if (archive.length === 0 || archive.length % BLOCK_SIZE !== 0) {
    throw new TarParseError('archive length is not a non-zero multiple of 512 bytes')
  }
  if (options.expectedPrefix !== undefined) normalizeExpectedPrefix(options.expectedPrefix)

  const entries = new Map<string, Buffer>()
  let offset = 0
  let localPax = new Map<string, Buffer>()
  const globalPax = new Map<string, Buffer>()
  let ended = false

  while (offset < archive.length) {
    const headerOffset = offset
    const header = archive.subarray(offset, offset + BLOCK_SIZE)
    if (header.length !== BLOCK_SIZE) throw new TarParseError('truncated tar header', headerOffset)
    offset += BLOCK_SIZE

    if (isZeroBlock(header)) {
      const second = archive.subarray(offset, offset + BLOCK_SIZE)
      if (second.length !== BLOCK_SIZE || !isZeroBlock(second)) {
        throw new TarParseError('archive terminator is truncated or malformed', headerOffset)
      }
      if (localPax.size > 0) {
        throw new TarParseError('archive terminates after an extended header', headerOffset)
      }
      offset += BLOCK_SIZE
      ended = true
      while (offset < archive.length) {
        if (!isZeroBlock(archive.subarray(offset, offset + BLOCK_SIZE))) {
          throw new TarParseError('non-zero data appears after the archive terminator', offset)
        }
        offset += BLOCK_SIZE
      }
      break
    }

    verifyChecksum(header, headerOffset)
    verifyUstarHeader(header, headerOffset)
    const typeflag = header[156] === 0 ? '0' : String.fromCharCode(header[156])
    const headerSize = readTarNumber(header.subarray(124, 136), 'size', headerOffset)

    if (typeflag === 'x' || typeflag === 'g') {
      const payload = readPayload(archive, offset, headerSize, headerOffset)
      const records = parsePaxRecords(payload, headerOffset + BLOCK_SIZE)
      if (typeflag === 'g') {
        for (const [key, value] of records) globalPax.set(key, value)
      } else {
        for (const [key, value] of records) localPax.set(key, value)
      }
      offset += paddedSize(headerSize)
      continue
    }

    if (typeflag !== '0') {
      throw new TarParseError(`non-regular member type ${JSON.stringify(typeflag)}`, headerOffset)
    }

    const attributes = new Map(globalPax)
    for (const [key, value] of localPax) attributes.set(key, value)
    localPax = new Map()

    const path = attributes.has('path')
      ? decodePaxPath(attributes.get('path')!, headerOffset)
      : decodeUstarPath(header, headerOffset)
    validateMemberPath(path, options, headerOffset)

    const size = attributes.has('size')
      ? parsePaxSize(attributes.get('size')!, headerOffset)
      : headerSize
    const payload = readPayload(archive, offset, size, headerOffset)
    if (entries.has(path)) throw new TarParseError('duplicate member path', headerOffset, path)
    entries.set(path, Buffer.from(payload))
    offset += paddedSize(size)
  }

  if (!ended) throw new TarParseError('archive has no two-block terminator', offset)
  return entries
}

function validateArchivePath(path: string): void {
  if (path.includes('\0')) throw new InvalidPathError(path, 'tar member path must not contain a NUL byte')
  if (path.startsWith('/')) throw new InvalidPathError(path, 'tar member path must be relative')
  const segments = path.split('/')
  if (segments.some(segment => segment.length === 0 || segment === '.' || segment === '..')) {
    throw new InvalidPathError(path, 'tar member path must not contain empty, ., or .. segments')
  }
}

function validateMemberPath(path: string, options: ParsePaxTarOptions, offset: number): void {
  try {
    validateArchivePath(path)
  } catch (error) {
    if (error instanceof InvalidPathError) throw error
    throw new TarParseError('invalid member path', offset, path)
  }

  if (options.expectedPrefix !== undefined) {
    const prefix = normalizeExpectedPrefix(options.expectedPrefix)
    if (path !== prefix && !path.startsWith(`${prefix}/`)) {
      throw new InvalidPathError(path, `tar member must resolve under expected prefix ${prefix}`)
    }
  }

  if (options.validatePath !== undefined) {
    try {
      if (options.validatePath(path) === false) {
        throw new InvalidPathError(path, 'tar member rejected by validation hook')
      }
    } catch (error) {
      if (error instanceof InvalidPathError || error instanceof TarParseError) throw error
      throw new TarParseError(`member validation failed: ${errorMessage(error)}`, offset, path)
    }
  }
}

function normalizeExpectedPrefix(prefix: string): string {
  if (typeof prefix !== 'string' || prefix.length === 0) throw new TarParseError('expectedPrefix must be non-empty')
  if (prefix.includes('\0') || prefix.startsWith('/')) throw new TarParseError('expectedPrefix must be relative')
  const normalized = prefix.replace(/\/+$/u, '')
  if (normalized.length === 0) throw new TarParseError('expectedPrefix must name a directory or member')
  const segments = normalized.split('/')
  if (segments.some(segment => segment.length === 0 || segment === '.' || segment === '..')) {
    throw new TarParseError('expectedPrefix contains an invalid path segment')
  }
  return normalized
}

function paxPathRecord(path: string): Buffer {
  const value = Buffer.from(`path=${path}\n`, 'utf8')
  let length = value.length + 2
  while (true) {
    const next = value.length + 1 + String(length).length
    if (next === length) break
    length = next
  }
  return Buffer.concat([Buffer.from(`${length} `, 'ascii'), value])
}

function createHeader(name: string, typeflag: '0' | 'x', size: number): Buffer {
  if (!Number.isSafeInteger(size) || size < 0 || size > 0o77777777777) {
    throw new TarParseError('tar field size is outside the supported range')
  }
  const header = Buffer.alloc(BLOCK_SIZE)
  writeStringField(header, 0, 100, name)
  writeOctalField(header, 100, 8, 0o644)
  writeOctalField(header, 108, 8, 0)
  writeOctalField(header, 116, 8, 0)
  writeOctalField(header, 124, 12, size)
  writeOctalField(header, 136, 12, 0)
  header[156] = typeflag.charCodeAt(0)
  writeStringField(header, 257, 6, USTAR_MAGIC)
  writeStringField(header, 263, 2, USTAR_VERSION)
  header.fill(0x20, 148, 156)

  let checksum = 0
  for (const byte of header) checksum += byte
  const checksumDigits = checksum.toString(8).padStart(6, '0')
  header.write(`${checksumDigits}\0 `, 148, 'ascii')
  return header
}

function writeStringField(buffer: Buffer, offset: number, length: number, value: string): void {
  const bytes = Buffer.from(value, 'utf8')
  if (bytes.length > length) throw new TarParseError('tar header field is too long')
  bytes.copy(buffer, offset)
}

function writeOctalField(buffer: Buffer, offset: number, length: number, value: number): void {
  const digits = value.toString(8)
  if (digits.length > length - 1) throw new TarParseError('tar numeric field is too large')
  buffer.write(digits.padStart(length - 1, '0'), offset, 'ascii')
}

function zeroPadding(size: number): Buffer {
  return Buffer.alloc((BLOCK_SIZE - (size % BLOCK_SIZE)) % BLOCK_SIZE)
}

function paddedSize(size: number): number {
  if (!Number.isSafeInteger(size) || size < 0) throw new TarParseError('tar member size is invalid')
  const padding = (BLOCK_SIZE - (size % BLOCK_SIZE)) % BLOCK_SIZE
  if (size > Number.MAX_SAFE_INTEGER - padding) throw new TarParseError('tar member size overflows parser bounds')
  return size + padding
}

function readPayload(archive: Buffer, offset: number, size: number, headerOffset: number): Buffer {
  const padded = paddedSize(size)
  if (offset > archive.length || padded > archive.length - offset) {
    throw new TarParseError('member payload is truncated', headerOffset)
  }
  return archive.subarray(offset, offset + size)
}

function isZeroBlock(block: Buffer): boolean {
  if (block.length !== BLOCK_SIZE) return false
  for (const byte of block) if (byte !== 0) return false
  return true
}

function verifyChecksum(header: Buffer, offset: number): void {
  const stored = readTarNumber(header.subarray(148, 156), 'checksum', offset)
  let calculated = 0
  for (let index = 0; index < header.length; index++) {
    calculated += index >= 148 && index < 156 ? 0x20 : header[index]
  }
  if (stored !== calculated) throw new TarParseError('header checksum does not match', offset)
}

function verifyUstarHeader(header: Buffer, offset: number): void {
  if (decodeAscii(header.subarray(257, 263)) !== USTAR_MAGIC) {
    throw new TarParseError('header does not contain the ustar magic', offset)
  }
  if (decodeAscii(header.subarray(263, 265)) !== USTAR_VERSION) {
    throw new TarParseError('header has an unsupported ustar version', offset)
  }
}

function readTarNumber(field: Buffer, label: string, offset: number): number {
  if (field.length > 0 && (field[0] & 0x80) !== 0) {
    let value = 0
    for (let index = 0; index < field.length; index++) {
      const byte = index === 0 ? field[index] & 0x7f : field[index]
      value = value * 256 + byte
      if (!Number.isSafeInteger(value)) throw new TarParseError(`${label} is too large`, offset)
    }
    return value
  }
  const text = decodeAscii(field).replace(/[\0 ]+$/u, '')
  if (text.length === 0 || !/^0?[0-7]+$/u.test(text)) {
    throw new TarParseError(`${label} is not a valid octal number`, offset)
  }
  const value = Number.parseInt(text, 8)
  if (!Number.isSafeInteger(value)) throw new TarParseError(`${label} is too large`, offset)
  return value
}

function parsePaxRecords(payload: Buffer, offset: number): Map<string, Buffer> {
  const records = new Map<string, Buffer>()
  let cursor = 0
  while (cursor < payload.length) {
    const space = payload.indexOf(0x20, cursor)
    if (space === -1) throw new TarParseError('PAX record has no length separator', offset + cursor)
    const lengthText = decodeAscii(payload.subarray(cursor, space))
    if (!/^[1-9][0-9]*$/u.test(lengthText)) {
      throw new TarParseError('PAX record length is not decimal', offset + cursor)
    }
    const length = Number(lengthText)
    if (!Number.isSafeInteger(length) || length < space - cursor + 2) {
      throw new TarParseError('PAX record length is invalid', offset + cursor)
    }
    if (length > payload.length - cursor) {
      throw new TarParseError('PAX record is truncated', offset + cursor)
    }
    const record = payload.subarray(cursor, cursor + length)
    if (record[length - 1] !== 0x0a) {
      throw new TarParseError('PAX record is not newline terminated', offset + cursor)
    }
    const bodyStart = space - cursor + 1
    const body = record.subarray(bodyStart, length - 1)
    const equals = body.indexOf(0x3d)
    if (equals <= 0) throw new TarParseError('PAX record has no key/value separator', offset + cursor)
    const key = decodeAscii(body.subarray(0, equals))
    records.set(key, Buffer.from(body.subarray(equals + 1)))
    cursor += length
  }
  return records
}

function decodePaxPath(value: Buffer, offset: number): string {
  const path = decodeUtf8(value)
  if (path.length === 0) throw new TarParseError('PAX path is empty', offset)
  return path
}

function parsePaxSize(value: Buffer, offset: number): number {
  const text = decodeAscii(value)
  if (!/^(?:0|[1-9][0-9]*)$/u.test(text)) throw new TarParseError('PAX size is not a non-negative decimal', offset)
  const size = Number(text)
  if (!Number.isSafeInteger(size)) throw new TarParseError('PAX size is too large', offset)
  return size
}

function decodeUstarPath(header: Buffer, offset: number): string {
  const name = trimNul(header.subarray(0, 100))
  const prefix = trimNul(header.subarray(345, 500))
  if (name.length === 0) throw new TarParseError('ustar member path is empty', offset)
  const nameText = decodeUtf8(name)
  const prefixText = prefix.length === 0 ? '' : decodeUtf8(prefix)
  return prefixText.length === 0 ? nameText : `${prefixText}/${nameText}`
}

function trimNul(value: Buffer): Buffer {
  const nul = value.indexOf(0)
  return nul === -1 ? value : value.subarray(0, nul)
}

function decodeUtf8(value: Buffer): string {
  try {
    return textDecoder.decode(value)
  } catch {
    throw new TarParseError('member path is not valid UTF-8')
  }
}

function decodeAscii(value: Buffer): string {
  for (const byte of value) if (byte > 0x7f) throw new TarParseError('tar field is not ASCII')
  return value.toString('ascii')
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
