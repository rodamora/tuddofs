/**
 * Pure argv and remote-script construction for the SSH {@link SyncTarget}
 * (architecture §7.1, target 2).
 *
 * Spec: §7.1 (four verbs, no provider SDK), §7.4 (everything interpolated into
 * an exec line is hostile until quoted; destructive execs refuse any path that
 * does not resolve strictly under `<root>`), §13.4 (the SSH target is exercised
 * behind an opt-in flag).
 *
 * This module is where the network target's security properties are decided,
 * and it is pure so they can be asserted without a host:
 *
 * - **Nothing is concatenated into an ssh command line.** Connection settings
 *   are separate argv entries; only the REMOTE script is a string, and every
 *   value interpolated into it goes through {@link quoteShellArg}.
 * - **The remote root guard mirrors the local target's `confine`.** A lexical
 *   check runs client-side, and the remote script then resolves the deepest
 *   existing ancestor with `pwd -P` and refuses anything that lands outside the
 *   root through a symlinked directory. The final component is refused when it
 *   is a symlink, which is the O_NOFOLLOW half of the same guarantee.
 * - **The remote exit status is reported by the remote, not inferred from ssh.**
 *   OpenSSH collapses "the remote command died from a signal" and "the
 *   transport failed" into exit 255, which would turn a killed exec into an
 *   unexplained target error and vice versa. The wrapper prints the real `$?`
 *   behind a per-exec nonce, so a killed command reports `128 + signal` exactly
 *   as the local target does, agent output cannot forge it, and a truncated
 *   stream is detected as a transport failure instead of read as success.
 * - **The remote command is bounded remotely.** Killing the local ssh client
 *   leaves the remote command running (measured), so `exec` runs under
 *   `timeout -s KILL`, matching the local target's process-group SIGKILL and
 *   its `128 + SIGKILL` exit code.
 *
 * The remote side is POSIX `sh` plus the GNU coreutils the engine already
 * requires at acquire (§7.3 phase 1 step 1).
 */
import posix from 'node:path/posix'

import { InvalidPathError } from '../validation.js'
import { quoteShellArg, resolveUnderRoot } from './paths.js'

/** Connection settings for one ssh destination. Key-based auth only. */
export interface SshConnectionOptions {
  /** Hostname or IP of the target host. */
  readonly host: string
  /** Remote login user; omitted means ssh's own default for the destination. */
  readonly user?: string
  /** Remote port; omitted means 22. */
  readonly port?: number
  /** Private key file. Passing one pins authentication to it (`IdentitiesOnly`). */
  readonly identityFile?: string
  /** `known_hosts` file used to verify the host key. */
  readonly knownHostsFile?: string
  /** Host-key policy; defaults to `yes`, which refuses an unknown host. */
  readonly strictHostKeyChecking?: 'yes' | 'accept-new' | 'no'
  /** TCP connect bound, rounded up to whole seconds for `ConnectTimeout`. */
  readonly connectTimeoutMs?: number
  /**
   * Extra `-o` settings, e.g. `ControlMaster=auto` for connection reuse. They
   * outrank the settings derived from the fields above and never outrank the
   * non-interactive guarantee.
   */
  readonly sshOptions?: readonly string[]
}

/** Inputs for one guarded remote batch file operation. */
export interface RemoteBatchPathScriptInput {
  /** Workspace root as the caller spelled it; used for lexical guards. */
  readonly root: string
  /** Workspace root as the remote resolved it (`pwd -P`). */
  readonly realRoot: string
  /** Absolute or root-relative file paths whose parent directories are guarded. */
  readonly paths: readonly string[]
}

/** Inputs for one guarded remote file operation. */
export interface RemotePathScriptInput {
  /** Workspace root as the caller spelled it; used for the lexical guard. */
  readonly root: string
  /** Workspace root as the remote resolved it (`pwd -P`); used for the remote guard. */
  readonly realRoot: string
  /** Absolute remote path, or one relative to the root. */
  readonly path: string
  /** Refuse a symlinked final component (`readFile` / `writeFile`). */
  readonly refuseSymlink?: boolean
}

/** Marker the exec wrapper prints before the remote exit status. */
export const EXEC_SENTINEL_PREFIX = '__tuddofs_exit_'

/**
 * Exit codes the remote guard uses. They sit in the 64–78 range reserved by
 * `sysexits.h` for application errors, so they cannot collide with the 0–1 a
 * refused `cat` returns, with 126/127, or with ssh's own 255.
 */
