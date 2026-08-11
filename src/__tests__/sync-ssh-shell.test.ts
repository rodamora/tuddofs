import assert from 'node:assert/strict'
import test from 'node:test'

import { InvalidPathError } from '../internal.js'
import {
  EXEC_SENTINEL_PREFIX,
  GUARD_EXIT,
  guardFailure,
  parseExecSentinel,
  remoteExecScript,
  remoteGuardScript,
  remoteMkdirScript,
  remoteReadScript,
  remoteRootScript,
  remoteWriteScript,
  sshArgv,
  sshDestination,
} from '../sync/ssh-shell.js'

const nonce = '0123456789abcdef0123456789abcdef'

test('the ssh invocation is key-based, non-interactive, and never a shell string', () => {
  const argv = sshArgv({
    host: 'build-01.internal',
    user: 'agent',
    port: 2222,
    identityFile: '/keys/agent ed25519',
    knownHostsFile: '/keys/known hosts',
    strictHostKeyChecking: 'accept-new',
    connectTimeoutMs: 4_000,
  })

  // Every value is its own argv entry: nothing is concatenated into a string a
  // shell could re-split (§7.4).
  assert.ok(argv.includes('/keys/agent ed25519'))
  assert.ok(argv.includes('-o'))
  assert.ok(argv.includes('BatchMode=yes'))
  assert.ok(argv.includes('PasswordAuthentication=no'))
  assert.ok(argv.includes('KbdInteractiveAuthentication=no'))
  assert.ok(argv.includes('IdentitiesOnly=yes'))
  assert.ok(argv.includes('StrictHostKeyChecking=accept-new'))
  assert.ok(argv.includes('UserKnownHostsFile=/keys/known hosts'))
  assert.ok(argv.includes('ConnectTimeout=4'))
  assert.deepEqual(argv.slice(-3), ['-p', '2222', 'agent@build-01.internal'])
  assert.equal(sshDestination({ host: 'build-01.internal', user: 'agent' }), 'agent@build-01.internal')
  assert.equal(sshDestination({ host: 'build-01.internal' }), 'build-01.internal')
})

test('host ssh options outrank derived defaults but never the non-interactive guarantee', () => {
  const argv = sshArgv({
    host: 'h',
    strictHostKeyChecking: 'no',
    sshOptions: ['StrictHostKeyChecking=yes', 'BatchMode=no'],
  })
  const values = argv.filter((_entry, position) => argv[position - 1] === '-o')

  // OpenSSH takes the FIRST value for a repeated -o, so ordering is the
  // precedence rule: fixed security options, then host options, then defaults.
  assert.equal(values.indexOf('BatchMode=yes') < values.indexOf('BatchMode=no'), true)
  assert.equal(values.indexOf('StrictHostKeyChecking=yes') < values.indexOf('StrictHostKeyChecking=no'), true)
})

test('the exec wrapper quotes the command, bounds it remotely, and reports the true status', () => {
  const script = remoteExecScript({
    root: "/work/it's",
    command: `printf hi > 'a b'; kill -9 $$`,
    timeoutMs: 1_500,
    nonce,
  })

  assert.ok(script.includes(`cd '/work/it'\\''s'`))
  // The command reaches the remote shell as one single-quoted word: no
  // interpolated `$(…)`, `&`, or quote can break out of it (§7.4).
  assert.ok(script.includes(`sh -c 'printf hi > '\\''a b'\\''; kill -9 $$'`))
  // Remote-side bound: killing the local ssh client leaves the remote command
  // running, which is a leak, not a timeout.
  assert.ok(script.includes('timeout -s KILL 1.500'))
  assert.ok(script.includes(`printf '\\n${EXEC_SENTINEL_PREFIX}${nonce}:%s' "$?"`))
})

