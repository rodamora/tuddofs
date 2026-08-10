import './test-setup.js'

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { InvalidMountKeyError, InvalidPathError, validateMountKey, validatePath } from '../validation.js'

const rejectsPath = (path: string) => {
  assert.throws(() => validatePath(path), InvalidPathError)
}

const rejectsMountKey = (key: string) => {
  assert.throws(() => validateMountKey(key), InvalidMountKeyError)
}

describe('path validation', () => {
  it('normalizes a valid path to NFC before validating', () => {
    assert.equal(validatePath('/cafe\u0301.md'), '/café.md')
  })

  it('rejects a path without a leading slash', () => {
    rejectsPath('notes.md')
  })

  it('rejects a path containing a NUL byte', () => {
    rejectsPath('/notes\u0000.md')
  })

  it('rejects repeated separators', () => {
    rejectsPath('/notes//plan.md')
  })

  it('rejects a trailing separator', () => {
    rejectsPath('/notes/')
  })

  it('rejects the root path for files', () => {
    rejectsPath('/')
  })

  it('rejects dot segments', () => {
    rejectsPath('/notes/./plan.md')
  })

  it('rejects dot-dot segments', () => {
    rejectsPath('/notes/../plan.md')
  })

  it('rejects paths over 1024 UTF-8 bytes', () => {
    rejectsPath(`/${'a'.repeat(1024)}`)
  })

  it('accepts a path that is exactly 1024 UTF-8 bytes', () => {
    const path = `/${'a'.repeat(1023)}`
    assert.equal(Buffer.byteLength(path, 'utf8'), 1024)
    assert.equal(validatePath(path), path)
  })

  it('keeps path case-sensitive', () => {
    assert.notEqual(validatePath('/A.md'), validatePath('/a.md'))
  })
})

describe('mount-key validation', () => {
  it('accepts the complete allowed grammar', () => {
    assert.equal(validateMountKey('a0:._-'.repeat(9).slice(0, 64)), 'a0:._-'.repeat(9).slice(0, 64))
  })

  it('rejects an empty key', () => {
    rejectsMountKey('')
  })

  it('rejects an uppercase first character', () => {
    rejectsMountKey('Project')
  })

  it('rejects an uppercase character after the first position', () => {
    rejectsMountKey('projectKey')
  })

  it('rejects an invalid character', () => {
    rejectsMountKey('project/key')
  })

  it('rejects whitespace', () => {
    rejectsMountKey('project key')
  })

  it('rejects a backslash', () => {
    rejectsMountKey('project\\key')
  })

  it('rejects keys over 64 characters', () => {
    rejectsMountKey(`a${'b'.repeat(64)}`)
  })
})