export const GUARD_EXIT = {
  /** No ancestor of the path exists inside the workspace root. */
  noAncestor: 66,
  /** The deepest existing ancestor resolves outside the workspace root. */
  escapesRoot: 67,
  /** The final component is a symlink. */
  symlink: 68,
} as const

const DEFAULT_CONNECT_TIMEOUT_MS = 10_000

/** `user@host`, or the bare host when the caller left the user to ssh. */
export function sshDestination(options: Pick<SshConnectionOptions, 'host' | 'user'>): string {
  return options.user === undefined ? options.host : `${options.user}@${options.host}`
}

/**
 * Build the ssh argv up to and including the destination. The caller appends
 * the remote script as the final argument.
 *
 * Ordering IS the precedence rule: OpenSSH keeps the FIRST value it sees for a
 * repeated `-o`, so the three settings that make the target non-interactive
 * come first and cannot be overridden by a host, host `sshOptions` come next,
 * and the settings derived from the typed fields come last.
 */
export function sshArgv(options: SshConnectionOptions): readonly string[] {
  const argv: string[] = [
    // No TTY: the remote command's stdin and stdout are a byte pipe, which is
    // what readFile and writeFile transfer through.
    '-T',
    '-o',
    'BatchMode=yes',
    '-o',
    'PasswordAuthentication=no',
    '-o',
    'KbdInteractiveAuthentication=no',
  ]
  for (const option of options.sshOptions ?? []) argv.push('-o', option)
  argv.push('-o', `StrictHostKeyChecking=${options.strictHostKeyChecking ?? 'yes'}`)
  argv.push(
    '-o',
    `ConnectTimeout=${Math.max(1, Math.ceil((options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS) / 1000))}`,
  )
  if (options.knownHostsFile !== undefined) argv.push('-o', `UserKnownHostsFile=${options.knownHostsFile}`)
  if (options.identityFile !== undefined) argv.push('-i', options.identityFile, '-o', 'IdentitiesOnly=yes')
  if (options.port !== undefined) argv.push('-p', String(options.port))
  argv.push(sshDestination(options))
  return argv
}

/** Create the workspace root if needed and report the path the remote resolves it to. */
export function remoteRootScript(root: string): string {
  const quoted = quoteShellArg(root)
  return `mkdir -p ${quoted} && cd ${quoted} && pwd -P`
}

/**
 * Wrap one agent command: run it in the workspace root, bound by a remote
 * timeout, with stderr merged into stdout exactly as the local target does, and
 * report the true exit status behind `nonce`.
 */
export function remoteExecScript(input: {
  readonly root: string
  readonly command: string
  readonly timeoutMs: number
  readonly nonce: string
}): string {
  const seconds = (Math.max(input.timeoutMs, 1) / 1000).toFixed(3)
  const sentinel = quoteShellArg(`\\n${EXEC_SENTINEL_PREFIX}${input.nonce}:%s`)
  return (
    `{ cd ${quoteShellArg(input.root)} && ` +
    `timeout -s KILL ${seconds} sh -c ${quoteShellArg(input.command)}; } 2>&1; ` +
    `printf ${sentinel} "$?"`
  )
}

/**
 * Read the remote exit status out of an exec's output, returning the output
 * with the marker removed.
 *
 * `undefined` means the wrapper never got to print — a dropped connection, a
 * refused login, a truncated stream — and the caller MUST treat that as a
 * target failure rather than as an exit code. Agent output cannot fake a
 * status: the marker is nonce-bound and the wrapper always prints last, so the
 * final marker is the real one.
 */
export function parseExecSentinel(raw: string, nonce: string): { exitCode: number; output: string } | undefined {
  const marker = `\n${EXEC_SENTINEL_PREFIX}${nonce}:`
  const at = raw.lastIndexOf(marker)
  if (at === -1) return undefined
  const status = raw.slice(at + marker.length)
  if (!/^\d+$/u.test(status)) return undefined
  return { exitCode: Number(status), output: raw.slice(0, at) }
}

/**
 * The remote half of the root guard: resolve the deepest existing ancestor with
 * `pwd -P` and refuse anything outside the root, then optionally refuse a
 * symlinked final component. The lexical half runs here, client-side, so an
 * obvious escape never reaches the network.
 */
