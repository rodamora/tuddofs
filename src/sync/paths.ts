/**
 * Pure mirror-path, shell-quoting, and scan-parsing rules for the sync engine.
 *
 * Spec: architecture §7.3 (four phases), §7.4 (gotchas), §6.1 (virtual mounts
 * are rejected in mirror-path mapping), §4.3 (kernel path contract), §15.1
 * (mirror-root naming; the `:` encoding is pinned by these tests).
 *
 * Invariants enforced here:
 * - Everything interpolated into an exec line is single-quoted (§7.4).
 * - A path that does not resolve strictly under `<root>` is refused before any
 *   destructive exec is emitted (§7.4 root guard).
 * - Target-reported scan records are untrusted input: a record that escapes its
 *   mount directory, or that sha256sum did not produce, is rejected rather than
 *   dropped, so a broken scan surfaces as an error instead of an empty diff
 *   (§7.2, §7.3 step 2).
 *
 * Paths are POSIX. The local-directory target (§7.1) is a POSIX-host target;
 * the `:` encoding exists so a future Windows target can host the same mirror
 * layout, not so this module can parse Windows paths.
 */
import posix from 'node:path/posix'
import { InvalidMountKeyError, InvalidPathError, validateMountKey, validatePath } from '../validation.js'

/** Mtime watermark for the incremental Phase-3 scan (§7.3). */
export const STAMP_FILENAME = '.tuddofs-stamp'
/** Engine-owned state directory; it sits beside the mount mirrors, never inside one. */
export const STATE_DIRNAME = '.tuddofs'
/** Scratch list produced by `find` and consumed by `xargs` in the same exec. */
export const SCAN_LIST_FILENAME = `${STATE_DIRNAME}/scan`
/** Per-mount hydration marker, written LAST so a crash mid-acquire re-hydrates only what never finished. */
export const HYDRATION_MARKER_FILENAME = `${STATE_DIRNAME}/hydrated`

/** A single `sha256sum --zero` record resolved back to its mount and kernel path. */
export interface ScanRecord {
  readonly mountKey: string
  readonly path: string
  readonly sha256: string
}

/** Inputs for the one-exec capture scan (§7.3 phase 3 step 1, phase 4 full scan). */
export interface ScanCommandInput {
  readonly root: string
  readonly mirrorDirs: readonly string[]
  readonly newerThanStamp: boolean
}

/** A single `stat --printf` record resolved back to its mount and kernel path. */
export interface SizeRecord {
  readonly mountKey: string
  readonly path: string
  readonly sizeBytes: number
}

/** Inputs for the §8.2 target-direct upload exec. */
export interface UploadCommandInput {
  /** Mirror path of the file, absolute or relative to the root; re-checked either way. */
  readonly path: string
  /** Presigned PUT URL, quoted by {@link uploadCommand} because it contains `&`. */
  readonly url: string
  /** Headers the presign signed; sent verbatim or the signature does not match. */
  readonly headers: Readonly<Record<string, string>>
}

const COLON_ENCODING = '%3A'
const HEX_SHA256 = /^[0-9a-f]{64}$/u
const DECIMAL_SIZE = /^(?:0|[1-9][0-9]*)$/u
const REQUIRED_BINARY_NAME = /^[A-Za-z0-9._+-]+$/u

/**
 * How far behind the scan start the stamp is set. Filesystem timestamps come
 * from a coarse clock, so an exact stamp can be newer than a write that follows
 * it; §7.4 demands that under-capture be impossible and accepts over-capture as
 * a sha no-op. One second covers every filesystem granularity in practice.
 */
export const STAMP_GRANULARITY_MARGIN_MS = 1_000

/**
 * Mirror directory for a mount key. `:` is legal in a mount key (§4.4) and
 * illegal in a Windows filename, so it is encoded deterministically; `%` cannot
 * appear in a mount key, which keeps the encoding reversible (§7.4, §15.1).
 */
export function mirrorDirName(mountKey: string): string {
  return validateMountKey(mountKey).replaceAll(':', COLON_ENCODING)
}

/**
 * Reverse of {@link mirrorDirName}. Any `%` that is not exactly `%3A` means the
 * directory was not created by this engine, so the name is refused rather than
 * repaired.
 */
