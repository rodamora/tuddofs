/**
 * Disposable SSH hosts for the S2 acceptance suite (architecture §7.1 target 2,
 * §13.4: "SSH target behind an opt-in env flag").
 *
 * Two provisioning modes, chosen by environment:
 *
 * - **Containerized sshd (default).** Each run builds `fixtures/sshd/Dockerfile`,
 *   generates a throwaway ed25519 keypair, and starts its OWN container with a
 *   testcontainers-unique name. Nothing is shared between runs, and nothing is
 *   left behind. Two variants exist because the matrix needs both: a GNU host
 *   for the kill matrix, and a busybox host to prove the §7.3 phase-1 probe
 *   fails loudly at acquire.
 * - **External host (`TUDDOFS_SSH_HOST`).** Any reachable machine with a key
 *   the caller already owns. The kill case degrades to a simulated kill, since
 *   the suite has no business killing a daemon it did not start; the container
 *   path kills the real sshd, and that is the one CI runs.
 *
 * No credentials are committed: the container's authorized key is generated per
 * run and copied in before start.
 */
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import posix from 'node:path/posix'
import { fileURLToPath } from 'node:url'

import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers'

import { createSshTarget, quoteShellArg, type SshTarget, type SshTargetOptions } from '../internal.js'
import type { WorkspaceDisk } from './sync-kill-matrix.js'

/** A provisioned host the suite can open targets against. */
export interface SshHost {
  /** Connection settings for one workspace root on this host. */
  targetOptions(root: string): SshTargetOptions
  /** Base directory under which each workspace gets its own root. */
  readonly workspaceBase: string
  /** Stop the sshd daemon for real, where the host is ours to break. */
  kill(): Promise<void>
  revive(): Promise<void>
  /** True when {@link kill} stops a real daemon rather than a wrapper flag. */
  readonly killsRealDaemon: boolean
  dispose(): Promise<void>
}

const DOCKERFILE_CONTEXT = fileURLToPath(new URL('../../fixtures/sshd', import.meta.url))
const CONTAINER_USER = 'agent'
const READINESS_TIMEOUT_MS = 60_000

/** Run a local binary to completion, failing loudly: the suite never skips silently. */
async function runLocal(binary: string, args: readonly string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(binary, [...args], { stdio: ['ignore', 'ignore', 'pipe'] })
    const stderr: Buffer[] = []
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk))
    child.once('error', reject)
    child.once('close', code => {
      if (code === 0) resolve()
      else reject(new Error(`${binary} exited ${String(code)}: ${Buffer.concat(stderr).toString('utf8')}`))
    })
  })
}

/** Poll until the host answers a trivial command, so readiness is authentication, not a port. */
async function waitForSsh(options: SshTargetOptions): Promise<void> {
  const target = createSshTarget(options)
  const deadline = Date.now() + READINESS_TIMEOUT_MS
  let lastError: unknown
  for (;;) {
    try {
      const result = await target.exec('true', { timeoutMs: 5_000 })
      if (result.exitCode === 0) return
      lastError = new Error(`probe exited ${result.exitCode}: ${result.output}`)
    } catch (error: unknown) {
      lastError = error
    }
    if (Date.now() > deadline) throw new Error(`ssh host never became ready: ${String(lastError)}`)
    await new Promise(resolve => setTimeout(resolve, 250))
  }
}

/**
 * Start a containerized sshd. `variant` selects the coreutils the host has, and
 * therefore whether the engine's acquire probe can pass at all.
 */
