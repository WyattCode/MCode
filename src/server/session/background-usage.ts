import type { ModelRef, Usage } from "@shared/protocol"
import type { Storage } from "../storage"

/** A request made for a conversation outside its turns: its title, Smart's routing, a compaction summary, a command review. */
export interface BackgroundUse {
  at: number
  sessionID: string
  model: ModelRef
  usage: Usage
  kind: "title" | "smart" | "compaction" | "review"
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

  constructor(private readonly storage: Storage) {}

  list(): Promise<BackgroundUse[]> {
    this.entries ??= this.storage
      .read<{ entries?: BackgroundUse[] }>(KEY)
      .then((document) => (Array.isArray(document?.entries) ? document.entries : []))
      .catch(() => [])
    return this.entries
  }

  async add(entry: BackgroundUse): Promise<void> {
    const entries = await this.list()
    entries.push(entry)
    if (entries.length > KEEP) entries.splice(0, entries.length - KEEP)
    await this.storage.write(KEY, { entries }).catch(() => undefined)
  }
}
