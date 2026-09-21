import type { SessionInfo } from "@shared/protocol"
import type { Config } from "../config"
import type { Storage } from "../storage"
import type { Snapshots } from "./snapshot"
import type { History, Snapshot, SnapshotFile } from "./store"

/**
 * Moves an existing profile's undo history out of its conversation documents
 * and into the projects' checkpoint stores.
 *
 * Until now every recorded turn carried whole file bodies inside
 * `session/<id>/history.json`, so one conversation's undo document could reach
 * hundreds of megabytes and every undo, redo and rollback read and wrote the
 * lot. The new shape keeps a reference instead. This is what carries the
 * history someone already has across that change, rather than dropping it.
 *
 * Three rules it keeps, in this order of importance:
 *
 *   1. Nothing is lost. A body that cannot be put into the store stays exactly
 *      where it is, in the old shape, which every reader still understands - so
 *      the worst outcome of a failed migration is a document that did not get
 *      smaller, never a turn that can no longer be taken back.
 *   2. A document that will not parse is left alone. It is read with `read`
 *      rather than repaired: the store quarantines damaged documents when the
 *      session itself opens one, and that is the place to do it.
 *   3. It can run again. Only entries still carrying a body are converted, so a
 *      profile half-migrated by a run that was killed finishes next time.
 */

/** Recorded in `migrations` once an existing profile's undo history has been moved. */
export const CHECKPOINT_MIGRATION = "undo-checkpoints-r7"

export interface CheckpointMigration {
  /** Conversations whose history was rewritten. */
  sessions: number
  /** Bodies moved into a checkpoint store. */
  moved: number
  /** Bodies that had to stay inline, and so still read the old way. */
  kept: number
}

/** Whether a recorded file still carries its body rather than a reference. */
function inlineBody(file: SnapshotFile): boolean {
  return file.blob === undefined && file.content !== undefined && file.content !== null
}

export async function migrateCheckpoints(
  storage: Storage,
  snapshots: Snapshots,
  config: Config,
): Promise<CheckpointMigration> {
  const done = new Set(config.get().migrations ?? [])
  const out: CheckpointMigration = { sessions: 0, moved: 0, kept: 0 }
  if (done.has(CHECKPOINT_MIGRATION)) return out

  for (const id of await storage.listDirectories("session")) {
    const historyKey = `session/${id}/history`
    /*
     * Read plainly: an unreadable history is this conversation's own business,
     * handled where it is opened. A migration must not be the thing that moves
     * someone's undo document aside.
     */
    const stored = await storage.read<Partial<History>>(historyKey).catch(() => undefined)
    if (!stored) continue
    const snapshots_ = [
      ...(stored.undo ?? []),
      ...(stored.redo ?? []),
      ...(stored.reverted ?? []).map((step) => step.snapshot),
    ]
    const swapped = (stored.reverted ?? []).map((step) => ({ files: step.swapped }) as Pick<Snapshot, "files">)
    const all: Pick<Snapshot, "files">[] = [...snapshots_, ...swapped]
    if (!all.some((snapshot) => (snapshot.files ?? []).some(inlineBody))) continue

    const session = await storage.read<SessionInfo>(`session/${id}/info`).catch(() => undefined)
    const directory = session?.directory
    // With no project there is no store to move anything into; it keeps working as it is.
    if (!directory) continue

    let moved = 0
    let kept = 0
    for (const snapshot of all) {
      for (const file of snapshot.files ?? []) {
        if (!inlineBody(file)) continue
        const bytes = Buffer.from(file.content ?? "", file.base64 ? "base64" : "utf8")
        try {
          file.blob = await snapshots.keep(directory, bytes)
          delete file.content
          delete file.base64
          moved += 1
        } catch {
          // Left exactly as it was: the old shape is still read, so this turn is still undoable.
          kept += 1
        }
      }
    }
    if (!moved) {
      out.kept += kept
      continue
    }
    // Every snapshot now names the store its references live in.
    for (const snapshot of snapshots_) snapshot.directory ??= directory
    await storage.write(historyKey, stored)
    out.sessions += 1
    out.moved += moved
    out.kept += kept
  }

  /*
   * Recorded only when nothing was left behind. A profile where some body could
   * not be moved is worth trying again next time rather than being written off,
   * and the pass is cheap when there is nothing left to do.
   */
  if (out.kept === 0) {
    await config.set({ migrations: [...done, CHECKPOINT_MIGRATION] }).catch(() => undefined)
  }
  return out
}
