# s2-ssh-target — remote SyncTarget over SSH

Status: open
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
