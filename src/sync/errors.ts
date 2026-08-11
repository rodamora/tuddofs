import { TuddoFsError } from '../errors.js'
import type { ErrorContext } from '../errors.js'

/**
 * A {@link SyncTarget} operation failed: a probe, a scan, a stamp update, or a
 * verification read.
 *
 * This sits beside the §9 taxonomy rather than inside it, because the sync
 * engine itself is not part of the Tier-1 surface yet (§6.2). It is still a
 * typed error carrying full context: a failed scan MUST surface as an error, not
 * as an empty diff (§7.2).
 */
export class SyncTargetError extends TuddoFsError {
  readonly exitCode: number | undefined
  readonly output: string | undefined

  constructor(reason: string, detail: { exitCode?: number; output?: string } = {}, context?: Partial<ErrorContext>) {
    super(detail.exitCode === undefined ? reason : `${reason} (exit ${detail.exitCode})`, context, 'SyncTargetError')
    this.exitCode = detail.exitCode
    this.output = detail.output
  }
}
