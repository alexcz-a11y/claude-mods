// The mod's temporary directory (#62, spec #55): `$TMPDIR/dispatch-pilot/<session id>/`, one subdirectory for each session. The
// images the mod makes (a scaled or converted copy, a frame of a recording, a screenshot the takeover keeps from an MCP tool's
// result) are files in it, named by number; nothing in it is needed once the session is over, and the directory is not cleaned
// up (the system empties its temporary directory). Like the other modules that touch the world, it asks for closures only: a
// module cannot pass `$` across an import.

/** What the temporary directory needs of the engine. */
export type WorkFilesIo = {
  /** `$.process.run(argv)`: rejects outside the CLI. */
  run(argv: readonly string[]): Promise<unknown>
  /** `$.env.get('TMPDIR')` (the call spells the name out): rejects when the engine will not tell. */
  tmpdir(): Promise<string | undefined>
  /** `$.session.id()`. */
  sessionId(): Promise<string>
}

/** The session's directory, made, by session id (module level: a hot reload loses it, at the cost of one `mkdir -p` more). */
const made = new Map<string, Promise<string>>()
/** Told from the files an earlier load of the module made, which a hot reload leaves in the same directory. */
let stamp: string | undefined
let count = 0

/** A session id as a directory's name: letters, digits, `_` and `-`. */
const nameOf = (id: string): string => id.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80) || 'session'

/** The path of a new file with this extension in the session's directory, which exists by then. Rejects when it cannot be made. */
export async function newWorkFile(io: WorkFilesIo, extension: string): Promise<string> {
  stamp ??= Math.floor(Math.random() * 0xffffff).toString(36)
  const session = nameOf(await io.sessionId().catch(() => `unknown-${stamp}`))
  let dir = made.get(session)
  if (dir === undefined) {
    dir = (async () => {
      const base = ((await io.tmpdir().catch(() => undefined)) ?? '').trim() || '/tmp'
      const path = `${base.replace(/\/+$/, '')}/dispatch-pilot/${session}`
      await io.run(['mkdir', '-p', path])
      return path
    })().catch((error: unknown) => {
      // Not made (no CLI, a full disk): the next file tries again.
      made.delete(session)
      throw error
    })
    made.set(session, dir)
  }
  return `${await dir}/image-${stamp}-${++count}.${extension}`
}
