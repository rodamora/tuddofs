import type { DeleteResult, WriteResult } from './kernel.js'
import type { MountFileSystem, SessionEntry, SessionFileSystem, SessionStat, TextEdit } from './session.js'
import { InvalidPathError } from './validation.js'

/** Compound-address file tools retained at the adapter boundary by architecture §6.2. */
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

function mountForAddress(session: SessionFileSystem, address: string): { mount: MountFileSystem; path: string } {
  const separator = address.indexOf(':/')
  if (separator <= 0)
    throw new InvalidPathError(address, 'must be addressed as mount:/path', {
      tenant: session.actor.tenant,
    })
  return {
    mount: session.mount(address.slice(0, separator)),
    path: address.slice(separator + 1),
  }
}

/** Direct in-process adapter retaining compound mount addressing at the tool boundary (§6.2). */
export function createDirectAdapter(session: SessionFileSystem): DirectAdapter {
  return {
    read_file: ({ path }) => {
      const addressed = mountForAddress(session, path)
      return addressed.mount.read(addressed.path)
    },
    read_bytes: ({ path }) => {
      const addressed = mountForAddress(session, path)
      return addressed.mount.readBytes(addressed.path)
    },
    write_file: ({ path, content, ifSha }) => {
      const addressed = mountForAddress(session, path)
      return addressed.mount.write(addressed.path, content, { ifSha })
    },
    edit_file: ({ path, edits, ifSha }) => {
      const addressed = mountForAddress(session, path)
      return addressed.mount.edit(addressed.path, edits, { ifSha })
    },
    list_files: ({ dir }) => {
      const addressed = mountForAddress(session, dir)
      return addressed.mount.list(addressed.path)
    },
    glob_files: ({ pattern }) => {
      const addressed = mountForAddress(session, pattern)
      return addressed.mount.glob(addressed.path)
    },
    stat_file: ({ path }) => {
      const addressed = mountForAddress(session, path)
      return addressed.mount.stat(addressed.path)
    },
    delete_file: ({ path, ifSha }) => {
      const addressed = mountForAddress(session, path)
      return addressed.mount.delete(addressed.path, { ifSha })
    },
  }
}
