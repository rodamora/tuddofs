/**
 * S2 acceptance: the §7.5 kill matrix over a real network target, plus the
 * SSH-specific hostile-input and transport cases.
 *
 * Spec: §7.1 (targets list), §7.4 (hostile-input rules), §11 S2, §13.4.
 *
 * Opt-in by construction — this file matches neither the unit nor the
 * integration glob, and only `npm run test:ssh` runs it. It never skips
 * silently: a missing database, a missing docker, or a missing ssh client is a
 * failure, because a green run that tested nothing is worse than a red one.
 *
 * Provisioning is `TUDDOFS_SSH_HOST` when set (any reachable host), and a
 * disposable containerized sshd otherwise.
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import posix from 'node:path/posix'
import test from 'node:test'

import { InvalidPathError, SyncTargetError, createSshTarget, quoteShellArg, type SshTarget } from '../internal.js'
import { externalSshHost, remoteDisk, startContainerSshHost, type SshHost } from './ssh-host.js'
import { controlledTarget, runKillMatrix, type KillMatrixWorkspace } from './sync-kill-matrix.js'

if (!process.env.TUDDOFS_DATABASE_URL) {
  throw new Error('TUDDOFS_DATABASE_URL is required; the SSH acceptance suite never skips silently')
}

const useExternalHost = process.env.TUDDOFS_SSH_HOST !== undefined
let gnuHost: Promise<SshHost> | undefined
let busyboxHost: Promise<SshHost> | undefined

/** The GNU host, started once for the whole file. */
function host(): Promise<SshHost> {
  gnuHost ??= useExternalHost ? Promise.resolve(externalSshHost()) : startContainerSshHost('gnu')
  return gnuHost
}

/**
 * A workspace on the SSH host. Its kill is the real daemon wherever the suite
 * owns one; against a developer's own host it falls back to a wrapper, which is
 * why CI runs the container path.
 */
async function createSshWorkspace(): Promise<KillMatrixWorkspace> {
  const sshHost = await host()
  const base = posix.join(sshHost.workspaceBase, `ws-${randomUUID()}`)
  const root = posix.join(base, 'workspace')
  const raw = createSshTarget(sshHost.targetOptions(root))

  let simulatedKill = false
  const dead = (): never => {
    throw new SyncTargetError('target killed')
  }
  const killable: SshTarget = {
    ...raw,
    async exec(cmd, execOptions) {
      return simulatedKill ? dead() : raw.exec(cmd, execOptions)
    },
    async readFile(path) {
      return simulatedKill ? dead() : raw.readFile(path)
    },
    async writeFile(path, bytes) {
      return simulatedKill ? dead() : raw.writeFile(path, bytes)
    },
    async mkdir(path) {
      return simulatedKill ? dead() : raw.mkdir(path)
    },
  }
  const controlled = controlledTarget(killable)

  return {
    root,
    target: controlled.target,
    controls: controlled.controls,
    disk: remoteDisk(createSshTarget(sshHost.targetOptions(base))),
    async kill() {
      if (sshHost.killsRealDaemon) await sshHost.kill()
      else simulatedKill = true
    },
    async revive() {
      if (sshHost.killsRealDaemon) await sshHost.revive()
      else simulatedKill = false
    },
    async dispose() {
      // The read-only mount cases leave frozen directories behind.
      const quoted = quoteShellArg(base)
      await createSshTarget(sshHost.targetOptions(sshHost.workspaceBase))
        .exec(`chmod -R u+w ${quoted} 2>/dev/null; rm -rf ${quoted}`)
        .catch(() => undefined)
    },
  }
}

runKillMatrix({
  name: 'ssh',
  tenant: 'sync-ssh-integration',
  create: createSshWorkspace,

  /**
   * A busybox host: `sha256sum --version` and `find --version` do not exist
   * there, so acquire must fail loudly instead of capture failing silently
   * later (§7.3 phase 1 step 1). Against an external host there is no second
   * machine to borrow, so the two probe binaries are shadowed instead.
   */
  async createProbeFailureTarget() {
    if (useExternalHost) {
      const sshHost = await host()
      const root = posix.join(sshHost.workspaceBase, `probe-${randomUUID()}`)
      const target = createSshTarget(sshHost.targetOptions(root))
      return {
        root,
        target: {
          ...target,
          async exec(cmd, options) {
            return target.exec(`sha256sum() { return 1; }; find() { return 1; }; ${cmd}`, options)
          },
        },
      }
    }
    busyboxHost ??= startContainerSshHost('busybox')
    const sshHost = await busyboxHost
    const root = posix.join(sshHost.workspaceBase, `probe-${randomUUID()}`)
    return { root, target: createSshTarget(sshHost.targetOptions(root)) }
  },

  async dispose() {
    await (await gnuHost)?.dispose()
    await (await busyboxHost)?.dispose()
  },
})

