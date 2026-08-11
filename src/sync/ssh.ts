/**
 * The SSH {@link SyncTarget} (architecture §7.1, target 2).
 *
 * The cheapest honest remote: a real network, real quoting hazards, and no
 * vendor SDK. It exists to prove the four-verb seam is portable — the engine
 * needs ZERO knowledge that its target is remote (§7.1, §14 risk 2).
 *
 * REQUIREMENTS, and why they are requirements rather than dependencies:
 * - An `ssh` client binary on the host running this package. Core ships no
 *   provider SDK and no protocol implementation (§10 rule 1, §10 rule 3): the
 *   package spawns `ssh` through `node:child_process` and keeps its dependency
 *   count at zero. Set `sshBinary` to point at a specific client.
 * - Key-based, non-interactive authentication. `BatchMode=yes`,
 *   `PasswordAuthentication=no`, and `KbdInteractiveAuthentication=no` are
 *   fixed and cannot be overridden through `sshOptions`: an agent runtime that
 *   can block on a password prompt is a hung agent runtime.
 * - A POSIX `sh` login shell and the GNU coreutils the engine probes for at
 *   acquire (§7.3 phase 1 step 1). `materialize()` fails loudly against a
 *   busybox host, by design.
 *
 * SECURITY — the same division as the local target, with the blast radius moved:
 * `readFile` / `writeFile` / `mkdir` are confined to the workspace root on BOTH
 * sides of the network (lexically here, and with `pwd -P` on the host, which is
 * what catches a symlinked directory), and they refuse a symlinked final
 * component. `exec` is an unconfined shell as the remote login user — that is
 * the point of a remote target, and it is the remote host's isolation that
 * bounds it, not this code.
 *
 * PERFORMANCE: one ssh invocation per verb, no connection pooling (an explicit
 * S2 non-goal). A host that wants multiplexing passes it through as ordinary
 * ssh configuration, e.g.
 * `sshOptions: ['ControlMaster=auto', 'ControlPath=/tmp/tuddofs-%C', 'ControlPersist=60']`.
 */
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { constants as osConstants } from 'node:os'
import posix from 'node:path/posix'

import { SyncTargetError } from './errors.js'
import {
  guardFailure,
  parseExecSentinel,
  remoteExecScript,
  remoteMkdirScript,
  remoteReadScript,
  remoteRootScript,
  remoteWriteScript,
  sshArgv,
  sshDestination,
  type SshConnectionOptions,
} from './ssh-shell.js'
import type { ExecOptions, ExecResult, SyncTarget } from './target.js'

/** Construction options for {@link createSshTarget}. */
export interface SshTargetOptions extends SshConnectionOptions {
  /** Workspace root ON THE REMOTE HOST. Created on demand; every path is confined below it. */
  readonly root: string
  /** Default wall-clock limit for `exec`, enforced remotely and locally. */
  readonly execTimeoutMs?: number
  /** ssh client to spawn. Defaults to `ssh` from `PATH`. */
  readonly sshBinary?: string
  /** Environment for the LOCAL ssh process (`SSH_AUTH_SOCK`, `HOME`, …). Defaults to the host process environment. */
  readonly env?: NodeJS.ProcessEnv
}

/** A {@link SyncTarget} backed by a directory on a host reachable over SSH. */
export interface SshTarget extends SyncTarget {
  /** Workspace root on the remote host. */
  readonly root: string
  /** `user@host`, or the bare host, as passed to the ssh client. */
  readonly destination: string
}

const DEFAULT_EXEC_TIMEOUT_MS = 120_000
/**
 * Grace given to the remote `timeout` before the local client is killed too.
 * The remote bound is the one that reports a real `128 + SIGKILL`; the local
 * one only exists for a wedged connection, where nothing remote will ever
 * answer.
 */
const LOCAL_TIMEOUT_SLACK_MS = 5_000
const SIGKILL_EXIT_CODE = 128 + osConstants.signals.SIGKILL

type SshRun = {
  readonly exitCode: number
  readonly stdout: Buffer
  readonly stderr: string
  /** The local watchdog killed the client: nothing remote answered in time. */
  readonly timedOut: boolean
}

/**
 * Build an SSH target. Nothing connects until the first verb; the root is
 * created on the remote host on first use, like the local target's.
 */
