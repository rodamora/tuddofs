import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { InvalidPathError } from '../internal.js'
import { parsePaxTar, TarParseError, writePaxTar } from '../sync/tar.js'

const hostileEntries = [
  { path: 'mirror/line\nfeed', bytes: Buffer.from('newline') },
  { path: "mirror/single'quote", bytes: Buffer.from("single") },
  { path: 'mirror/double"quote', bytes: Buffer.from('double') },
  { path: 'mirror/percent%name', bytes: Buffer.from('percent') },
  { path: 'mirror/café-日本語', bytes: Buffer.from('unicode') },
  { path: `mirror/${'x'.repeat(300)}`, bytes: Buffer.from('long') },
] as const

test('PAX writer round-trips hostile member names and bytes', () => {
  const archive = writePaxTar(hostileEntries)
  const parsed = parsePaxTar(archive, { expectedPrefix: 'mirror' })

  assert.deepEqual([...parsed.keys()], hostileEntries.map(entry => entry.path))
  for (const entry of hostileEntries) assert.deepEqual(parsed.get(entry.path), entry.bytes)
})

test('PAX writer emits a deterministic always-PAX ustar sequence', () => {
  const archive = writePaxTar([{ path: 'mirror/hello.txt', bytes: Buffer.from('hello') }])
  assert.deepEqual(archive, writePaxTar([{ path: 'mirror/hello.txt', bytes: Buffer.from('hello') }]))
  assert.equal(archive.length % 512, 0)
  assert.equal(archive.subarray(156, 157).toString('ascii'), 'x')
  assert.equal(archive.subarray(1024 + 156, 1024 + 157).toString('ascii'), '0')
  assert.equal(archive.subarray(1536, 1536 + 5).toString(), 'hello')
  assert.deepEqual(archive.subarray(-1024), Buffer.alloc(1024))

  const paxPayload = archive.subarray(512, 1024)
  assert.equal(paxPayload.subarray(0, 25).toString(), '25 path=mirror/hello.txt\n')
})

test('PAX writer rejects non-Buffer entry bytes as a TypeError', () => {
  assert.throws(
    () => writePaxTar([{ path: 'mirror/not-bytes', bytes: 'not a Buffer' as unknown as Buffer }]),
    TypeError,
  )
})

test('PAX writer emits canonical length prefixes across a digit boundary', () => {
  const firstPath = `mirror/${'a'.repeat(83)}`
  const secondPath = `mirror/${'b'.repeat(84)}`
  const archive = writePaxTar([
    { path: firstPath, bytes: Buffer.alloc(0) },
    { path: secondPath, bytes: Buffer.alloc(0) },
  ])

  assert.equal(archive.subarray(512, 512 + 99).toString(), `99 path=${firstPath}\n`)
  assert.equal(archive.subarray(2048, 2048 + 101).toString(), `101 path=${secondPath}\n`)
})