export function mountKeyForMirrorDir(dirName: string): string {
  const decoded = dirName.replaceAll(COLON_ENCODING, ':')
  if (decoded.includes('%')) throw new InvalidMountKeyError(dirName)
  return validateMountKey(decoded)
}

/**
 * Single-quote a value for a POSIX shell. Presigned URLs contain `&`, agent
 * filenames contain quotes and newlines, and both reach exec lines (§7.4).
 */
export function quoteShellArg(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

/**
 * Resolve `candidate` (absolute, or relative to `root`) and refuse anything that
 * does not land strictly below `root`. This is the guard that survives whatever
 * quoting bug slips through (§7.4).
 */
export function resolveUnderRoot(root: string, candidate: string): string {
  const base = posix.resolve(root)
  const resolved = posix.resolve(base, candidate)
  if (resolved === base || !resolved.startsWith(`${base}/`)) {
    throw new InvalidPathError(candidate, `must resolve strictly under the workspace root ${base}`)
  }
  return resolved
}

/**
 * GNU coreutils probe run at acquire so capture cannot fail silently later
 * (§7.3 phase 1 step 1).
 *
 * `directUpload` adds the two binaries the §8.2 path cannot work without:
 * `stat` sizes the changed set and `curl` performs the presigned PUT. A target
 * missing either would capture happily until the first large file, then fail
 * mid-turn — which is exactly the silence this probe exists to prevent.
 *
 * Target implementations may add their own acquire-time requirements through
 * `requiredBinaries`; each is checked with `--version` beside the engine's
 * checks (§Design 6 of the sync batching spec).
 */
export function probeCommand(options: { directUpload?: boolean; requiredBinaries?: readonly string[] } = {}): string {
  const checks = ['sha256sum --version', 'find --version']
  if (options.directUpload) checks.push('stat --version', 'curl --version')
  for (const binary of new Set(options.requiredBinaries ?? [])) {
    if (typeof binary !== 'string' || !REQUIRED_BINARY_NAME.test(binary)) {
      throw new InvalidPathError(
        binary,
        'required binary name must match /^[A-Za-z0-9._+-]+$/',
      )
    }
    const check = `${binary} --version`
    if (!checks.includes(check)) checks.push(check)
  }
  return checks.join(' && ')
}

/**
 * Read-only mounts are frozen on disk after materialize (§7.3 phase 1 step 2).
 * The root guard runs before the destructive exec is even built (§7.4).
 */
export function chmodReadOnlyCommand(root: string, mirrorDir: string): string {
  return `chmod -R a-w ${quoteShellArg(resolveUnderRoot(root, mirrorDir))}`
}

/**
 * Unfreeze a read-only mirror before re-hydrating it; the same root guard runs
 * first, because this is destructive to whatever it points at (§7.4).
 *
 * `a-w,u+w` is the exact inverse of {@link chmodReadOnlyCommand} over the two
 * states the mirror is allowed to be in: frozen (no write bit anywhere) and
 * writable (owner only). A bare `u+w` would not undo `a-w`, and a bare `a+w`
 * would hand write access to group and other, which the engine never granted
 * — the mirror is engine-owned and the agent runs as its owner.
 */
export function chmodWritableCommand(root: string, mirrorDir: string): string {
  return `chmod -R a-w,u+w ${quoteShellArg(resolveUnderRoot(root, mirrorDir))}`
}

/**
 * Create the engine state directory and report the acquire state in one exec:
 * the stamp filename if the watermark exists, then one hydrated mount key per
 * line. Mount keys cannot contain a newline (§4.4), so the framing is safe.
 *
 * This is the warm/cold decision (§7.3 phase 1 step 3) and it costs one round
 * trip, not one per file.
 */
export function hydrationManifestCommand(root: string): string {
  const quotedRoot = quoteShellArg(root)
  return (
    `mkdir -p ${quoteShellArg(`${root}/${STATE_DIRNAME}`)} && cd ${quotedRoot} && ` +
    `{ [ -f ${quoteShellArg(STAMP_FILENAME)} ] && echo ${quoteShellArg(STAMP_FILENAME)}; ` +
    `[ -f ${quoteShellArg(HYDRATION_MARKER_FILENAME)} ] && cat ${quoteShellArg(HYDRATION_MARKER_FILENAME)}; ` +
    `true; }`
  )
}

/**
 * The capture scan (§7.3 phase 3 step 1). `find` writes its NUL-terminated list
 * to an engine-owned file and `xargs` reads it back in the same exec, so a
 * failing `find` fails the whole command: the spec's illustrative pipeline would
 * report `xargs`' status instead and turn a broken scan into an empty diff,
 * which §7.2 forbids.
 */
export function scanCommand(input: ScanCommandInput): string {
  const dirs = input.mirrorDirs.map(quoteShellArg).join(' ')
  const newer = input.newerThanStamp ? ` -newer ${quoteShellArg(STAMP_FILENAME)}` : ''
  const list = quoteShellArg(SCAN_LIST_FILENAME)
  return (
    `cd ${quoteShellArg(input.root)} && ` +
    `find ${dirs} -type f${newer} -print0 > ${list} && ` +
    `xargs -0 -r sha256sum --zero < ${list}`
  )
}

/**
 * Sizes for the files the scan just hashed, so capture can decide which ones
 * take the §8.2 direct-upload path.
 *
 * It reads back the SAME NUL-terminated list `find` wrote for the scan. That is
 * the whole design: no agent-controlled filename is interpolated into the
 * command, there is no `ARG_MAX` ceiling on the changed set, and the sizes
 * describe exactly the files whose shas the engine just diffed. A file removed
 * between the two execs fails `stat` and therefore the whole command, matching
 * how the scan itself already behaves — a failed scan is an error, never an
 * empty diff (§7.2).
 */
export function sizeCommand(root: string): string {
  return (
    `cd ${quoteShellArg(root)} && ` + `xargs -0 -r stat --printf='%s\\0%n\\0' < ${quoteShellArg(SCAN_LIST_FILENAME)}`
  )
}

/**
 * The §8.2 upload exec: one presigned PUT, streamed off disk by `curl`.
 *
 * `--upload-file` is load-bearing. It makes curl stream the file with a
 * `Content-Length` taken from `stat`, so a 2 GB blob never lands in a shell
 * buffer, in curl's memory, or in the server's (§8.3).
 *
 * Everything interpolated is single-quoted and the path is re-checked against
 * the root before the line exists at all. A presigned URL carries `&` and `;`,
 * either of which ends the command early unquoted; a path outside the root
 * would turn this into an exfiltration primitive with a network attached, which
 * is the symlink hazard of §7.4 pointed outward.
 */
export function uploadCommand(root: string, input: UploadCommandInput): string {
  const target = quoteShellArg(resolveUnderRoot(root, input.path))
  const headers = Object.entries(input.headers)
    .map(([name, value]) => `--header ${quoteShellArg(`${name}: ${value}`)} `)
    .join('')
  return (
    `curl --silent --show-error --fail --write-out '%{http_code}' ` +
    `${headers}--upload-file ${target} ${quoteShellArg(input.url)}`
  )
}

/**
 * Move the stamp back to the instant the scan started, so files written during
 * the scan re-appear next cycle and sha-diffing makes the re-capture a no-op
 * (§7.3 phase 3 step 6). The same command sets the acquire watermark at the end
 * of Phase 1.
 *
 * The stamp is set one {@link STAMP_GRANULARITY_MARGIN_MS} EARLIER than the
 * scan start. §7.4 requires under-capture to be impossible and accepts
 * over-capture as a sha no-op, and an exact stamp does not deliver that:
 * filesystem timestamps come from a coarse clock (Linux rounds down to the last
 * tick; older filesystems to the last second) while the engine's clock is
 * fine-grained, so a write that happens AFTER an exact stamp can still record
 * an mtime BEFORE it and vanish from `find -newer`. The margin covers every
 * such clock, including 1s-granularity filesystems.
 *
 * The margin also puts the acquire watermark before the files hydration just
 * wrote, so the first incremental scan re-hashes the workspace once. That waste
 * is deliberate. Stamping from the hydration marker's own mtime instead removes
 * it and breaks capture: `find -newer` is STRICTLY newer, the marker and the
 * agent's first writes land in the same coarse tick, and those writes then
 * never appear in a Phase-3 scan. It was measured — three kill-matrix cases
 * (post-acquire shell write, directory-over-file capture, revoked-grant
 * capture) go silent. Over-capture costs one hash pass and commits nothing;
 * under-capture loses the agent's work until turn end.
 */
export function stampCommand(root: string, scanStartEpochMs: number): string {
  const stampEpochMs = scanStartEpochMs - STAMP_GRANULARITY_MARGIN_MS
  const seconds = Math.floor(stampEpochMs / 1000)
  const millis = stampEpochMs - seconds * 1000
  const stamp = `@${seconds}.${String(millis).padStart(3, '0')}`
  return `touch -d ${quoteShellArg(stamp)} ${quoteShellArg(resolveUnderRoot(root, STAMP_FILENAME))}`
}

/**
 * Resolve one target-reported mirror-relative path back to its mount and kernel
 * path, refusing anything that escapes a materialized mount directory.
 *
 * Every record a target produces goes through here — scan shas and stat sizes
 * alike — because both come out of the same untrusted `find` list (§7.3 step 2).
 * `mirrorDirs` maps mirror directory name to mount key and contains ref-backed
 * mounts only, so a record under a virtual mount's directory is rejected exactly
 * like any other unknown directory (§6.1).
 */
function resolveMirrorRecord(
  relative: string,
  mirrorDirs: ReadonlyMap<string, string>,
): { mountKey: string; path: string } {
  const segments = relative.split('/')
  if (
    relative.startsWith('/') ||
    segments.length < 2 ||
    segments.some(segment => segment === '' || segment === '.' || segment === '..')
  ) {
    throw new InvalidPathError(relative, 'target path must be a file strictly under a mount mirror directory')
  }
  const mountKey = mirrorDirs.get(segments[0])
  if (mountKey === undefined) {
    throw new InvalidPathError(relative, 'target path escapes every materialized mount directory')
  }
  return { mountKey, path: validatePath(`/${segments.slice(1).join('/')}`, { mount: mountKey }) }
}

/** Parse `sha256sum --zero` output into mount-scoped kernel paths (§7.3 phase 3 step 2). */
export function parseScanRecords(output: string, mirrorDirs: ReadonlyMap<string, string>): readonly ScanRecord[] {
  if (output.length === 0) return []
  if (!output.endsWith('\0')) {
    throw new InvalidPathError(undefined, 'scan output is not NUL-terminated')
  }
  const records: ScanRecord[] = []
  for (const raw of output.slice(0, -1).split('\0')) {
    if (raw.length < 67 || !HEX_SHA256.test(raw.slice(0, 64)) || raw.slice(64, 66) !== '  ') {
      throw new InvalidPathError(raw, 'scan record is not a sha256sum --zero record')
    }
    const resolved = resolveMirrorRecord(raw.slice(66), mirrorDirs)
    records.push({ mountKey: resolved.mountKey, path: resolved.path, sha256: raw.slice(0, 64) })
  }
  return records
}

/**
 * Parse `stat --printf='%s\0%n\0'` output into mount-scoped kernel paths.
 *
 * Sizes are a transport prefilter and nothing more — commit identity comes from
 * the store, never from this number (§8.2) — but the records still go through
 * the same mount-escape checks as the scan, because they come from the same
 * untrusted target.
 */
export function parseSizeRecords(output: string, mirrorDirs: ReadonlyMap<string, string>): readonly SizeRecord[] {
  if (output.length === 0) return []
  if (!output.endsWith('\0')) {
    throw new InvalidPathError(undefined, 'size output is not NUL-terminated')
  }
  const fields = output.slice(0, -1).split('\0')
  if (fields.length % 2 !== 0) {
    throw new InvalidPathError(undefined, 'size output is not a sequence of size/path pairs')
  }
  const records: SizeRecord[] = []
  for (let index = 0; index < fields.length; index += 2) {
    const rawSize = fields[index]
    if (!DECIMAL_SIZE.test(rawSize)) {
      throw new InvalidPathError(rawSize, 'size record is not a stat --printf size')
    }
    const resolved = resolveMirrorRecord(fields[index + 1], mirrorDirs)
    records.push({ mountKey: resolved.mountKey, path: resolved.path, sizeBytes: Number(rawSize) })
  }
  return records
}