export function createSshTarget(options: SshTargetOptions): SshTarget {
  const root = posix.resolve(options.root)
  const destination = sshDestination(options)
  const binary = options.sshBinary ?? 'ssh'
  const connection = sshArgv(options)
  const defaultTimeoutMs = options.execTimeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS
  let realRoot: Promise<string> | undefined

  const runSsh = (input: { script: string; stdin?: Buffer; timeoutMs: number }): Promise<SshRun> =>
    new Promise<SshRun>((resolve, reject) => {
      const child = spawn(binary, [...connection, input.script], {
        env: options.env ?? process.env,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      const stdout: Buffer[] = []
      const stderr: Buffer[] = []
      let timedOut = false
      child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk))
      child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk))
      // A remote command that exits without draining stdin closes the pipe
      // under our feet; that is the remote's answer, not a local failure.
      child.stdin.on('error', () => undefined)
      child.stdin.end(input.stdin)
      const timer = setTimeout(() => {
        timedOut = true
        child.kill('SIGKILL')
      }, input.timeoutMs)
      timer.unref()
      child.once('error', (error: NodeJS.ErrnoException) => {
        clearTimeout(timer)
        reject(
          new SyncTargetError(
            error.code === 'ENOENT'
              ? `ssh client ${binary} is not available; the SSH target spawns it rather than bundling a protocol implementation`
              : `ssh client ${binary} failed to start: ${error.message}`,
          ),
        )
      })
      child.once('close', (code, signal) => {
        clearTimeout(timer)
        const signalled = signal === null ? null : ((osConstants.signals[signal] as number | undefined) ?? 0)
        resolve({
          exitCode: code ?? (signalled === null ? SIGKILL_EXIT_CODE : 128 + signalled),
          stdout: Buffer.concat(stdout),
          stderr: Buffer.concat(stderr).toString('utf8'),
          timedOut,
        })
      })
    })

  /**
   * Resolve the workspace root on the remote host, creating it if needed. The
   * `pwd -P` answer is what the remote guard compares against, so a root
   * reached through a symlink is pinned to its real location once, not
   * re-resolved per call. A failed probe is not cached: a target that was
   * unreachable a second ago is reachable again after a restart, and the kill
   * matrix (§7.5) depends on that.
   */
  const ensureRoot = (): Promise<string> => {
    realRoot ??= runSsh({ script: remoteRootScript(root), timeoutMs: defaultTimeoutMs })
      .then(run => {
        if (run.exitCode !== 0) {
          throw new SyncTargetError(
            `workspace root ${root} is not usable on ${destination}`,
            { exitCode: run.exitCode, output: run.stderr },
            { path: root },
          )
        }
        const resolved = run.stdout.toString('utf8').trim()
        if (!resolved.startsWith('/')) {
          throw new SyncTargetError(`workspace root probe on ${destination} returned no path`, {
            output: run.stdout.toString('utf8'),
          })
        }
        return resolved
      })
      .catch((error: unknown) => {
        realRoot = undefined
        throw error
      })
    return realRoot
  }

  /** Run one guarded file verb and translate its exit code into the shared taxonomy. */
  const runGuarded = async (
    path: string,
    script: (input: { root: string; realRoot: string; path: string }) => string,
    what: string,
    stdin?: Buffer,
  ): Promise<Buffer> => {
    const resolvedRoot = await ensureRoot()
    const run = await runSsh({
      script: script({ root, realRoot: resolvedRoot, path }),
      ...(stdin === undefined ? {} : { stdin }),
      timeoutMs: defaultTimeoutMs,
    })
    if (run.exitCode === 0 && !run.timedOut) return run.stdout
    const refusal = guardFailure(path, run.exitCode, run.stderr)
    if (refusal) throw refusal
    throw new SyncTargetError(
      run.timedOut ? `${what} timed out on ${destination}` : `${what} failed on ${destination}`,
      { exitCode: run.exitCode, output: run.stderr },
      { path },
    )
  }

  return {
    root,
    destination,

    async exec(cmd: string, execOptions: ExecOptions = {}): Promise<ExecResult> {
      await ensureRoot()
      const timeoutMs = execOptions.timeoutMs ?? defaultTimeoutMs
      const nonce = randomBytes(16).toString('hex')
      const run = await runSsh({
        script: remoteExecScript({ root, command: cmd, timeoutMs, nonce }),
        timeoutMs: timeoutMs + LOCAL_TIMEOUT_SLACK_MS,
      })
      const reported = parseExecSentinel(run.stdout.toString('utf8'), nonce)
      if (reported === undefined) {
        // No sentinel means the remote shell never finished the wrapper: a
        // refused login, a dropped connection, a truncated stream. Reporting
        // ssh's own status as the command's would turn a transport failure into
        // a plausible-looking exit code, which §7.2 forbids for exactly this
        // reason — a broken scan must be an error, never an empty diff.
        throw new SyncTargetError(
          `ssh transport to ${destination} failed before the command reported its status`,
          { exitCode: run.exitCode, output: run.stderr || run.stdout.toString('utf8') },
          { path: root },
        )
      }
      return reported
    },

    async readFile(path: string): Promise<Buffer> {
      return runGuarded(path, remoteReadScript, 'read')
    },

    async writeFile(path: string, bytes: Buffer): Promise<void> {
      await runGuarded(path, remoteWriteScript, 'write', bytes)
    },

    async mkdir(path: string): Promise<void> {
      await runGuarded(path, remoteMkdirScript, 'mkdir')
    },
  }
}
