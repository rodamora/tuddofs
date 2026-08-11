# s2-ssh-target — remote SyncTarget over SSH

Status: done — SSH target + full §7.5 kill matrix over a real network host, zero engine changes
Stage: S2
Depends on: s1-sync-core
Spec: `../architecture.md` §7.1 (targets list), §7.4 (hostile-input rules), §11 S2 proof column

## Goal

Prove the SyncTarget seam is portable with the cheapest honest remote: real network, real quoting hazards, no vendor SDK.

## Scope

- SSH implementation of the four-verb `SyncTarget` (exec / readFile / writeFile / mkdir). Key-based auth, host/port/user injected; no interactive prompts.
- Hostile-input suite at full strength over the network path: single-quoting of every interpolated value, root-guard on destructive execs, mount-escape rejection with adversarial scan output.
- Precondition probe behavior (§7.3 Phase 1) verified against a busybox-ish host: fails loudly at acquire.

Non-goals: provider targets (E2B/Blaxel — doc recipes or separate packages, never core); connection pooling/perf work beyond the §12 budgets.

## Acceptance

- The full §7.5 kill matrix passes against an SSH target (CI: containerized sshd; local dev: any reachable host behind an opt-in env flag, per §13.4).
- Quoting/escape tests: filenames and mount content containing `'`, `&`, newlines, `$(…)` round-trip without execution.
- Engine code required ZERO changes to support the second target — any needed change is a seam bug to fix in s1-sync-core's code, and noted in the PR.

## Status

Shipped on `s2/ssh-target`.

**Target.** `src/sync/ssh.ts` (process + verbs) over `src/sync/ssh-shell.ts` (pure argv and remote-script construction, unit-tested without a host). No dependency added: the package spawns an `ssh` client through `node:child_process`, documented as a host requirement. Exported from `tuddofs/internal` beside the local target.

Decisions worth carrying forward, each measured against a real sshd rather than assumed:

- **The remote reports its own exit status, behind a per-exec nonce.** OpenSSH returns 255 both when the remote command dies from a signal and when the transport fails. Measured: `ssh host 'kill -9 $$'` exits 255. Inferring the command's status from ssh's would turn a killed exec into an unexplained target error, and a dead host into "your command failed" — which §7.2 forbids for scans. No sentinel in the stream is now a `SyncTargetError`, never an exit code.
- **`exec` is bounded on the remote, with `timeout -s KILL`.** Measured: killing the local ssh client leaves the remote command running. The local watchdog stays as a backstop for a wedged connection.
- **The root guard runs on both sides.** Lexically here (`resolveUnderRoot`), then on the host: resolve the deepest existing ancestor with `pwd -P` and refuse anything outside the root, plus refuse a symlinked final component. That is the remote half of the local target's `O_NOFOLLOW` + realpath confinement, and it is what catches a symlinked directory pointing out of the workspace.
- **No connection pooling** (S2 non-goal). Hosts that want multiplexing pass `sshOptions: ['ControlMaster=auto', …]`; it is ssh configuration, not engine code.

**Acceptance.** The §7.5 matrix moved out of the local suite into `src/integration/sync-kill-matrix.ts` and now runs against both targets from one source — 28 cases each. The suite reaches the workspace only through a `WorkspaceDisk` seam (`node:fs` locally, a remote shell over SSH), so nothing in it knows which target it is driving.

Run: `npm run test:ssh` (opt-in, plus a CI job). It builds `fixtures/sshd`, generates a throwaway ed25519 keypair per run, and starts and disposes its own uniquely named containers — a GNU host for the matrix and a busybox host for the probe. `TUDDOFS_SSH_HOST` points the same suite at any reachable machine instead (§13.4).

Evidence: 34/34 green over SSH (28 matrix + 6 SSH-specific), 28/28 local. The kill case kills the real sshd — the fixture keeps sshd off PID 1 so the container and its published port outlive the kill and `revive` can put it back.

**Seam report: zero engine changes.** `src/sync/engine.ts`, `paths.ts`, `slot.ts`, and `target.ts` are untouched by this branch. The second target needed nothing but the four verbs.

New cases the network forced into the shared matrix, which now also guard the local target:

- filenames and file CONTENT carrying `'`, `"`, backtick, `&`, `$(…)`, and newlines round-trip through capture and mirroring without a shell ever evaluating them;
- an exec that exceeds its timeout is killed and reported as `137`, with no process left behind on the host.
