import assert from 'node:assert/strict'
import test from 'node:test'

import {
  chmodReadOnlyCommand,
  mirrorDirName,
  mountKeyForMirrorDir,
  parseScanRecords,
  probeCommand,
  quoteShellArg,
  resolveUnderRoot,
  scanCommand,
  stampCommand,
} from '../sync/paths.js'
import { InvalidMountKeyError, InvalidPathError } from '../internal.js'

const record = (sha: string, path: string) => `${sha}  ${path}\0`
const sha = (character: string) => character.repeat(64)

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
  assert.throws(() => chmodReadOnlyCommand('/work', '../etc'), InvalidPathError)
  assert.throws(() => chmodReadOnlyCommand('/work', '/etc'), InvalidPathError)
})

test('scan and stamp commands quote every interpolated value and gate on find success', () => {
  const command = scanCommand({
    root: "/work space",
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
  assert.equal(stampCommand('/work', 1_700_000_000_500), "touch -d '@1700000000.500' '/work/.tuddofs-stamp'")
  assert.equal(probeCommand(), 'sha256sum --version && find --version')
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
  const names = ['spaces  everywhere.md', 'line\nbreak.md', 'astral \u{1F600}.md', "quote'and\"quote.md", '-dash.md']
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
