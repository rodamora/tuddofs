import { createTuddoFs as createKernel, type TuddoFs, type TuddoFsOptions } from './kernel.js'

/** Construct the Tier-1 host API defined by architecture §6.2. */
export function createTuddoFs(options: TuddoFsOptions): TuddoFs {
  const kernel = createKernel(options)
  return {
    migrate: kernel.migrate,
    open: kernel.open,
    gc: kernel.gc,
    verify: kernel.verify,
    invalidate: kernel.invalidate,
  }
}
export { createDirectAdapter } from './direct.js'
export type { DirectAdapter } from './direct.js'
export {
  BranchSettledError,
  EditMatchError,
  GrantResolverError,
  InvariantError,
  MergePendingApprovalError,
  NotFoundError,
  PermissionDeniedError,
  PreconditionFailedError,
  RefConflictError,
  SchemaDriftError,
  StorageError,
} from './errors.js'
export { InvalidCommitTimestampError, InvalidMountKeyError, InvalidPathError } from './validation.js'
export type { ErrorContext, KernelError } from './errors.js'
export type {
  Actor,
  BlobObject,
  BlobStore,
  CommitEvent,
  GcOptions,
  GcReport,
  GrantResolver,
  TuddoFs,
  TuddoFsLogger,
  TuddoFsOptions,
  VerifyFinding,
  VerifyOptions,
  VerifyReport,
} from './kernel.js'
export type {
  DiffRecord,
  EditOptions,
  HistoryRecord,
  MergeResult,
  MountFileSystem,
  MountSpec,
  OpenInput,
  SessionEntry,
  SessionFileSystem,
  SessionStat,
  TextEdit,
  TimelineFilter,
  TimelineRecord,
  VirtualEntry,
  VirtualMountHandler,
  WriteOptions,
} from './session.js'
export type { TuddoFsClient, TuddoFsMigrationOptions, TuddoFsPool } from './migration.js'
