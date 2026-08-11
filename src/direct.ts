import type { DeleteResult, WriteResult } from './kernel.js'
import type { SessionEntry, SessionFileSystem, SessionStat, TextEdit } from './session.js'

export interface DirectAdapter {
  read_file(input: { path: string }): Promise<string>
  read_bytes(input: { path: string }): Promise<Buffer>
  write_file(input: {
    path: string
    content: Buffer | Uint8Array | string
    ifSha?: string | null
  }): Promise<WriteResult>
  edit_file(input: { path: string; edits: readonly TextEdit[]; ifSha?: string | null }): Promise<WriteResult>
  list_files(input: { dir: string }): Promise<readonly SessionEntry[]>
  glob_files(input: { pattern: string }): Promise<readonly SessionEntry[]>
  stat_file(input: { path: string }): Promise<SessionStat>
  delete_file(input: { path: string; ifSha?: string | null }): Promise<DeleteResult>
}

/** Direct in-process adapter: agent tools call the session without a mirror. */
export function createDirectAdapter(
  session: Pick<SessionFileSystem, 'read' | 'readBytes' | 'write' | 'edit' | 'list' | 'glob' | 'stat' | 'delete'>,
): DirectAdapter {
  return {
    read_file: ({ path }) => session.read(path),
    read_bytes: ({ path }) => session.readBytes(path),
    write_file: ({ path, content, ifSha }) => session.write(path, content, { ifSha }),
    edit_file: ({ path, edits, ifSha }) => session.edit(path, edits, { ifSha }),
    list_files: ({ dir }) => session.list(dir),
    glob_files: ({ pattern }) => session.glob(pattern),
    stat_file: ({ path }) => session.stat(path),
    delete_file: ({ path, ifSha }) => session.delete(path, { ifSha }),
  }
}
