import assert from 'node:assert/strict'
import test from 'node:test'

import {
  chmodReadOnlyCommand,
  chmodWritableCommand,
  mirrorDirName,
  mountKeyForMirrorDir,
  parseScanRecords,
  parseSizeRecords,
  probeCommand,
  quoteShellArg,
  resolveUnderRoot,
  scanCommand,
  sizeCommand,
  stampCommand,
  uploadCommand,
} from '../sync/paths.js'
import { InvalidMountKeyError, InvalidPathError } from '../internal.js'

const record = (sha: string, path: string) => `${sha}  ${path}\0`
const sha = (character: string) => character.repeat(64)
const sizeRecord = (size: number | string, path: string) => `${size}\0${path}\0`

test('mirror directory names encode the mount-key colon deterministically', () => {
  assert.equal(mirrorDirName('project:notes'), 'project%3Anotes')
  assert.equal(mirrorDirName('notes'), 'notes')
  assert.equal(mountKeyForMirrorDir('project%3Anotes'), 'project:notes')
  assert.equal(mountKeyForMirrorDir(mirrorDirName('a.b_c-d:e')), 'a.b_c-d:e')
})

test('mirror directory mapping rejects keys and directory names outside the ref charset', () => {
  assert.throws(() => mirrorDirName('Project:Notes'), InvalidMountKeyError)
  assert.throws(() => mirrorDirName('../escape'), InvalidMountKeyError)
  assert.throws(() => mountKeyForMirrorDir('project%2Fnotes'), InvalidMountKeyError)
  assert.throws(() => mountKeyForMirrorDir('..'), InvalidMountKeyError)
  assert.throws(() => mountKeyForMirrorDir('project%3anotes'), InvalidMountKeyError)
})

test('shell interpolation single-quotes every value including embedded quotes', () => {
  assert.equal(quoteShellArg('plain'), "'plain'")
  assert.equal(quoteShellArg("it's"), "'it'\\''s'")
  assert.equal(quoteShellArg('a b\nc'), "'a b\nc'")
  assert.equal(quoteShellArg('https://x/y?a=1&b=2'), "'https://x/y?a=1&b=2'")
})

test('root guard resolves strictly under the workspace root', () => {
  assert.equal(resolveUnderRoot('/work', 'mnt/a.txt'), '/work/mnt/a.txt')
  assert.equal(resolveUnderRoot('/work/', '/work/mnt/a.txt'), '/work/mnt/a.txt')
  assert.throws(() => resolveUnderRoot('/work', '../etc/passwd'), InvalidPathError)
  assert.throws(() => resolveUnderRoot('/work', '/etc/passwd'), InvalidPathError)
  assert.throws(() => resolveUnderRoot('/work', 'mnt/../../escape'), InvalidPathError)
  assert.throws(() => resolveUnderRoot('/work', '.'), InvalidPathError)
  assert.throws(() => resolveUnderRoot('/work', '/workshop/x'), InvalidPathError)
})

test('destructive execs refuse a mirror directory that does not resolve under the root', () => {
  assert.equal(chmodReadOnlyCommand('/work', 'notes'), "chmod -R a-w '/work/notes'")
  // The unfreeze is the exact inverse of the freeze over the two states the
  // mirror is allowed to be in: no write bit at all, or owner-write only. A
  // bare `u+w` would not undo `a-w`, and `a+w` would grant group and other a
  // write bit the engine never handed out.
  assert.equal(chmodWritableCommand('/work', 'notes'), "chmod -R a-w,u+w '/work/notes'")
  assert.throws(() => chmodReadOnlyCommand('/work', '../etc'), InvalidPathError)
  assert.throws(() => chmodReadOnlyCommand('/work', '/etc'), InvalidPathError)
  assert.throws(() => chmodWritableCommand('/work', '../etc'), InvalidPathError)
})