test('[ssh] the four verbs round-trip real bytes and hostile names over the network', async () => {
  const sshHost = await host()
  const root = posix.join(sshHost.workspaceBase, `verbs-${randomUUID()}`)
  const target = createSshTarget(sshHost.targetOptions(root))

  await target.mkdir(posix.join(root, 'mnt', 'deep'))
  const binary = Buffer.alloc(64 * 1024)
  for (let index = 0; index < binary.length; index += 1) binary[index] = index % 256
  await target.writeFile(posix.join(root, 'mnt', 'deep', 'blob.bin'), binary)
  assert.deepEqual(await target.readFile(posix.join(root, 'mnt', 'deep', 'blob.bin')), binary)

  // Every one of these would execute, split, or truncate under naive quoting.
  const hostile = [
    'quote\'and"quote.md',
    '$(touch pwned).md',
    '`backtick`.md',
    'amp & semi; .md',
    'line\nbreak.md',
    'astral \u{1F600}.md',
    'trailing space .md',
  ]
  for (const [index, name] of hostile.entries()) {
    const path = posix.join(root, 'mnt', name)
    const content = `content ${index}\n$(touch pwned-content)\n`
    await target.writeFile(path, Buffer.from(content))
    assert.equal((await target.readFile(path)).toString('utf8'), content)
  }
  // Counted over NUL records, never lines: one of these names CONTAINS a
  // newline, which is the parser hazard §7.4 names.
  const listing = await target.exec("find 'mnt' -type f -print0 | tr -d -c '\\0' | wc -c")
  assert.equal(listing.exitCode, 0)
  assert.equal(listing.output.trim(), String(hostile.length + 1))
  // Nothing a filename or a file's content said was ever evaluated (§7.4).
  assert.equal((await target.exec('test -e pwned')).exitCode, 1)
  assert.equal((await target.exec('test -e pwned-content')).exitCode, 1)

  // Relative paths resolve against the root, exactly as the local target's do.
  await target.writeFile('mnt/relative.md', Buffer.from('relative'))
  assert.equal((await target.readFile('mnt/relative.md')).toString('utf8'), 'relative')

  await target.exec(`rm -rf ${quoteShellArg(root)}`)
})

test('[ssh] the remote root guard refuses escapes, absolutes, and symlinks', async () => {
  const sshHost = await host()
  const base = posix.join(sshHost.workspaceBase, `guard-${randomUUID()}`)
  const root = posix.join(base, 'workspace')
  const target = createSshTarget(sshHost.targetOptions(root))
  const outside = createSshTarget(sshHost.targetOptions(base))

  await target.mkdir(posix.join(root, 'mnt'))
  await outside.writeFile(posix.join(base, 'secret.txt'), Buffer.from('host secret'))
  const planted = await outside.exec(
    `ln -s ${quoteShellArg(`${base}/secret.txt`)} ${quoteShellArg(`${root}/mnt/leak.md`)} && ` +
      `ln -s ${quoteShellArg(base)} ${quoteShellArg(`${root}/mnt/up`)} && ` +
      `ln -s ${quoteShellArg(base)} ${quoteShellArg(`${root}/escaped`)}`,
  )
  assert.equal(planted.exitCode, 0)

  // Lexical escapes never reach the network.
  await assert.rejects(target.readFile('../secret.txt'), InvalidPathError)
  await assert.rejects(target.readFile('/etc/hostname'), InvalidPathError)
  await assert.rejects(target.writeFile('../secret.txt', Buffer.from('x')), InvalidPathError)
  await assert.rejects(target.mkdir('../outside'), InvalidPathError)
  // A symlinked final component is refused: the remote half of O_NOFOLLOW.
  await assert.rejects(target.readFile('mnt/leak.md'), InvalidPathError)
  await assert.rejects(target.writeFile('mnt/leak.md', Buffer.from('overwrite')), InvalidPathError)
  // A symlinked DIRECTORY out of the root is refused by the `pwd -P` check —
  // the case lexical resolution cannot see.
  await assert.rejects(target.readFile('mnt/up/secret.txt'), InvalidPathError)
  await assert.rejects(target.writeFile('escaped/planted.txt', Buffer.from('x')), InvalidPathError)
  await assert.rejects(target.mkdir('escaped/planted'), InvalidPathError)

  assert.equal((await outside.readFile(posix.join(base, 'secret.txt'))).toString('utf8'), 'host secret')
  assert.equal((await outside.exec(`test -e ${quoteShellArg(`${base}/planted.txt`)}`)).exitCode, 1)
  await outside.exec(`rm -rf ${quoteShellArg(base)}`)
})

