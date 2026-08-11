import { TuddoFsError } from './errors.js'
import type { ErrorContext } from './errors.js'

/**
 * Error raised when a file path violates architecture §4.3 syntax or tree coherence.
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
 * Normalize and validate a path under the architecture §4.3 contract without repairing invalid syntax.
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

type PathCollection = {
  has(path: string): boolean
  keys(): IterableIterator<string>
}

/**
 * A file-prefix collision that violates the tree-coherence invariant in architecture §4.3.
 */
export type TreeCoherenceCollision = {
  readonly path: string
  readonly collidingPath: string
}

/**
 * Find the existing file that would make `path` incoherent under architecture
 * §4.3, whether the existing file is an ancestor or a descendant.
 */
export function findPathCollision(path: string, paths: PathCollection): string | undefined {
  for (let separator = path.indexOf('/', 1); separator !== -1; separator = path.indexOf('/', separator + 1)) {
    const ancestor = path.slice(0, separator)
    if (paths.has(ancestor)) return ancestor
  }

  const directoryPrefix = `${path}/`
  let descendant: string | undefined
  for (const candidate of paths.keys()) {
    if (candidate.startsWith(directoryPrefix) && (descendant === undefined || candidate < descendant)) {
      descendant = candidate
    }
  }
  return descendant
}

/**
 * Return every file-prefix pair that violates the flat-tree coherence
 * invariant in architecture §4.3.
 */
export function findTreeCoherenceCollisions(paths: Iterable<string>): readonly TreeCoherenceCollision[] {
  const pathSet = new Set(paths)
  const collisions: TreeCoherenceCollision[] = []
  for (const collidingPath of pathSet) {
    for (
      let separator = collidingPath.indexOf('/', 1);
      separator !== -1;
      separator = collidingPath.indexOf('/', separator + 1)
    ) {
      const path = collidingPath.slice(0, separator)
      if (pathSet.has(path)) collisions.push({ path, collidingPath })
    }
  }
  collisions.sort((left, right) => {
    if (left.path !== right.path) return left.path < right.path ? -1 : 1
    if (left.collidingPath === right.collidingPath) return 0
    return left.collidingPath < right.collidingPath ? -1 : 1
  })
  return collisions
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
