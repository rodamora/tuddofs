import { TuddoFsError } from './errors.js'
import type { ErrorContext } from './errors.js'

/**
 * Error raised when a file path violates the kernel path contract.
 */
export class InvalidPathError extends TuddoFsError {
  constructor(path: unknown, reason: string, context?: Partial<ErrorContext>) {
    super(
      `Invalid path: ${reason}`,
      { ...context, path: typeof path === 'string' ? path : context?.path },
      'InvalidPathError',
    )
  }
}

/**
 * Error raised when a mount key violates the ref-name contract.
 */
export class InvalidMountKeyError extends TuddoFsError {
  readonly mountKey: unknown

  constructor(mountKey: unknown, context?: Partial<ErrorContext>) {
    super(
      'Invalid mount key: must match /^[a-z0-9][a-z0-9:._-]{0,63}$/',
      { ...context, mount: typeof mountKey === 'string' ? mountKey : context?.mount },
      'InvalidMountKeyError',
    )
    this.mountKey = mountKey
  }
}

/**
 * Error raised when a commit timestamp is not canonical UTC millisecond precision.
 */
export class InvalidCommitTimestampError extends TuddoFsError {
  readonly timestamp: unknown

  constructor(timestamp: unknown, context?: Partial<ErrorContext>) {
    super(
      'Invalid commit timestamp: must match ISO-8601 UTC millisecond precision',
      context,
      'InvalidCommitTimestampError',
    )
    this.timestamp = timestamp
  }
}

/**
 * Normalize a path to NFC, then validate it without repairing invalid syntax.
 */
export function validatePath(path: string, context?: Partial<ErrorContext>): string {
  if (typeof path !== 'string') {
    throw new InvalidPathError(path, 'path must be a string', context)
  }

  const normalized = path.normalize('NFC')
  if (!/^\/[^\0]*$/u.test(normalized)) {
    throw new InvalidPathError(path, 'must start with / and contain no NUL byte', context)
  }
  if (normalized === '/') {
    throw new InvalidPathError(path, 'root is not a file path', context)
  }
  if (normalized.includes('//')) {
    throw new InvalidPathError(path, 'must not contain repeated separators', context)
  }
  if (normalized.endsWith('/')) {
    throw new InvalidPathError(path, 'must not have a trailing separator', context)
  }

  const segments = normalized.slice(1).split('/')
  if (segments.some(segment => segment === '.' || segment === '..')) {
    throw new InvalidPathError(path, 'must not contain . or .. segments', context)
  }
  if (Buffer.byteLength(normalized, 'utf8') > 1024) {
    throw new InvalidPathError(path, 'must be at most 1024 UTF-8 bytes', context)
  }

  return normalized
}

/**
 * Validate a mount key exactly as supplied; mount keys are never normalized.
 */
export function validateMountKey(mountKey: string, context?: Partial<ErrorContext>): string {
  if (typeof mountKey !== 'string' || !/^[a-z0-9][a-z0-9:._-]{0,63}$/u.test(mountKey)) {
    throw new InvalidMountKeyError(mountKey, context)
  }
  return mountKey
}