test('scan and stamp commands quote every interpolated value and gate on find success', () => {
  const command = scanCommand({
    root: '/work space',
    mirrorDirs: ['project%3Anotes', 'refs'],
    newerThanStamp: true,
  })
  assert.match(command, /^cd '\/work space' && /u)
  assert.ok(command.includes("'project%3Anotes'"))
  assert.ok(command.includes('-newer'))
  assert.ok(command.includes('-print0'))
  assert.ok(command.includes('xargs -0 -r sha256sum --zero'))
  // find's exit status must not be swallowed by a pipe: a failed scan is an
  // error event, never an empty diff (architecture §7.2).
  assert.ok(!command.includes('|'))
  assert.ok(scanCommand({ root: '/work', mirrorDirs: ['a'], newerThanStamp: false }).includes('-newer') === false)
  // The stamp trails the scan start by one granularity margin: filesystem
  // timestamps come from a coarse clock, so an exact stamp silently loses
  // writes that land after it. Over-capture is a sha no-op (§7.4).
  assert.equal(stampCommand('/work', 1_700_000_000_500), "touch -d '@1699999999.500' '/work/.tuddofs-stamp'")
  assert.equal(stampCommand('/work', 1_700_000_000_050), "touch -d '@1699999999.050' '/work/.tuddofs-stamp'")
  assert.equal(stampCommand('/work', 1_700_000_000_000), "touch -d '@1699999999.000' '/work/.tuddofs-stamp'")
  assert.equal(probeCommand(), 'sha256sum --version && find --version')
  // The direct-upload transport adds two binaries the capture path cannot work
  // without, so acquire is where their absence has to surface (§7.3 phase 1
  // step 1, §8.2).
  assert.equal(
    probeCommand({ directUpload: true }),
    'sha256sum --version && find --version && stat --version && curl --version',
  )
})
test('probe omits target-specific binary checks when none are required', () => {
  assert.equal(probeCommand({ requiredBinaries: [] }), 'sha256sum --version && find --version')
})

test('probe checks one required binary exactly once', () => {
  const command = probeCommand({ requiredBinaries: ['tar'] })
  assert.equal(command, 'sha256sum --version && find --version && tar --version')
  assert.equal(command.match(/(?:^| && )tar --version(?:$| && )/gu)?.length, 1)
})

test('probe checks several required binaries exactly once alongside engine checks', () => {
  const command = probeCommand({
    directUpload: true,
    requiredBinaries: ['tar', 'curl-config', 'xz'],
  })
  assert.equal(
    command,
    'sha256sum --version && find --version && stat --version && curl --version && tar --version && curl-config --version && xz --version',
  )
  for (const binary of ['tar', 'curl-config', 'xz']) {
    assert.equal(command.match(new RegExp(`(?:^| && )${binary} --version(?:$| && )`, 'gu'))?.length, 1)
  }
})
test('probe rejects shell metacharacters in required binary names', () => {
  assert.throws(
    () => probeCommand({ requiredBinaries: ['tar; echo INJECTED'] }),
    InvalidPathError,
  )
})

test('scan records map mirror paths back to mount keys and kernel paths', () => {
  const dirs = new Map([
    ['project%3Anotes', 'project:notes'],
    ['refs', 'refs'],
  ])
  const output = [
    record(sha('a'), 'project%3Anotes/a.md'),
    record(sha('b'), 'project%3Anotes/deep/nested file.md'),
    record(sha('c'), 'refs/x.md'),
  ].join('')

  assert.deepEqual(parseScanRecords(output, dirs), [
    { mountKey: 'project:notes', path: '/a.md', sha256: sha('a') },
    { mountKey: 'project:notes', path: '/deep/nested file.md', sha256: sha('b') },
    { mountKey: 'refs', path: '/x.md', sha256: sha('c') },
  ])
  assert.deepEqual(parseScanRecords('', dirs), [])
})

test('scan records survive hostile filenames that break naive parsers', () => {
  const dirs = new Map([['notes', 'notes']])
  const names = ['spaces  everywhere.md', 'line\nbreak.md', 'astral \u{1F600}.md', 'quote\'and"quote.md', '-dash.md']
  const output = names.map((name, index) => record(sha(String(index)), `notes/${name}`)).join('')

  assert.deepEqual(
    parseScanRecords(output, dirs).map(entry => entry.path),
    names.map(name => `/${name}`),
  )
})

test('scan records reject target-reported paths that escape their mount directory', () => {
  const dirs = new Map([['notes', 'notes']])

  for (const hostile of [
    'notes/../../etc/passwd',
    '../etc/passwd',
    '/etc/passwd',
    'notes/./a.md',
    'notes/',
    'notes',
    'other/a.md',
  ]) {
    assert.throws(() => parseScanRecords(record(sha('a'), hostile), dirs), InvalidPathError, hostile)
  }
})

test('scan records reject malformed sha256sum output instead of reporting an empty diff', () => {
  const dirs = new Map([['notes', 'notes']])

  assert.throws(() => parseScanRecords('not-a-record\0', dirs), InvalidPathError)
  assert.throws(() => parseScanRecords(`${'z'.repeat(64)}  notes/a.md\0`, dirs), InvalidPathError)
  assert.throws(() => parseScanRecords(`${sha('a')} notes/a.md\0`, dirs), InvalidPathError)
})