test('PAX parser accepts GNU tar output and extracts regular file bytes', () => {
  const root = mkdtempSync(join(tmpdir(), 'tuddofs-tar-'))
  try {
    const file = join(root, 'gnu-file.txt')
    writeFileSync(file, 'from GNU tar')
    let archive: Buffer
    try {
      archive = execFileSync('tar', [
        '--format=posix',
        '--mtime=@0',
        '--owner=0',
        '--group=0',
        '--numeric-owner',
        '-cf',
        '-',
        '-C',
        root,
        'gnu-file.txt',
      ])
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }

    const parsed = parsePaxTar(archive, { expectedPrefix: 'gnu-file.txt' })
    assert.deepEqual(parsed.get('gnu-file.txt'), Buffer.from('from GNU tar'))

    const extracted = spawnSync('tar', ['-xOf', '-', 'gnu-file.txt'], { input: writePaxTar([{ path: 'gnu-file.txt', bytes: Buffer.from('from writer') }]) })
    if (extracted.error?.code === 'ENOENT') return
    assert.equal(extracted.status, 0)
    assert.equal(extracted.stdout.toString(), 'from writer')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('PAX parser invokes caller validation and expected-prefix guard', () => {
  const archive = writePaxTar([{ path: 'mirror/ok.txt', bytes: Buffer.from('ok') }])
  assert.throws(
    () => parsePaxTar(archive, { expectedPrefix: 'other', validatePath: () => false }),
    InvalidPathError,
  )
  assert.throws(
    () => parsePaxTar(archive, { validatePath: () => { throw new Error('nope') } }),
    TarParseError,
  )
})

test('PAX size records override the ustar size field', () => {
  const archive = makePaxSizeOverrideArchive()
  const parsed = parsePaxTar(archive, { expectedPrefix: 'mirror' })

  assert.deepEqual(parsed.get('mirror/size'), Buffer.from('bytes'))
})

test('PAX parser rejects a multi-member archive truncated after the first member', () => {
  const archive = writePaxTar([
    { path: 'mirror/first', bytes: Buffer.from('first') },
    { path: 'mirror/second', bytes: Buffer.from('second') },
  ])

  // The first member ends immediately before the second PAX header. It is
  // complete, but there is no archive terminator, so no partial map is valid.
  const secondPaxHeader = archive.indexOf(Buffer.from('PaxHeaders.0/1', 'ascii'))
  assert.ok(secondPaxHeader > 0)
  assert.throws(() => parsePaxTar(archive.subarray(0, secondPaxHeader)), TarParseError)
})

test('PAX parser rejects truncated and malformed archives with typed errors', () => {
  const archive = writePaxTar([{ path: 'mirror/file', bytes: Buffer.from('bytes') }])
  assert.throws(() => parsePaxTar(archive.subarray(0, -1)), TarParseError)

  const malformed = Buffer.from(archive)
  malformed[0] = 0x7f
  assert.throws(() => parsePaxTar(malformed), TarParseError)
})

test('PAX parser rejects out-of-root paths and non-regular members', () => {
  const outOfRoot = writePaxTar([{ path: 'outside/file', bytes: Buffer.from('bytes') }])
  assert.throws(() => parsePaxTar(outOfRoot, { expectedPrefix: 'mirror' }), InvalidPathError)

  for (const typeflag of ['2', '3', '5', '6']) {
    const archive = makeSingleMemberArchive('mirror/member', typeflag)
    assert.throws(() => parsePaxTar(archive, { expectedPrefix: 'mirror' }), TarParseError)
  }
})

function makePaxSizeOverrideArchive(): Buffer {
  const bytes = Buffer.from('bytes')
  const paxPayload = Buffer.from('10 size=5\n', 'ascii')
  return Buffer.concat([
    makeTarHeader('PaxHeaders.0/member', 'x', paxPayload.length),
    paxPayload,
    zeroPadding(paxPayload.length),
    makeTarHeader('mirror/size', '0', 999),
    bytes,
    zeroPadding(bytes.length),
    Buffer.alloc(1024),
  ])
}

function makeSingleMemberArchive(path: string, typeflag: string): Buffer {
  return Buffer.concat([makeTarHeader(path, typeflag, 0), Buffer.alloc(1024)])
}

function makeTarHeader(path: string, typeflag: string, size: number): Buffer {
  const header = Buffer.alloc(512)
  header.write(path, 0, 'utf8')
  header.write('0000644\0', 100, 'ascii')
  header.write('0000000\0', 108, 'ascii')
  header.write('0000000\0', 116, 'ascii')
  header.write(`${size.toString(8).padStart(11, '0')}\0`, 124, 'ascii')
  header.write('00000000000\0', 136, 'ascii')
  header[156] = typeflag.charCodeAt(0)
  header.write('ustar\0', 257, 'ascii')
  header.write('00', 263, 'ascii')
  header.fill(0x20, 148, 156)
  let checksum = 0
  for (const byte of header) checksum += byte
  header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 'ascii')
  return header
}

function zeroPadding(size: number): Buffer {
  return Buffer.alloc((512 - (size % 512)) % 512)
}
