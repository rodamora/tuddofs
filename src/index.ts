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
  MergePendingApprovalError,
  NotFoundError,
  PermissionDeniedError,
  PreconditionFailedError,
  RefConflictError,
  StorageError,
} from './errors.js'
export type { ErrorContext, KernelError } from './errors.js'
