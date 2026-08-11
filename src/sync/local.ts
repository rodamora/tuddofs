/**
 * The local-directory {@link SyncTarget} (architecture §7.1, target 1).
 *
 * A governed workspace for CLI and harness agents on a machine you already
 * trust, and the reason the whole engine is testable with zero infrastructure.
 *
 * SECURITY — READ THIS BEFORE SHIPPING IT:
 * grant confinement protects the FILESYSTEM VIEW, not the HOST. `exec` runs a
 * real shell as the host process user with the host's environment and network.
 * Nothing here sandboxes the command: an agent that can run `exec` can do
 * anything that user can do. This target is for code you already trust on a
 * machine you already trust. Untrusted code belongs in a sandbox provider
 * target (§7.1.3), never here.
 *
 * What IS confined, and enforced on every call (§7.4):
 * - `readFile` / `writeFile` / `mkdir` refuse any path that does not resolve
 *   strictly under the root, whether it is absolute, relative, or `..`-laden.
 * - Symlinks are never followed. A symlinked final component is refused
 *   (`O_NOFOLLOW`), and a symlinked intermediate directory that leaves the root
 *   is refused by re-checking the deepest existing ancestor's real path. This is
 *   the same hazard `find -type f` avoids by not taking `-L`: a link to
 *   `/etc/passwd` must never become a commit.
 */
import { spawn } from 'node:child_process'
import { constants as fsConstants } from 'node:fs'
import { mkdir as fsMkdir, open as fsOpen, realpath } from 'node:fs/promises'
import { constants as osConstants } from 'node:os'
import posix from 'node:path/posix'

import { InvalidPathError } from '../validation.js'
import { resolveUnderRoot } from './paths.js'
import type { ExecOptions, ExecResult, SyncTarget } from './target.js'

/** Construction options for {@link createLocalDirectoryTarget}. */
export interface LocalDirectoryTargetOptions {
  /** Workspace root. Created on first use; every path is confined below it. */
  readonly root: string
  /** POSIX shell used for `exec`. Defaults to `/bin/sh`. */
  readonly shell?: string
  /** Default wall-clock limit for `exec`, overridable per call. */
  readonly execTimeoutMs?: number
  /** Environment for `exec`. Defaults to the host process environment. */
  readonly env?: NodeJS.ProcessEnv
}

/** A {@link SyncTarget} backed by a real directory on the host filesystem. */
export interface LocalDirectoryTarget extends SyncTarget {
  readonly root: string
}

const DEFAULT_EXEC_TIMEOUT_MS = 120_000
const SIGKILL_EXIT_CODE = 128 + osConstants.signals.SIGKILL

/**
 * Build a local-directory target. The root is created on demand, so a caller can
 * point at a path that does not exist yet; `mkdir` on the four-verb seam is for
 * directories *inside* the workspace (§7.1).
 */
export function createLocalDirectoryTarget(options: LocalDirectoryTargetOptions): LocalDirectoryTarget {
  const root = posix.resolve(options.root)
  const shell = options.shell ?? '/bin/sh'
  const defaultTimeoutMs = options.execTimeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS
  let rootReady: Promise<string> | undefined

  /** Create the root once and remember its real path for the symlink guard. */
  const ensureRoot = (): Promise<string> => {
    rootReady ??= fsMkdir(root, { recursive: true }).then(() => realpath(root))
    return rootReady
  }

  /**
   * Resolve `candidate` under the root and prove that the deepest directory that
   * actually exists on the way there is still inside the root. Lexical
   * resolution alone is not enough: a symlinked intermediate directory would
   * pass it and then leave the workspace on open.
   */
  const confine = async (candidate: string): Promise<string> => {
    const realRoot = await ensureRoot()
    const target = resolveUnderRoot(root, candidate)
    let probe = posix.dirname(target)
    for (;;) {
      const resolved = await realpath(probe).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null
        throw error
      })
      if (resolved !== null) {
        if (resolved !== realRoot && !resolved.startsWith(`${realRoot}/`)) {
          throw new InvalidPathError(candidate, `resolves outside the workspace root ${realRoot} through a symlink`)
        }
        return target
      }
      const parent = posix.dirname(probe)
      if (parent === probe) throw new InvalidPathError(candidate, 'has no existing ancestor inside the workspace root')
      probe = parent
    }
  }

  const symlinkRefusal = (candidate: string, error: unknown): never => {
    if ((error as NodeJS.ErrnoException).code === 'ELOOP') {
      throw new InvalidPathError(candidate, 'is a symlink; the sync target never follows symlinks')
    }
    throw error
  }

  return {
    root,

    async exec(cmd: string, execOptions: ExecOptions = {}): Promise<ExecResult> {
      await ensureRoot()
      const timeoutMs = execOptions.timeoutMs ?? defaultTimeoutMs
      return new Promise<ExecResult>((resolve, reject) => {
        const child = spawn(shell, ['-c', cmd], {
          cwd: root,
          env: options.env ?? process.env,
          stdio: ['ignore', 'pipe', 'pipe'],
          // Its own process group, so a timeout kills the command AND everything
          // it spawned. Killing only the shell leaves grandchildren holding the
          // stdio pipes open and the exec never settles.
          detached: true,
        })
        // Buffers are concatenated only at close: decoding per chunk would split
        // a multi-byte filename across reads and corrupt scan output.
        const chunks: Buffer[] = []
        child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk))
        child.stderr.on('data', (chunk: Buffer) => chunks.push(chunk))
        const timer = setTimeout(() => {
          if (child.pid === undefined) return
          try {
            process.kill(-child.pid, 'SIGKILL')
          } catch {
            child.kill('SIGKILL')
          }
        }, timeoutMs)
        timer.unref()
        child.once('error', error => {
          clearTimeout(timer)
          reject(error)
        })
        child.once('close', (code, signal) => {
          clearTimeout(timer)
          const signalled = signal === null ? null : ((osConstants.signals[signal] as number | undefined) ?? 0)
          resolve({
            exitCode: code ?? (signalled === null ? SIGKILL_EXIT_CODE : 128 + signalled),
            output: Buffer.concat(chunks).toString('utf8'),
          })
        })
      })
    },

    async readFile(path: string): Promise<Buffer> {
      const target = await confine(path)
      const handle = await fsOpen(target, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW).catch(error =>
        symlinkRefusal(path, error),
      )
      try {
        return await handle.readFile()
      } finally {
        await handle.close()
      }
    },

    async writeFile(path: string, bytes: Buffer): Promise<void> {
      const target = await confine(path)
      const handle = await fsOpen(
        target,
        fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | fsConstants.O_NOFOLLOW,
        0o644,
      ).catch(error => symlinkRefusal(path, error))
      try {
        await handle.writeFile(bytes)
      } finally {
        await handle.close()
      }
    },

    async mkdir(path: string): Promise<void> {
      await fsMkdir(await confine(path), { recursive: true })
    },
  }
}