export function remoteGuardScript(input: RemotePathScriptInput): string {
  const target = resolveUnderRoot(input.root, input.path)
  const lines = [
    `p=${quoteShellArg(target)}`,
    `probe=${quoteShellArg(posix.dirname(target))}`,
    `root=${quoteShellArg(input.realRoot)}`,
    'while :; do',
    '  if resolved=$(cd "$probe" 2>/dev/null && pwd -P); then break; fi',
    '  parent=$(dirname "$probe")',
    `  if [ "$parent" = "$probe" ]; then echo 'tuddofs: has no existing ancestor inside the workspace root' >&2; exit ${GUARD_EXIT.noAncestor}; fi`,
    '  probe=$parent',
    'done',
    // Quoted case patterns are literals, so a root containing a glob character
    // still matches itself and only itself.
    `case "$resolved" in "$root"|"$root"/*) ;; *) echo 'tuddofs: resolves outside the workspace root through a symlink' >&2; exit ${GUARD_EXIT.escapesRoot} ;; esac`,
  ]
  if (input.refuseSymlink === true) {
    lines.push(
      `if [ -L "$p" ]; then echo 'tuddofs: is a symlink; the sync target never follows symlinks' >&2; exit ${GUARD_EXIT.symlink}; fi`,
    )
  }
  return lines.join('\n')
}

/**
 * Guard every unique parent directory of each batch member in one remote
 * script. The batch guard intentionally checks only existing ancestors, so
 * sharing a parent makes those checks identical. Every member is still
 * resolved client-side before deduplication, and the representative path is
 * quoted by remoteGuardScript.
 */
function remoteBatchGuardScript(input: RemoteBatchPathScriptInput): string {
  const firstPathByParent = new Map<string, string>()
  for (const path of input.paths) {
    const parent = posix.dirname(resolveUnderRoot(input.root, path))
    if (!firstPathByParent.has(parent)) firstPathByParent.set(parent, path)
  }
  return [...firstPathByParent.values()]
    .map(path =>
      remoteGuardScript({
        root: input.root,
        realRoot: input.realRoot,
        path,
        refuseSymlink: false,
      }),
    )
    .join('\n')
}

/** Extract a PAX archive into the guarded workspace root. */
export function remoteWriteFilesScript(input: RemoteBatchPathScriptInput): string {
  return `${remoteBatchGuardScript(input)}\ncd ${quoteShellArg(input.root)} && tar -x --unlink-first -f -`
}

/** Create a NUL-list-driven POSIX PAX archive from the guarded workspace root. */
export function remoteReadFilesScript(input: RemoteBatchPathScriptInput): string {
  return `${remoteBatchGuardScript(input)}\ncd ${quoteShellArg(input.root)} && tar -c --format=posix --null --files-from=- -f -`
}

/** Guarded `cat`: the file's bytes are the remote command's stdout, unmodified. */
export function remoteReadScript(input: RemotePathScriptInput): string {
  return `${remoteGuardScript({ ...input, refuseSymlink: true })}\ncat -- "$p"`
}

/** Guarded truncate-and-write: the bytes arrive on the remote command's stdin. */
export function remoteWriteScript(input: RemotePathScriptInput): string {
  return `${remoteGuardScript({ ...input, refuseSymlink: true })}\ncat > "$p"`
}

/**
 * Guarded recursive mkdir. There is no symlink refusal here on purpose: the
 * local target's `fs.mkdir(…, { recursive: true })` succeeds over an existing
 * symlinked directory too, and the ancestor check already refuses one that
 * leaves the root.
 */
export function remoteMkdirScript(input: RemotePathScriptInput): string {
  return `${remoteGuardScript({ ...input, refuseSymlink: false })}\nmkdir -p -- "$p"`
}

/**
 * Translate a guard exit code into the same typed error the local target
 * throws. Anything else is not a path decision and belongs to the caller.
 */
export function guardFailure(path: string, exitCode: number, stderr: string): InvalidPathError | undefined {
  const reason = ((): string | undefined => {
    switch (exitCode) {
      case GUARD_EXIT.noAncestor:
        return 'has no existing ancestor inside the workspace root'
      case GUARD_EXIT.escapesRoot:
        return 'resolves outside the workspace root through a symlink'
      case GUARD_EXIT.symlink:
        return 'is a symlink; the sync target never follows symlinks'
      default:
        return undefined
    }
  })()
  if (reason === undefined) return undefined
  const detail = stderr.trim()
  return new InvalidPathError(path, detail.length > 0 ? `${reason} (${detail})` : reason)
}
