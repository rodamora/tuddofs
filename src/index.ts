export { commitPreimage, hashCommit, hashTree, sha256, treePreimage } from './hashing.js'
export type { CommitHashInput, TreeEntry } from './hashing.js'
export {
  InvalidCommitTimestampError,
  InvalidMountKeyError,
  InvalidPathError,
  validateMountKey,
  validatePath,
} from './validation.js'
export { migrate, agentFsDdl } from './migration.js'
export type { AgentFsPool } from './migration.js'
export { createAgentFs } from './kernel.js'
export { createDirectAdapter } from './direct.js'
export type { DirectAdapter } from './direct.js'
export { GrantController } from './grants.js'
export type { Grant, GrantControllerOptions } from './grants.js'
export type {
  Actor,
  AgentFsKernel,
  AgentFsLogger,
  AgentFsOptions,
  BlobObject,
  BlobStore,
  CommitEvent,
  DeleteInput,
  DeleteResult,
  ForkInput,
  ForkResult,
  GcOptions,
  GcReport,
  GrantResolutionOptions,
  GrantResolver,
  ReadInput,
  ReadResult,
  VerifyFinding,
  VerifyOptions,
  VerifyReport,
  WriteInput,
  WriteMode,
  WriteResult,
} from './kernel.js'
export type {
  DiffRecord,
  EditOptions,
  HistoryRecord,
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
  MergeResult,
} from './session.js'
export {
  AgentFsError,
  BranchSettledError,
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
export type { ErrorContext, KernelError } from './errors.js'
