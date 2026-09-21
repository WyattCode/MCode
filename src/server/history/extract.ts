import path from "node:path"
import type { Message, SessionInfo, ToolPart } from "@shared/protocol"
import { withoutInlineMedia } from "./text"

/**
 * What of a conversation goes into the history index, and what `get` reads back.
 *
 * MiMo indexes what was said (user and assistant text, reasoning), attached
 * file names and types, and each finished tool call as its name, input and
 * output or error with the files it handed over. A call still running is left
 * out until it settles. Beside those: the conversation's compaction summary
 * with the files it names, and a failed reply's error - MCode's record of
 * what MiMo keeps as retry errors.
 *
 * A part is named `<session>/<message>/<part>` so that `get` can find it in the
 * JSON store without the index - which is what keeps `get` working while the
 * index is still being built.
 */

export type RowKind = "text" | "reasoning" | "file" | "tool" | "summary" | "error"

/** The key a compaction summary is filed under, beside the parts of the message it ends at. */
export const SUMMARY_KEY = "summary"
/** The key a failed reply's error is filed under. */
export const ERROR_KEY = "error"

export interface IndexRow {
  part_id: string
  session_id: string
  message_id: string
  kind: RowKind
  tool_name: string | null
  body: string
  time_created: number
}

export function partID(sessionID: string, messageID: string, key: string): string {
  return `${sessionID}/${messageID}/${key}`
}

export function parsePartID(id: string): { sessionID: string; messageID: string; key: string } | undefined {
  const [sessionID, messageID, ...rest] = id.split("/")
  const key = rest.join("/")
  // Only the store's own ids: a part id is also a path into it.
  if (!/^ses_[0-9a-z]+$/.test(sessionID ?? "") || !/^msg_[0-9a-z]+$/.test(messageID ?? "") || !key) return undefined
  return { sessionID: sessionID!, messageID: messageID!, key }
}

/** The key a project is filed under: its resolved folder, case-folded where the file system is. */
export function projectKey(directory: string): string {
  const resolved = path.resolve(directory)
  return process.platform === "win32" || process.platform === "darwin" ? resolved.toLowerCase() : resolved
}

/** What a tool handed the model besides text, as MiMo lists it: each file's name, type and where it is. */
function attachmentLines(part: ToolPart): string {
  return (part.attachments ?? []).map((file) => `${path.basename(file.path)} ${file.mime} ${file.path}`).join(" ")
}

function toolBody(part: ToolPart): string | undefined {
  const files = attachmentLines(part)
  if (part.status === "completed") return `${part.name} ${JSON.stringify(part.input ?? {})} ${JSON.stringify(part.output ?? "")}${files ? ` ${files}` : ""}`
  if (part.status === "error") return `${part.name} ${JSON.stringify(part.input ?? {})} ${part.error ?? ""}${files ? ` ${files}` : ""}`
  return undefined
}

/** A compaction's summary as the index and `get` read it: the summary, then the files it names. */
export function summaryText(compacted: NonNullable<SessionInfo["compacted"]>): string {
  return [compacted.summary, ...(compacted.files?.length ? ["", "Files:", ...compacted.files] : [])].join("\n")
}

/**
 * The row for a conversation's compaction summary, filed under the last
 * message it covers. The store keeps only the latest summary, so there is at
 * most one per conversation.
 */
export function summaryRow(session: Pick<SessionInfo, "id" | "compacted">): IndexRow | undefined {
  const compacted = session.compacted
  if (!compacted?.summary.trim()) return undefined
  return {
    part_id: partID(session.id, compacted.messageID, SUMMARY_KEY),
    session_id: session.id,
    message_id: compacted.messageID,
    kind: "summary",
    tool_name: null,
    body: withoutInlineMedia(summaryText(compacted)).trim(),
    time_created: compacted.at,
  }
}

/** Every indexable part of one message. */
export function rowsOf(message: Message): IndexRow[] {
  const rows: IndexRow[] = []
  const add = (key: string, kind: RowKind, body: string | undefined, time: number, tool: string | null = null) => {
    const clean = body ? withoutInlineMedia(body).trim() : ""
    if (!clean) return
    rows.push({ part_id: partID(message.sessionID, message.id, key), session_id: message.sessionID, message_id: message.id, kind, tool_name: tool, body: clean, time_created: time })
  }
  if (message.role === "user") {
    add("text", "text", message.text, message.time.created)
    message.attachments.forEach((file, at) => add(`file:${at}`, "file", `${file.path} ${file.mime}`, message.time.created))
    return rows
  }
  for (const part of message.parts) {
    if (part.type === "text") add(part.id, "text", part.text, message.time.created)
    else if (part.type === "reasoning") add(part.id, "reasoning", part.text, part.time.created)
    else if (part.type === "tool") add(part.id, "tool", toolBody(part), part.time.created, part.name)
  }
  // A reply that failed keeps what the provider said, as MiMo keeps its retry errors.
  if (message.error) add(ERROR_KEY, "error", message.error, message.time.completed ?? message.time.created)
  return rows
}

/** One part as `around` lists it: which part, what kind, and its full text before summarising. */
export interface PartText {
  part_id: string
  type: RowKind
  role: "user" | "assistant"
  tool_name: string | null
  text: string
}

/** A part's whole text, as `get` pages through it and `around` summarises it. */
export function partTexts(message: Message): PartText[] {
  const out: PartText[] = []
  const id = (key: string) => partID(message.sessionID, message.id, key)
  if (message.role === "user") {
    if (message.text) out.push({ part_id: id("text"), type: "text", role: "user", tool_name: null, text: message.text })
    message.attachments.forEach((file, at) =>
      out.push({ part_id: id(`file:${at}`), type: "file", role: "user", tool_name: null, text: `file: ${file.path}\nmime: ${file.mime}` }),
    )
    return out
  }
  for (const part of message.parts) {
    if (part.type === "text" && part.text) out.push({ part_id: id(part.id), type: "text", role: "assistant", tool_name: null, text: part.text })
    else if (part.type === "reasoning" && part.text) out.push({ part_id: id(part.id), type: "reasoning", role: "assistant", tool_name: null, text: part.text })
    else if (part.type === "tool") {
      const files = (part.attachments ?? []).map((file) => `attachment: ${file.path} (${file.mime})`)
      const text = [`tool: ${part.name}`, `status: ${part.status}`, `input: ${JSON.stringify(part.input ?? {})}`, `output: ${part.output ?? ""}`, `error: ${part.error ?? ""}`, ...files].join("\n")
      out.push({ part_id: id(part.id), type: "tool", role: "assistant", tool_name: part.name, text })
    }
  }
  if (message.error) out.push({ part_id: id(ERROR_KEY), type: "error", role: "assistant", tool_name: null, text: message.error })
  return out
}

/** The compaction summary as a part of the message it ends at, when this message is that one. */
export function summaryPart(session: Pick<SessionInfo, "id" | "compacted">, messageID: string): PartText | undefined {
  const compacted = session.compacted
  if (!compacted?.summary.trim() || compacted.messageID !== messageID) return undefined
  return { part_id: partID(session.id, messageID, SUMMARY_KEY), type: "summary", role: "assistant", tool_name: null, text: summaryText(compacted) }
}
