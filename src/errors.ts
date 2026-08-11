import type { InvalidCommitTimestampError, InvalidMountKeyError, InvalidPathError } from './validation.js'
export interface ErrorContext {
  readonly tenant: string
  readonly mount?: string
  readonly path?: string
  readonly ref?: string
}

function normalizeContext(context?: Partial<ErrorContext>): ErrorContext {
  return {
    tenant: context?.tenant ?? '',
    ...(context?.mount === undefined ? {} : { mount: context.mount }),
    ...(context?.path === undefined ? {} : { path: context.path }),
    ...(context?.ref === undefined ? {} : { ref: context.ref }),
  }
}

/** Base class for the package's discriminated error taxonomy. @see spec §9 */
export class TuddoFsError extends Error {
  readonly context: ErrorContext
  readonly tenant: string
  readonly mount?: string
  readonly path?: string
  readonly ref?: string

  constructor(message: string, context?: Partial<ErrorContext>, name = 'TuddoFsError') {
    super(message)
    this.name = name
    this.context = normalizeContext(context)
    this.tenant = this.context.tenant
    this.mount = this.context.mount
    this.path = this.context.path
    this.ref = this.context.ref
  }
}

/** The package-owned schema no longer matches the frozen §4.1 contract. @see spec §9 */
export class SchemaDriftError extends TuddoFsError {
  constructor(reason = 'Agent FS schema drift detected', context?: Partial<ErrorContext>) {
    super(reason, context, 'SchemaDriftError')
  }
}

/** An internal content-addressed invariant was violated. @see spec §9 */
export class InvariantError extends TuddoFsError {
  constructor(reason: string, context?: Partial<ErrorContext>) {
    super(reason, context, 'InvariantError')
  }
}

/** Grant refused a filesystem operation. @see spec §9 */
export class PermissionDeniedError extends TuddoFsError {
  constructor(reason = 'Permission denied', context?: Partial<ErrorContext>) {
    super(reason, context, 'PermissionDeniedError')
  }
}

/** The caller's optimistic file precondition did not hold. @see spec §9 */
export class PreconditionFailedError extends TuddoFsError {
  readonly expectedSha: string | null | undefined
  readonly actualSha: string | null | undefined

  constructor(
    expectedSha: string | null | undefined,
    actualSha: string | null | undefined,
    context?: Partial<ErrorContext>,
  ) {
    super(
      `Precondition failed: expected ${expectedSha ?? 'absent'}, found ${actualSha ?? 'absent'}`,
      context,
      'PreconditionFailedError',
    )
    this.expectedSha = expectedSha
    this.actualSha = actualSha
  }
}

/** The ref compare-and-swap was exhausted. @see spec §9 */
export class RefConflictError extends TuddoFsError {
  readonly attempts: number

  constructor(context?: Partial<ErrorContext>, attempts = 3) {
    super('Ref update conflicted after retrying', context, 'RefConflictError')
    this.attempts = attempts
  }
}

/** A requested path, ref, or commit does not exist. @see spec §9 */
export class NotFoundError extends TuddoFsError {
  constructor(resource = 'Resource not found', context?: Partial<ErrorContext>) {
    super(resource, context, 'NotFoundError')
  }
}

/** A branch was already merged, abandoned, or otherwise settled. @see spec §9 */
export class BranchSettledError extends TuddoFsError {
  readonly state: string

  constructor(state: string, context?: Partial<ErrorContext>) {
    super(`Branch is settled (${state}); open a new session`, context, 'BranchSettledError')
    this.state = state
  }
}

/** A staged writer attempted to merge without an approver. @see spec §9 */
export class MergePendingApprovalError extends TuddoFsError {
  constructor(context?: Partial<ErrorContext>) {
    super('Merge is pending approval', context, 'MergePendingApprovalError')
  }
}

/** The host grant resolver failed closed. @see spec §9 */
export class GrantResolverError extends TuddoFsError {
  constructor(reason = 'Grant resolver failed', context?: Partial<ErrorContext>) {
    super(reason, context, 'GrantResolverError')
  }
}

/** Object storage failed. @see spec §9 */
export class StorageError extends TuddoFsError {
  constructor(reason = 'Object storage failed', context?: Partial<ErrorContext>) {
    super(reason, context, 'StorageError')
  }
}

export type KernelError =
  | InvalidPathError
  | InvalidMountKeyError
  | InvalidCommitTimestampError
  | PermissionDeniedError
  | PreconditionFailedError
  | RefConflictError
  | NotFoundError
  | BranchSettledError
  | MergePendingApprovalError
  | GrantResolverError
  | StorageError
  | SchemaDriftError
  | InvariantError
