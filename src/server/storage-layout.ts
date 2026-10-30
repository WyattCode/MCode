import type { Storage } from "./storage"

/**
 * Which build's idea of the document layout a profile holds.
 *
 * Everything under `storage/` - `session/<id>/info.json`, its messages, its
 * history - had no version marker anywhere. `config.json`'s `migrations` array
 * records which named changes have run, but that is per document and says
 * nothing about the layout itself, so a future change to the shape of
 * `session/<id>/…` had nothing to key a migration off, and there was no way at
 * all to tell an old profile from one written by a newer build.
 *
 * MiMo's engine keeps the same kind of flat store beside its database and
 * stamps it with exactly this - `~/.local/share/mimocode/storage/migration`,
 * currently holding `2`. This is that marker, in the shape `config.json`
 * already uses for the same job (F29): a number, read before anything is
 * written, and a newer one means read as far as you can and change nothing.
 */

/** Raise this only when the layout changes in a way a build that predates it would misread. */
export const STORAGE_LAYOUT_VERSION = 1

const LAYOUT_KEY = "layout"

export interface StorageLayout {
  schemaVersion: number
  /** True when the profile was written by a build newer than this one. */
  fromNewerVersion: boolean
}

/**
 * Reads the marker and, on an older or absent one, writes this build's.
 *
 * Absent means a profile from before the marker existed, which is this layout -
 * nothing has changed shape yet - so it is stamped rather than migrated. A
 * newer one is left exactly as it is: stamping it down would erase the only
 * evidence that something newer had been here.
 */
export async function readStorageLayout(storage: Storage): Promise<StorageLayout> {
  const read = await storage.readOrCorrupt<Partial<StorageLayout>>(LAYOUT_KEY)
  /*
   * A marker that will not parse is quarantined rather than written over. It is
   * one number, so little is lost either way - but the rule that nothing writes
   * over a document it could not read has no useful exceptions.
   */
  let stored: Partial<StorageLayout> | undefined
  if (read.unreadable) {
    console.warn(
      "[storage-layout] layout marker is unreadable; leaving it in place and not writing over it",
    )
    return { schemaVersion: STORAGE_LAYOUT_VERSION, fromNewerVersion: false }
  } else if (read.corrupt) {
    const aside = await storage.quarantine(LAYOUT_KEY)
    if (aside === undefined) {
      console.warn(
        "[storage-layout] layout marker is corrupt and could not be quarantined; leaving it in place and not writing over it",
      )
      return { schemaVersion: STORAGE_LAYOUT_VERSION, fromNewerVersion: false }
    }
    console.warn(`[storage-layout] layout marker was corrupt; quarantined to ${aside}`)
    stored = undefined
  } else {
    stored = read.value
  }
  const version = typeof stored?.schemaVersion === "number" ? stored.schemaVersion : 0
  if (version > STORAGE_LAYOUT_VERSION) return { schemaVersion: version, fromNewerVersion: true }
  if (version !== STORAGE_LAYOUT_VERSION) {
    await storage.write(LAYOUT_KEY, { schemaVersion: STORAGE_LAYOUT_VERSION }).catch(() => undefined)
  }
  return { schemaVersion: STORAGE_LAYOUT_VERSION, fromNewerVersion: false }
}
