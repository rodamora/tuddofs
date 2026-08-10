/**
 * Error raised when a file path violates the kernel path contract.
 * @see spec §4.3
 */
export class InvalidPathError extends Error {
  readonly path: unknown

  constructor(path: unknown, reason: string) {
    super(`Invalid path: ${reason}`)
    this.name = 'InvalidPathError'
    this.path = path
  }
}

/**
 * Error raised when a mount key violates the ref-name contract.
 * @see spec §4.4
 */
export class InvalidMountKeyError extends Error {
  readonly mountKey: unknown

  constructor(mountKey: unknown) {
    super('Invalid mount key: must match /^[a-z0-9][a-z0-9:._-]{0,63}$/')
    this.name = 'InvalidMountKeyError'
    this.mountKey = mountKey
  }
}

/**
 * Normalize a path to NFC, then validate it without repairing invalid syntax.
 * @see spec §4.3
 */
export function validatePath(path: string): string {
  if (typeof path !== 'string') {
    throw new InvalidPathError(path, 'path must be a string')
  }

  const normalized = path.normalize('NFC')
  if (!/^\/[^\0]*$/u.test(normalized)) {
    throw new InvalidPathError(path, 'must start with / and contain no NUL byte')
  }
  if (normalized === '/') {
    throw new InvalidPathError(path, 'root is not a file path')
  }
  if (normalized.includes('//')) {
    throw new InvalidPathError(path, 'must not contain repeated separators')
  }
  if (normalized.endsWith('/')) {
    throw new InvalidPathError(path, 'must not have a trailing separator')
  }

  const segments = normalized.slice(1).split('/')
  if (segments.some(segment => segment === '.' || segment === '..')) {
    throw new InvalidPathError(path, 'must not contain . or .. segments')
  }
  if (Buffer.byteLength(normalized, 'utf8') > 1024) {
    throw new InvalidPathError(path, 'must be at most 1024 UTF-8 bytes')
  }

  return normalized
}

/**
 * Validate a mount key exactly as supplied; mount keys are never normalized.
 * @see spec §4.4
 */
export function validateMountKey(mountKey: string): string {
  if (typeof mountKey !== 'string' || !/^[a-z0-9][a-z0-9:._-]{0,63}$/u.test(mountKey)) {
    throw new InvalidMountKeyError(mountKey)
  }
  return mountKey
}
