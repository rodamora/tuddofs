/**
 * The §7.5 kill matrix against the local-directory target (§7.1, target 1).
 *
 * The cases live in `sync-kill-matrix.ts` and are shared with the SSH target
 * (`sync-ssh-target.ssh.test.ts`): the engine's contract is the four-verb seam,
 * so its acceptance suite is written once and run against every target. This
 * file is the local half — zero infrastructure, per §11 S1.
 */
import { chmod, lstat, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import posix from 'node:path/posix'

import { createLocalDirectoryTarget, type SyncTarget } from '../internal.js'
import { controlledTarget, runKillMatrix, type KillMatrixWorkspace, type WorkspaceDisk } from './sync-kill-matrix.js'

/** `node:fs` is the out-of-band hand that shell tools and host processes would be. */
const localDisk: WorkspaceDisk = {
  async readText(path) {
    return readFile(path, 'utf8')
  },
  async writeText(path, content) {
    await writeFile(path, content)
  },
  async stat(path) {
    // lstat, never stat: a planted symlink must be observable as itself.
    const stats = await lstat(path).catch(() => undefined)
    return stats === undefined ? undefined : { mtimeMs: stats.mtimeMs, mode: stats.mode }
  },
  async symlink(existingPath, linkPath) {
    await symlink(existingPath, linkPath)
  },
  async chmod(path, mode) {
    await chmod(path, mode)
  },
}

/**
 * A local target that can be taken away. The kill is simulated because a local
 * directory has no daemon to kill — the SSH harness kills a real one, which is
 * exactly why the same matrix runs there too.
 */
function killable(target: SyncTarget): { target: SyncTarget; kill: () => void; revive: () => void } {
  let killed = false
  const alive = (): void => {
    if (killed) throw new Error('target killed')
  }
  return {
    kill: () => {
      killed = true
    },
    revive: () => {
      killed = false
    },
    target: {
      async exec(cmd, opts) {
        alive()
        return target.exec(cmd, opts)
      },
      async readFile(path) {
        alive()
        return target.readFile(path)
      },
      async writeFile(path, bytes) {
        alive()
        return target.writeFile(path, bytes)
      },
      async mkdir(path) {
        alive()
        return target.mkdir(path)
      },
    },
  }
}

runKillMatrix({
  name: 'local',
  tenant: 'sync-engine-integration',

  async create(): Promise<KillMatrixWorkspace> {
    // The workspace sits one level inside its own temp directory, so the cases
    // that plant a file OUTSIDE the root still clean up with it.
    const base = await mkdtemp(posix.join(tmpdir(), 'tuddofs-engine-'))
    const root = posix.join(base, 'workspace')
    const killableTarget = killable(createLocalDirectoryTarget({ root }))
    const controlled = controlledTarget(killableTarget.target)
    return {
      root,
      target: controlled.target,
      controls: controlled.controls,
      disk: localDisk,
      async kill() {
        killableTarget.kill()
      },
      async revive() {
        killableTarget.revive()
      },
      async dispose() {
        await chmod(root, 0o755).catch(() => undefined)
        await rm(base, { recursive: true, force: true }).catch(() => undefined)
      },
    }
  },

  async createProbeFailureTarget() {
    const root = await mkdtemp(posix.join(tmpdir(), 'tuddofs-probe-'))
    return {
      root,
      target: {
        exec: async () => ({ exitCode: 127, output: 'sha256sum: not found' }),
        readFile: async () => Buffer.alloc(0),
        writeFile: async () => undefined,
        mkdir: async () => undefined,
      },
    }
  },
})