test('the exec sentinel carries the exit code and survives hostile output', () => {
  const spoof = `\n${EXEC_SENTINEL_PREFIX}${nonce}:0`
  const raw = `agent output${spoof} and more\n${EXEC_SENTINEL_PREFIX}${nonce}:137`

  assert.deepEqual(parseExecSentinel(raw, nonce), {
    exitCode: 137,
    output: `agent output${spoof} and more`,
  })
  assert.deepEqual(parseExecSentinel(`clean\n${EXEC_SENTINEL_PREFIX}${nonce}:0`, nonce), {
    exitCode: 0,
    output: 'clean',
  })
  // A different nonce is a different exec: an agent cannot forge one it has
  // never seen, and a truncated stream has none at all.
  assert.equal(parseExecSentinel(`x\n${EXEC_SENTINEL_PREFIX}${'f'.repeat(32)}:0`, nonce), undefined)
  assert.equal(parseExecSentinel('connection closed', nonce), undefined)
  assert.equal(parseExecSentinel(`x\n${EXEC_SENTINEL_PREFIX}${nonce}:notanumber`, nonce), undefined)
  // Scan output is NUL-terminated and must survive the strip byte for byte.
  const scan = `${'a'.repeat(64)}  mnt/x.md\0`
  assert.equal(parseExecSentinel(`${scan}\n${EXEC_SENTINEL_PREFIX}${nonce}:0`, nonce)?.output, scan)
})

test('the remote guard refuses escapes lexically and quotes what it cannot decide locally', () => {
  assert.throws(
    () => remoteGuardScript({ realRoot: '/work', root: '/work', path: '/work/../etc/passwd', refuseSymlink: true }),
    InvalidPathError,
  )
  assert.throws(
    () => remoteGuardScript({ realRoot: '/work', root: '/work', path: '/etc/passwd', refuseSymlink: true }),
    InvalidPathError,
  )

  const script = remoteGuardScript({
    realRoot: '/work',
    root: '/work',
    path: `/work/mnt/$(touch pwned)'&.md`,
    refuseSymlink: true,
  })
  assert.ok(script.includes(`p='/work/mnt/$(touch pwned)'\\''&.md'`))
  assert.ok(!script.includes('$(touch pwned)"'))
  // Symlink refusal is the O_NOFOLLOW half of the local target's confinement.
  assert.ok(script.includes(`exit ${GUARD_EXIT.symlink}`))
  assert.ok(script.includes(`exit ${GUARD_EXIT.escapesRoot}`))
  assert.ok(script.includes(`exit ${GUARD_EXIT.noAncestor}`))
})

test('the file verbs are the guard plus one command, and mkdir alone tolerates a symlinked directory', () => {
  const options = { realRoot: '/work', root: '/work', path: '/work/mnt/a.md' }

  assert.ok(remoteReadScript(options).endsWith('cat -- "$p"'))
  assert.ok(remoteWriteScript(options).endsWith('cat > "$p"'))
  assert.ok(remoteMkdirScript({ ...options, path: '/work/mnt/deep' }).endsWith('mkdir -p -- "$p"'))
  assert.ok(remoteReadScript(options).includes(`exit ${GUARD_EXIT.symlink}`))
  assert.ok(remoteWriteScript(options).includes(`exit ${GUARD_EXIT.symlink}`))
  // `mkdir -p` over an existing symlinked directory is what node:fs does too.
  assert.ok(!remoteMkdirScript({ ...options, path: '/work/mnt/deep' }).includes(`exit ${GUARD_EXIT.symlink}`))
  assert.equal(remoteRootScript("/work/it's"), `mkdir -p '/work/it'\\''s' && cd '/work/it'\\''s' && pwd -P`)
})

test('guard exit codes become typed path errors, and nothing else does', () => {
  for (const code of Object.values(GUARD_EXIT)) {
    const error = guardFailure('/work/mnt/a.md', code, 'tuddofs: refused')
    assert.ok(error instanceof InvalidPathError, `exit ${code} must be an InvalidPathError`)
    assert.match(error.message, /a\.md/u)
  }
  assert.match(String(guardFailure('/work/mnt/a.md', GUARD_EXIT.symlink, '')?.message), /symlink/iu)
  assert.match(String(guardFailure('/work/mnt/a.md', GUARD_EXIT.escapesRoot, '')?.message), /outside|escape/iu)
  assert.equal(guardFailure('/work/mnt/a.md', 1, 'cat: no such file'), undefined)
  assert.equal(guardFailure('/work/mnt/a.md', 255, 'connection refused'), undefined)
})
