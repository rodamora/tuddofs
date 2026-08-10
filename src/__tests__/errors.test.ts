import './test-setup.js'

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  BranchSettledError,
  GrantResolverError,
  MergePendingApprovalError,
  NotFoundError,
  PermissionDeniedError,
  PreconditionFailedError,
  RefConflictError,
  StorageError,
} from '../errors.js'
import { InvalidCommitTimestampError, InvalidMountKeyError, InvalidPathError } from '../validation.js'

test('every kernel error is exported and carries operation context', () => {
  const context = { tenant: 'tenant-1', mount: 'project:crm', path: '/notes/a.md', ref: 'agent/s/project:crm' }
  const errors = [
    new InvalidPathError('/bad', 'bad', context),
    new InvalidMountKeyError('Bad', context),
    new InvalidCommitTimestampError('now', context),
    new PermissionDeniedError('denied', context),
    new PreconditionFailedError('old', 'new', context),
    new RefConflictError(context),
    new NotFoundError('missing', context),
    new BranchSettledError('merged', context),
    new MergePendingApprovalError(context),
    new GrantResolverError('resolver failed', context),
    new StorageError('storage failed', context),
  ]

  for (const error of errors) {
    assert.equal(error.context.tenant, context.tenant)
    assert.ok(error.context.mount)
    assert.ok(error.context.path)
    assert.equal(error.context.ref, context.ref)
    assert.ok(error instanceof Error)
  }
})
