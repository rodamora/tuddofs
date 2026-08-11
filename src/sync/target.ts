/**
 * The universal sync seam defined by architecture §7.1.
 *
 * Four verbs, no provider SDK, ever. Every runtime the engine can drive — a
 * local directory (§7.1.1), SSH (§7.1.2), a sandbox provider (§7.1.3) — is this
 * interface and nothing more. The engine imports this module; it never imports
 * a target implementation.
 */

/** Per-call exec controls; every target enforces a bounded runtime. */
export interface ExecOptions {
  /** Hard wall-clock limit; the target kills the command when it elapses. */
  readonly timeoutMs?: number
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

/** The four verbs the sync engine is allowed to require of any runtime (§7.1). */
export interface SyncTarget {
  exec(cmd: string, opts?: ExecOptions): Promise<ExecResult>
  readFile(path: string): Promise<Buffer>
  writeFile(path: string, bytes: Buffer): Promise<void>
  mkdir(path: string): Promise<void>
}
