import path from "node:path"
import type { Message, ToolPart } from "@shared/protocol"
import { withoutInlineMedia } from "./text"

/**
 * What of a conversation goes into the history index, and what `get` reads back.
 *
 * MiMo indexes what was said (user and assistant text, reasoning), attached
 * file names and types, and each finished tool call as its name, input and
 * output or error. A call still running is left out until it settles.
 *
 * A part is named `<session>/<message>/<part>` so that `get` can find it in the
 * JSON store without the index - which is what keeps `get` working while the
 * index is still being built.
 */

export type RowKind = "text" | "reasoning" | "file" | "tool"

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

function toolBody(part: ToolPart): string | undefined {
  if (part.status === "completed") return `${part.name} ${JSON.stringify(part.input ?? {})} ${JSON.stringify(part.output ?? "")}`
  if (part.status === "error") return `${part.name} ${JSON.stringify(part.input ?? {})} ${part.error ?? ""}`
  return undefined
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
      const text = [`tool: ${part.name}`, `status: ${part.status}`, `input: ${JSON.stringify(part.input ?? {})}`, `output: ${part.output ?? ""}`, `error: ${part.error ?? ""}`].join("\n")
      out.push({ part_id: id(part.id), type: "tool", role: "assistant", tool_name: part.name, text })
    }
  }
  return out
}
