/**
 * The universal sync seam defined by architecture §7.1.
 *
 * The per-file and optional batch verbs, with no provider SDK, ever. Every
 * runtime the engine can drive — a local directory (§7.1.1), SSH (§7.1.2), a
 * sandbox provider (§7.1.3) — is this interface and nothing more. The engine
 * imports this module; it never imports a target implementation.
 */

/** Per-call exec controls; every target enforces a bounded runtime. */
export interface ExecOptions {
  /** Hard wall-clock limit; the target kills the command when it elapses. */
  readonly timeoutMs?: number
  /** Bytes to feed to the command's stdin; omitted means an empty stdin stream. */
  readonly stdin?: Buffer
}

/**
 * Result of one command. `output` is stdout and stderr interleaved as the target
 * observed them; a command killed by a signal reports `128 + signal`, matching
 * shell convention, so callers can distinguish it from a clean non-zero exit.
 */
export interface ExecResult {
  readonly exitCode: number
  readonly output: string
}

/**
 * The verbs the sync engine may require of any runtime (§7.1).
 *
 * Batch verbs are optional so targets without meaningful round trips, such as
 * the local-directory target, can use the engine's per-file fallback. The
 * target seam intentionally does not name a wire format; serialization remains
 * a target implementation detail.
 */
export interface SyncTarget {
  exec(cmd: string, opts?: ExecOptions): Promise<ExecResult>
  readFile(path: string): Promise<Buffer>
  writeFile(path: string, bytes: Buffer): Promise<void>
  mkdir(path: string): Promise<void>

  /**
   * Binaries this implementation needs on the target. The engine folds these
   * into the acquire probe so a missing binary fails at materialize, never
   * silently at capture.
   */
  readonly requiredBinaries?: readonly string[]

  /**
   * Write many files in one round trip. Paths are absolute under the workspace
   * root and use the same validation and error taxonomy as writeFile. Parent
   * directories are created, and any member failure rejects the whole call.
   * The timeout caps this one batch operation; the engine may fall back to
   * per-file writes when this optional verb is absent.
   */
  writeFiles?(
    files: readonly { path: string; bytes: Buffer }[],
    options?: { timeoutMs?: number },
  ): Promise<void>

  /**
   * Read many regular files in one round trip, keyed by requested path. Paths
   * are absolute under the workspace root and use the same validation and
   * error taxonomy as readFile. A missing or non-regular member rejects the
   * whole call. The timeout caps this one batch operation; the engine may fall
   * back to per-file reads when this optional verb is absent.
   */
  readFiles?(
    paths: readonly string[],
    options?: { timeoutMs?: number },
  ): Promise<ReadonlyMap<string, Buffer>>
}
