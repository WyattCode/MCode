import type { ModelRef, Usage } from "@shared/protocol"
import type { Storage } from "../storage"

/** A request made for a conversation outside its turns: its title, Smart's routing, a compaction summary, a command review, a goal verdict. */
export interface BackgroundUse {
  at: number
  sessionID: string
  model: ModelRef
  usage: Usage
  kind: "title" | "smart" | "compaction" | "review" | "goal" | "fanout"
}

const KEY = "usage-background"
/** Enough for months of ordinary use; the oldest go first. */
const KEEP = 20_000

/**
 * The spend of background requests, which belong to no message and so were
 * never counted. Kept in a document of its own and read by the usage page.
 */
export class BackgroundUsage {
  private entries?: Promise<BackgroundUse[]>
  /** Set when the document could not be read: nothing is written over it for the rest of this run. */
  private blocked = false

  constructor(private readonly storage: Storage) {}

  list(): Promise<BackgroundUse[]> {
    this.entries ??= this.storage
      .read<{ entries?: BackgroundUse[] }>(KEY)
      .then((document) => (Array.isArray(document?.entries) ? document.entries : []))
      .catch(() => {
        this.blocked = true
        return []
      })
    return this.entries
  }

  async add(entry: BackgroundUse): Promise<void> {
    const entries = await this.list()
    entries.push(entry)
    if (entries.length > KEEP) entries.splice(0, entries.length - KEEP)
    if (!this.blocked) await this.storage.write(KEY, { entries }).catch(() => undefined)
  }
}
