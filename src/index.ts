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
export type {
  Actor,
  AgentFsKernel,
  AgentFsLogger,
  AgentFsOptions,
  BlobStore,
  CommitEvent,
  ForkInput,
  ForkResult,
  GrantResolver,
  ReadInput,
  ReadResult,
  WriteInput,
  WriteMode,
  WriteResult,
} from './kernel.js'
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
