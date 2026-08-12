/**
 * Sync engine and first-party targets (architecture §7).
 *
 * Surface placement: §6.2 enumerates the Tier-1 main entry exhaustively and this
 * engine is not on that list, so it ships through `tuddofs/internal` until §6.2
 * is amended. §15.4 is CLOSED: the engine lives in core rather than a separate
 * `sync` package — it imports no provider SDK, only the four-verb seam
 * — and the internal subpath is where it stays until a host case argues for
 * Tier 1, which would be an additive change.
 */
export { createSyncEngine } from './engine.js'
export type { SyncEngine, SyncEngineEvents, SyncEngineOptions } from './engine.js'
export { createLocalDirectoryTarget } from './local.js'
export type { LocalDirectoryTarget, LocalDirectoryTargetOptions } from './local.js'
export { createSshTarget } from './ssh.js'
export type { SshTarget, SshTargetOptions } from './ssh.js'
export {
  guardFailure,
  parseExecSentinel,
  remoteExecScript,
  remoteGuardScript,
  remoteMkdirScript,
  remoteReadFilesScript,
  remoteReadScript,
  remoteRootScript,
  remoteWriteFilesScript,
  remoteWriteScript,
  sshArgv,
  sshDestination,
  EXEC_SENTINEL_PREFIX,
  GUARD_EXIT,
} from './ssh-shell.js'
export type { RemotePathScriptInput, SshConnectionOptions } from './ssh-shell.js'
export { SyncTargetError } from './errors.js'
export type { ExecOptions, ExecResult, SyncTarget } from './target.js'
export {
  chmodReadOnlyCommand,
  chmodWritableCommand,
  hydrationManifestCommand,
  mirrorDirName,
  mountKeyForMirrorDir,
  parseScanRecords,
  parseSizeRecords,
  probeCommand,
  quoteShellArg,
  resolveUnderRoot,
  scanCommand,
  sizeCommand,
  stampCommand,
  uploadCommand,
  HYDRATION_MARKER_FILENAME,
  SCAN_LIST_FILENAME,
  STAMP_FILENAME,
  STATE_DIRNAME,
} from './paths.js'
export type { ScanCommandInput, ScanRecord, SizeRecord, UploadCommandInput } from './paths.js'
export { CaptureSlot } from './slot.js'