test('the size command reuses the scan list instead of interpolating any path', () => {
  const command = sizeCommand('/work space')

  assert.match(command, /^cd '\/work space' && /u)
  assert.ok(command.includes("xargs -0 -r stat --printf='%s\\0%n\\0'"))
  assert.ok(command.includes("< '.tuddofs/scan'"))
  // Sizes come from the list `find` already wrote, so the command carries no
  // agent-controlled filename, no ARG_MAX ceiling, and no second traversal.
  assert.ok(!command.includes('find '))
})

test('size records map mirror paths back to mount keys and kernel paths', () => {
  const dirs = new Map([
    ['project%3Anotes', 'project:notes'],
    ['refs', 'refs'],
  ])
  const output = [
    sizeRecord(0, 'project%3Anotes/empty.bin'),
    sizeRecord(2_147_483_648, 'project%3Anotes/deep/nested file.bin'),
    sizeRecord(7, 'refs/x.md'),
  ].join('')

  assert.deepEqual(parseSizeRecords(output, dirs), [
    { mountKey: 'project:notes', path: '/empty.bin', sizeBytes: 0 },
    { mountKey: 'project:notes', path: '/deep/nested file.bin', sizeBytes: 2_147_483_648 },
    { mountKey: 'refs', path: '/x.md', sizeBytes: 7 },
  ])
  assert.deepEqual(parseSizeRecords('', dirs), [])
})

test('size records reject malformed stat output and mount escapes instead of guessing a size', () => {
  const dirs = new Map([['notes', 'notes']])

  assert.throws(() => parseSizeRecords(sizeRecord(12, 'notes/a.bin').slice(0, -1), dirs), InvalidPathError)
  assert.throws(() => parseSizeRecords(`${'12\0'}`, dirs), InvalidPathError)
  assert.throws(() => parseSizeRecords(sizeRecord('12x', 'notes/a.bin'), dirs), InvalidPathError)
  assert.throws(() => parseSizeRecords(sizeRecord('-1', 'notes/a.bin'), dirs), InvalidPathError)
  assert.throws(() => parseSizeRecords(sizeRecord(12, '../etc/passwd'), dirs), InvalidPathError)
  assert.throws(() => parseSizeRecords(sizeRecord(12, 'other/a.bin'), dirs), InvalidPathError)
})

test('the upload command single-quotes the presigned URL and every signed header', () => {
  const url =
    'https://blobs.example/tuddo/t/abc?X-Amz-Signature=deadbeef&X-Amz-SignedHeaders=host;x-amz-checksum-sha256'
  const command = uploadCommand('/work', {
    path: '/work/project%3Anotes/big.bin',
    url,
    headers: { 'x-amz-checksum-sha256': 'qqlAJmTxpB9A67xSyZk+tmrrNmYClY/fqig7ceZNsSM=' },
  })

  // §7.4: the URL carries `&` and `;`, both of which end the command early
  // unquoted, and the checksum header carries `+` and `/`.
  assert.ok(command.includes(`'${url}'`))
  assert.ok(command.includes(`'x-amz-checksum-sha256: qqlAJmTxpB9A67xSyZk+tmrrNmYClY/fqig7ceZNsSM='`))
  assert.ok(command.includes(`--upload-file '/work/project%3Anotes/big.bin'`))
  assert.ok(command.startsWith('curl --silent --show-error --fail '))
  // curl must stream the file from disk; anything that reads it into the shell
  // defeats the whole point of not passing 2 GB through memory (§8.3).
  assert.ok(!command.includes('--data'))

  const unsigned = uploadCommand('/work', { path: '/work/notes/big.bin', url, headers: {} })
  assert.ok(!unsigned.includes('--header'))
})

test('the upload command refuses a file that does not resolve under the workspace root', () => {
  const url = 'https://blobs.example/o?sig=1&x=2'

  // A presigned PUT of /etc/passwd is the symlink-exfiltration hazard with a
  // network attached; the root guard runs before the exec line exists (§7.4).
  assert.throws(() => uploadCommand('/work', { path: '/etc/passwd', url, headers: {} }), InvalidPathError)
  assert.throws(() => uploadCommand('/work', { path: '../etc/passwd', url, headers: {} }), InvalidPathError)
})
