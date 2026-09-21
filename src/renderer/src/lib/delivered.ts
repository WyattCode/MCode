import type { AssistantPart, Message, ToolPart } from "@shared/protocol"
import { openDocument, officeTypeOf } from "./office-open"
import { requestPdfLocate } from "./annotate"
import { mediaOf } from "./markdown"
import { addressName, demotedInBatch, normalizedAddress } from "@shared/session-files"

/*
 * MiMo's two window tools, on the renderer's side: what a present_files call
 * handed over (the cards under the reply), and what happens when either tool
 * completes - see the end of this file.
 */

export type Delivered =
  | { kind: "file"; path: string; name: string; size: number }
  | { kind: "url"; url: string; name: string }

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value)

/**
 * The files a turn's completed present_files calls handed over, in order, each
 * once - without the ones MiMo's demotions set aside from each call's batch
 * (renders and copies made on the way to a document, T10-19).
 */
export function deliveredFiles(parts: readonly AssistantPart[]): Delivered[] {
  const out: Delivered[] = []
  const seen = new Set<string>()
  for (const part of parts) {
    if (part.type !== "tool" || part.name !== "present_files" || part.status !== "completed") continue
    const files = part.metadata?.files
    if (!Array.isArray(files)) continue
    const entries = files.filter(isRecord)
    const demoted = demotedInBatch(entries.flatMap((entry) => (typeof entry.path === "string" && entry.path ? [entry.path] : [])))
    for (const entry of entries) {
      if (typeof entry.path === "string" && entry.path) {
        if (demoted.has(entry.path)) continue
        const key = entry.path.replace(/\\/g, "/").toLowerCase()
        if (seen.has(key)) continue
        seen.add(key)
        const name = typeof entry.name === "string" && entry.name ? entry.name : entry.path.split(/[\\/]/).pop() || entry.path
        out.push({ kind: "file", path: entry.path, name, size: typeof entry.size === "number" ? entry.size : 0 })
      } else if (typeof entry.url === "string" && /^https?:\/\//i.test(entry.url)) {
        // Calls recorded before addresses were normalised carry them as written.
        const url = normalizedAddress(entry.url) ?? entry.url
        if (seen.has(url)) continue
        seen.add(url)
        out.push({ kind: "url", url, name: addressName(url) })
      }
    }
  }
  return out
}

/** MiMo's size words: bytes, then KB and MB to one place. */
export function sizeLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/** Which of MiMo's cards a delivered entry is drawn as: a picture, video or sound is previewed rather than listed. */
export function deliveredCard(item: Delivered): "office" | "html" | "media" | "file" | "url" {
  if (item.kind === "url") return "url"
  if (officeTypeOf(item.name) ?? officeTypeOf(item.path)) return "office"
  if (/\.html?$/i.test(item.name) || /\.html?$/i.test(item.path)) return "html"
  return mediaOf(item.path) ? "media" : "file"
}

/**
 * The file a path in a reply names, for previewing it wherever it lives.
 *
 * MiMo reads any path the model writes to show it; the user decided on
 * 2026-09-16 that MCode does the same, so this does not keep to the project.
 * A relative path is still taken from the conversation's folder, because that
 * is what a relative path in a reply means, and a web address or any other
 * scheme is not a file to read at all. The window never reads the disk itself:
 * the card resolves this through the main process and shows it from the local
 * preview server, which hands out only the file's own folder.
 */
