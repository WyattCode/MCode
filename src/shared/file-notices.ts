/*
 * MiMo's document change notices: when the user changes an open document - by
 * editing it in the side panel, by changing it outside the app, or by bringing
 * back an earlier version - the conversation's next message tells the model, so
 * it does not go on from what it last read. The transcript does not show them;
 * the model reads them as a block before the message. The wording is MCode's own.
 */

export type FileNoticeSource = "user" | "external" | "restore"

export interface FileNotice {
  path: string
  source: FileNoticeSource
  /** How many changes of this file the notice stands for. */
  count: number
  /** What the latest change was, when the document's history names it. */
  note?: string
  time: number
}

/** One more change of a file: merged into the file's notice, keeping the latest source and note. */
export function addFileNotice(
  list: readonly FileNotice[],
  change: { path: string; source: FileNoticeSource; note?: string; time: number },
): FileNotice[] {
  const at = list.findIndex((entry) => entry.path === change.path)
  const note = change.note?.trim() || undefined
  if (at === -1) return [...list, { path: change.path, source: change.source, count: 1, ...(note ? { note } : {}), time: change.time }]
  const before = list[at]
  const merged: FileNotice = { path: before.path, source: change.source, count: before.count + 1, ...(note ? { note } : {}), time: change.time }
  return list.map((entry, index) => (index === at ? merged : entry))
}

const HOW: Record<FileNoticeSource, string> = {
  user: "edited by the user in MCode",
  external: "changed outside MCode",
  restore: "restored by the user to an earlier version",
}

/** The block the model reads before the message, or nothing when no document changed. */
export function fileNoticesBlock(list: readonly FileNotice[] | undefined): string {
  if (!list?.length) return ""
  const lines = list.map((entry) => {
    const times = entry.count > 1 ? `${entry.count} changes` : "1 change"
    const latest = entry.note ? `; latest: ${entry.note}` : ""
    return `- ${entry.path} (${times}, last ${HOW[entry.source]}${latest})`
  })
  return [
    "<document-changes>",
    "Since your last look, these documents were changed by someone other than you. Read a file again before relying on what you saw of it earlier:",
    ...lines,
    "</document-changes>",
  ].join("\n")
}
