import fs from "node:fs/promises"
import type { ToolContext } from "./types"
import { ToolError } from "./types"
import { recordRead } from "./read-tracker"

/** The most lines a guard failure shows before telling the model to read the rest. */
const MAX_LINES = 400
/** The most characters a guard failure shows, so a huge file does not flood the reply. */
const MAX_CHARS = 24000

function numbered(text: string): string {
  const lines = text.split(/\r?\n/)
  const shown: string[] = []
  let used = 0

  for (let i = 0; i < lines.length && i < MAX_LINES; i++) {
    const line = `${i + 1}: ${lines[i]}`
    const add = line.length + (shown.length ? 1 : 0)
    if (used + add > MAX_CHARS) break
    shown.push(line)
    used += add
  }

  const noteFor = (remaining: number) =>
    `… (${remaining} line${remaining === 1 ? "" : "s"} not shown; read with offset ${shown.length + 1} for the rest)`

  let remaining = lines.length - shown.length
  if (remaining <= 0) return shown.join("\n")

  let note = noteFor(remaining)
  while (shown.length > 0 && used + 1 + note.length > MAX_CHARS) {
    const removed = shown.pop()!
    used -= removed.length + (shown.length ? 1 : 0)
    remaining = lines.length - shown.length
    note = noteFor(remaining)
  }

  if (!shown.length) return note
  return `${shown.join("\n")}\n${note}`
}

/**
 * Turns a read-before-edit guard failure into one step: show the file as it is
 * now and count that as a read, so the next edit can be based on it. Nothing is
 * written here.
 */
export async function guardFailure(
  context: ToolContext,
  target: string,
  display: string,
  kind: "unread" | "stale",
): Promise<ToolError> {
  const guard = kind === "unread"
    ? `${display} has not been read in this conversation.`
    : `${display} has changed since you last read it (modified on disk after your read - by a command, a formatter or another tool).`

  let text: string
  try {
    text = await fs.readFile(target, "utf8")
  } catch {
    return new ToolError(kind === "unread"
      ? `${guard} Read it first, then edit; nothing was written.`
      : `${guard} Read it again before editing; nothing was written.`)
  }

  const stat = await fs.stat(target).catch(() => undefined)
  recordRead(
    context.sessionID,
    target,
    stat ?? { mtimeMs: Date.now(), size: Buffer.byteLength(text, "utf8") },
    text,
  )

  return new ToolError(
    `${guard}\nNothing was written. Its current contents are below (now counted as read) - base your edit on them and send it again:\n${numbered(text)}`,
  )
}