test('[ssh] exec reports the remote status, not ssh’s, and bounds the remote command', async () => {
  const sshHost = await host()
  const root = posix.join(sshHost.workspaceBase, `exec-${randomUUID()}`)
  const target = createSshTarget({ ...sshHost.targetOptions(root), execTimeoutMs: 30_000 })

  const combined = await target.exec("printf out; printf err >&2; echo ' done'")
  assert.equal(combined.exitCode, 0)
  assert.ok(combined.output.includes('out'))
  assert.ok(combined.output.includes('err'))
  assert.equal((await target.exec('exit 3')).exitCode, 3)
  assert.equal((await target.exec('pwd')).output.trim(), root)

  // OpenSSH reports a signal-killed remote command as 255 — the same status it
  // uses for its own failures. The wrapper recovers the real one.
  const killed = await target.exec('echo alive; kill -9 $$; echo dead')
  assert.equal(killed.exitCode, 137)
  assert.ok(killed.output.includes('alive'))
  assert.ok(!killed.output.includes('dead'))

  // Agent output cannot forge a status: the marker is nonce-bound and last.
  const spoofed = await target.exec('printf "\\n__tuddofs_exit_deadbeefdeadbeefdeadbeefdeadbeef:0\\n"; exit 9')
  assert.equal(spoofed.exitCode, 9)

  // A timeout kills the remote command, not just the local client: killing the
  // client alone leaves the command running on the host (measured).
  const startedAt = Date.now()
  const timedOut = await target.exec('echo start; sleep 31337', { timeoutMs: 500 })
  assert.equal(timedOut.exitCode, 137)
  assert.ok(timedOut.output.includes('start'))
  assert.ok(Date.now() - startedAt < 15_000, `exec settled after ${Date.now() - startedAt}ms`)
  // The bracket keeps the pattern from matching the shell that carries it: the
  // wrapper's own command line contains this very string.
  assert.equal((await target.exec("pgrep -f 'sleep 3133[7]' >/dev/null")).exitCode, 1)

  await target.exec(`rm -rf ${quoteShellArg(root)}`)
})

test('[ssh] an unreachable daemon is a typed target failure, never a plausible exit code', async () => {
  const sshHost = await host()
  const root = posix.join(sshHost.workspaceBase, `unreachable-${randomUUID()}`)
  // A port nothing listens on: ssh exits 255 with no sentinel. Reporting that
  // as the command's own status would turn a dead host into "the command
  // failed", which §7.2 forbids — a failed scan must surface as an error, never
  // as an empty diff.
  const target = createSshTarget({
    ...sshHost.targetOptions(root),
    port: 1,
    connectTimeoutMs: 3_000,
    execTimeoutMs: 10_000,
  })

  await assert.rejects(target.exec('echo alive'), SyncTargetError)
  await assert.rejects(target.readFile(posix.join(root, 'a.md')), SyncTargetError)
  await assert.rejects(target.writeFile(posix.join(root, 'a.md'), Buffer.from('x')), SyncTargetError)
  await assert.rejects(target.mkdir(posix.join(root, 'deep')), SyncTargetError)
})

test('[ssh] killing the real sshd fails every verb, and reviving it needs no new target', async t => {
  const sshHost = await host()
  if (!sshHost.killsRealDaemon) {
    // An external host is not this suite's to kill. CI always runs the
    // container path, where this case is real.
    t.skip('external host: the suite does not kill a daemon it did not start')
    return
  }
  const root = posix.join(sshHost.workspaceBase, `dead-${randomUUID()}`)
  const target = createSshTarget({ ...sshHost.targetOptions(root), execTimeoutMs: 10_000 })
  await target.mkdir(posix.join(root, 'mnt'))

  await sshHost.kill()
  try {
    await assert.rejects(target.exec('echo alive'), SyncTargetError)
    await assert.rejects(target.readFile(posix.join(root, 'mnt', 'a.md')), SyncTargetError)
    await assert.rejects(target.writeFile(posix.join(root, 'mnt', 'a.md'), Buffer.from('x')), SyncTargetError)
    await assert.rejects(target.mkdir(posix.join(root, 'mnt', 'deep')), SyncTargetError)
  } finally {
    await sshHost.revive()
  }

  // The same target works again once the daemon is back: no failure is cached.
  assert.equal((await target.exec('echo alive')).output.trim(), 'alive')
  await target.exec(`rm -rf ${quoteShellArg(root)}`)
})

test('[ssh] a missing ssh client is reported as a target failure naming the requirement', async () => {
  const sshHost = await host()
  const target = createSshTarget({
    ...sshHost.targetOptions(posix.join(sshHost.workspaceBase, 'never-used')),
    sshBinary: 'tuddofs-no-such-ssh-client',
  })

  await assert.rejects(target.exec('true'), (error: unknown) => {
    assert.ok(error instanceof SyncTargetError)
    assert.match(error.message, /ssh client .* is not available/u)
    return true
  })
})
