/**
 * Sync engine and first-party targets (architecture §7).
 *
 * Surface placement: §6.2 enumerates the Tier-1 main entry exhaustively and this
 * engine is not on that list, so it ships through `tuddofs/internal` until §6.2
 * is amended. §15.4 (engine in core vs `@tuddofs/sync`) also remains open, and
 * internal keeps both options live.
 */
export { createSyncEngine } from './engine.js'
export type { SyncEngine, SyncEngineEvents, SyncEngineOptions } from './engine.js'
export { createLocalDirectoryTarget } from './local.js'
export type { LocalDirectoryTarget, LocalDirectoryTargetOptions } from './local.js'
export { SyncTargetError } from './errors.js'
export type { ExecOptions, ExecResult, SyncTarget } from './target.js'
export {
  chmodReadOnlyCommand,
  chmodWritableCommand,
  hydrationManifestCommand,
  mirrorDirName,
  mountKeyForMirrorDir,
  parseScanRecords,
  probeCommand,
  quoteShellArg,
  resolveUnderRoot,
  scanCommand,
  stampCommand,
  SCAN_LIST_FILENAME,
  STAMP_FILENAME,
  STATE_DIRNAME,
} from './paths.js'
export type { ScanCommandInput, ScanRecord } from './paths.js'
export { CaptureSlot } from './slot.js'