export async function startContainerSshHost(variant: 'gnu' | 'busybox'): Promise<SshHost> {
  const keyDir = await mkdtemp(posix.join(tmpdir(), 'tuddofs-sshkey-'))
  const identityFile = posix.join(keyDir, 'id_ed25519')
  await runLocal('ssh-keygen', ['-t', 'ed25519', '-N', '', '-C', 'tuddofs-acceptance', '-f', identityFile, '-q'])
  const publicKey = await readFile(`${identityFile}.pub`, 'utf8')

  const image = await GenericContainer.fromDockerfile(DOCKERFILE_CONTEXT)
    .withBuildArgs({ EXTRA_PACKAGES: variant === 'gnu' ? 'coreutils findutils' : '' })
    .build(`tuddofs-sshd-${variant}:test`, { deleteOnExit: false })
  const container: StartedTestContainer = await image
    .withExposedPorts(22)
    .withCopyContentToContainer([
      { content: publicKey, target: `/etc/ssh/authorized_keys/${CONTAINER_USER}`, mode: 0o644 },
    ])
    .withWaitStrategy(Wait.forListeningPorts())
    .start()

  const targetOptions = (root: string): SshTargetOptions => ({
    root,
    host: container.getHost(),
    port: container.getMappedPort(22),
    user: CONTAINER_USER,
    identityFile,
    knownHostsFile: posix.join(keyDir, 'known_hosts'),
    strictHostKeyChecking: 'accept-new',
    connectTimeoutMs: 5_000,
    execTimeoutMs: 60_000,
  })

  await waitForSsh(targetOptions('/workspace/readiness'))

  return {
    targetOptions,
    workspaceBase: '/workspace',
    killsRealDaemon: true,
    async kill() {
      // A real daemon kill, not a wrapper flag. sshd is deliberately not PID 1
      // in the fixture image, so the container — and its published port —
      // outlives it and `revive` can put it back.
      const result = await container.exec(['pkill', '-f', '/usr/sbin/sshd'])
      if (result.exitCode !== 0) throw new Error(`could not kill sshd: ${result.output}`)
    },
    async revive() {
      // Redirect the daemon's stdio: an inherited pipe keeps `docker exec` open
      // until sshd exits, which is the opposite of reviving it.
      const result = await container.exec(['sh', '-c', '/usr/sbin/sshd -e >/dev/null 2>&1'])
      if (result.exitCode !== 0) throw new Error(`could not restart sshd: ${result.output}`)
      await waitForSsh(targetOptions('/workspace/readiness'))
    },
    async dispose() {
      await container.stop().catch(() => undefined)
      await rm(keyDir, { recursive: true, force: true }).catch(() => undefined)
    },
  }
}

/**
 * Use a host the developer already has (§13.4 "any reachable host behind an
 * opt-in env flag"). Nothing here creates or destroys the host; only the
 * workspace directories it is told to use.
 */
export function externalSshHost(): SshHost {
  const host = process.env.TUDDOFS_SSH_HOST
  if (host === undefined) throw new Error('TUDDOFS_SSH_HOST is not set')
  const port = process.env.TUDDOFS_SSH_PORT
  const identityFile = process.env.TUDDOFS_SSH_IDENTITY
  const user = process.env.TUDDOFS_SSH_USER
  const knownHostsFile = process.env.TUDDOFS_SSH_KNOWN_HOSTS
  const workspaceBase = process.env.TUDDOFS_SSH_ROOT ?? '/tmp/tuddofs-acceptance'

  return {
    workspaceBase,
    killsRealDaemon: false,
    targetOptions: (root: string) => ({
      root,
      host,
      ...(user === undefined ? {} : { user }),
      ...(port === undefined ? {} : { port: Number(port) }),
      ...(identityFile === undefined ? {} : { identityFile }),
      ...(knownHostsFile === undefined ? {} : { knownHostsFile }),
      execTimeoutMs: 60_000,
    }),
    async kill() {
      throw new Error('an external host is not this suite\u2019s to kill')
    },
    async revive() {
      throw new Error('an external host is not this suite\u2019s to revive')
    },
    async dispose() {
      /* the host outlives the suite */
    },
  }
}

/**
 * The out-of-band hand on a remote workspace: what a shell tool or another
 * process would do to the files, expressed through the host's own shell rather
 * than through the engine's target. Content travels base64-encoded so a name or
 * a byte sequence can be as hostile as the test needs.
 */
export function remoteDisk(target: SshTarget): WorkspaceDisk {
  const demand = async (command: string, what: string): Promise<string> => {
    const result = await target.exec(command)
    if (result.exitCode !== 0) throw new Error(`${what} failed (exit ${result.exitCode}): ${result.output}`)
    return result.output
  }
  return {
    async readText(path) {
      return Buffer.from(await demand(`base64 -- ${quoteShellArg(path)}`, `read ${path}`), 'base64').toString('utf8')
    },
    async writeText(path, content) {
      const encoded = Buffer.from(content, 'utf8').toString('base64')
      await demand(`printf %s ${quoteShellArg(encoded)} | base64 -d > ${quoteShellArg(path)}`, `write ${path}`)
    },
    async stat(path) {
      // GNU stat does not dereference by default, so a planted symlink is
      // observable as itself, exactly as the local harness's lstat is.
      const result = await target.exec(`stat -c '%f %.3Y' -- ${quoteShellArg(path)}`)
      if (result.exitCode !== 0) return undefined
      const [mode, mtime] = result.output.trim().split(' ')
      return { mode: Number.parseInt(mode, 16), mtimeMs: Math.round(Number.parseFloat(mtime) * 1000) }
    },
    async symlink(existingPath, linkPath) {
      await demand(`ln -s -- ${quoteShellArg(existingPath)} ${quoteShellArg(linkPath)}`, `symlink ${linkPath}`)
    },
    async chmod(path, mode) {
      await demand(`chmod ${mode.toString(8)} -- ${quoteShellArg(path)}`, `chmod ${path}`)
    },
  }
}