export function mediaPath(file: string, directory: string | undefined): string | undefined {
  const norm = file.trim().replace(/\\/g, "/")
  if (!norm || norm.startsWith("~") || /^[a-z][a-z0-9+.-]*:/i.test(norm.replace(/^[A-Za-z]:\//, ""))) return undefined
  if (/^[A-Za-z]:\//.test(norm) || norm.startsWith("/")) return norm
  if (!directory) return undefined
  const base = directory.replace(/\\/g, "/").replace(/\/+$/, "")
  return `${base}/${norm.replace(/^\.\//, "")}`
}

/** A path under a folder, as the folder-relative path the main process opens; empty when it is not under it. */
export function relativeInside(directory: string, file: string): string {
  const norm = (value: string) => value.replace(/\\/g, "/").replace(/\/+$/, "")
  const base = `${norm(directory)}/`
  const full = norm(file)
  return full.toLowerCase().startsWith(base.toLowerCase()) ? full.slice(base.length) : ""
}

/* ------------------------------------------------------------ opening what a turn handed over */

/*
 * MiMo's automatic opens, for every conversation rather than only the one on
 * show (T10-18). A pdf_locate that completes asks the PDF view to mark its
 * passage at once and opens the PDF - or, when its conversation is not on
 * show, keeps the open until it is. A present_files call only notes what it
 * handed over; when the turn ends, the first file the whole turn handed over
 * (after the demotions, T10-19) is opened the same way. What opens depends on
 * the file (T10-48): a web address goes to the system browser, a picture or a
 * sound opens nothing, anything else goes to the right panel.
 *
 * Only calls this window saw complete count: a transcript read back, or a
 * conversation opened later, opens nothing it did not see happen.
 */

type Pending = { kind: "delivered"; item: Delivered } | { kind: "pdf"; path: string }

/** Opens held for a conversation until it is on show; the latest one wins, as MiMo keeps one. */
const pending = new Map<string, Pending>()
/** present_files calls of the turn each conversation is running, in order. */
const presentedThisTurn = new Map<string, ToolPart[]>()
/** Calls already acted on, and calls seen before they completed. */
const handled = new Set<string>()
const seenRunning = new Set<string>()
const windowStarted = Date.now()

let shownCheck: (sessionID: string) => boolean = () => false
let directoryOf: (sessionID: string) => string | undefined = () => undefined

/** How the window says which conversations are on show, and where each works. */
export function setDeliveryView(view: { shown: (sessionID: string) => boolean; directory: (sessionID: string) => string | undefined }): void {
  shownCheck = view.shown
  directoryOf = view.directory
}

const NOT_OPENED = new Set(["svg", "png", "jpg", "jpeg", "gif", "webp", "bmp", "avif", "ico", "wav", "mp3", "m4a", "ogg", "flac", "aac"])

/** What an automatic open does with a delivered entry: MiMo's `none`, `external`, or the right panel. */
export function autoOpenKind(item: Delivered): "none" | "external" | "panel" {
  if (item.kind === "url") return "external"
  const name = (item.name || item.path).toLowerCase()
  const dot = name.lastIndexOf(".")
  return dot > 0 && NOT_OPENED.has(name.slice(dot + 1)) ? "none" : "panel"
}

async function perform(action: Pending, directory: string | undefined): Promise<void> {
  if (action.kind === "pdf") {
    await openDocument({ path: action.path }, directory)
    return
  }
  const item = action.item
  if (item.kind === "url") {
    window.mcode.openExternal(item.url)
    return
  }
  await openDocument({ path: item.path, name: item.name }, directory)
}

function openOrHold(sessionID: string, action: Pending): void {
  if (shownCheck(sessionID)) void perform(action, directoryOf(sessionID)).catch(() => undefined)
  else pending.set(sessionID, action)
}

/** A conversation came on show: what was held for it opens now. */
export function deliveryShown(sessionID: string | undefined): void {
  if (!sessionID) return
  const action = pending.get(sessionID)
  if (!action || !shownCheck(sessionID)) return
  pending.delete(sessionID)
  void perform(action, directoryOf(sessionID)).catch(() => undefined)
}

async function locate(sessionID: string, part: ToolPart): Promise<void> {
  const input = part.input ?? {}
  const file = typeof part.metadata?.path === "string" ? part.metadata.path : typeof input.file === "string" ? input.file : ""
  const snippet = typeof input.snippet === "string" ? input.snippet : ""
  const page = typeof input.page === "number" && Number.isFinite(input.page) ? input.page : undefined
  if (!file || !/\.pdf$/i.test(file)) return
  // MiMo ignores a path that is not on disk.
  const found = await window.mcode.resolveExistingPath([file]).catch(() => null)
  if (!found || found.directory) return
  requestPdfLocate({ path: found.path, snippet, page })
  openOrHold(sessionID, { kind: "pdf", path: found.path })
}

/** Every message update the window receives, from any conversation. */
export function noteDeliveryUpdate(message: Message): void {
  if (message.role === "user") {
    // A new turn of its own starts a new list; a message sent into a running turn does not.
    if (!message.steered) presentedThisTurn.delete(message.sessionID)
    return
  }
  for (const part of message.parts) {
    if (part.type !== "tool" || (part.name !== "pdf_locate" && part.name !== "present_files") || handled.has(part.callID)) continue
    if (part.status !== "completed") {
      if (part.status === "running" || part.status === "pending") seenRunning.add(part.callID)
      continue
    }
    handled.add(part.callID)
    const live = seenRunning.delete(part.callID) || (part.time.completed ?? 0) >= windowStarted
    if (!live) continue
    if (part.name === "pdf_locate") void locate(message.sessionID, part).catch(() => undefined)
    else presentedThisTurn.set(message.sessionID, [...(presentedThisTurn.get(message.sessionID) ?? []), part])
  }
}

/** A conversation's turn ended: the first thing the turn handed over opens, or waits to. */
export function noteDeliveryTurnEnded(sessionID: string): void {
  const parts = presentedThisTurn.get(sessionID)
  presentedThisTurn.delete(sessionID)
  const first = parts ? deliveredFiles(parts)[0] : undefined
  if (!first || autoOpenKind(first) === "none") return
  openOrHold(sessionID, { kind: "delivered", item: first })
}
