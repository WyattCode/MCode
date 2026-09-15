import { watch } from "vue"
import type { AssistantPart, Message, ToolPart } from "@shared/protocol"
import { openDocument, officeTypeOf } from "./office-open"
import { requestPdfLocate } from "./annotate"

/*
 * MiMo's two window tools, on the renderer's side: what a present_files call
 * handed over (the cards under the reply), and what happens when either tool
 * completes in the conversation on show - the first delivered file opens in
 * the right panel, and a PDF locate opens or focuses the PDF and marks the passage.
 */

export type Delivered =
  | { kind: "file"; path: string; name: string; size: number }
  | { kind: "url"; url: string; name: string }

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value)

/** The files a turn's completed present_files calls handed over, in order, each once. */
export function deliveredFiles(parts: readonly AssistantPart[]): Delivered[] {
  const out: Delivered[] = []
  const seen = new Set<string>()
  for (const part of parts) {
    if (part.type !== "tool" || part.name !== "present_files" || part.status !== "completed") continue
    const files = part.metadata?.files
    if (!Array.isArray(files)) continue
    for (const entry of files) {
      if (!isRecord(entry)) continue
      if (typeof entry.path === "string" && entry.path) {
        const key = entry.path.replace(/\\/g, "/").toLowerCase()
        if (seen.has(key)) continue
        seen.add(key)
        const name = typeof entry.name === "string" && entry.name ? entry.name : entry.path.split(/[\\/]/).pop() || entry.path
        out.push({ kind: "file", path: entry.path, name, size: typeof entry.size === "number" ? entry.size : 0 })
      } else if (typeof entry.url === "string" && /^https?:\/\//i.test(entry.url)) {
        if (seen.has(entry.url)) continue
        seen.add(entry.url)
        out.push({ kind: "url", url: entry.url, name: entry.url })
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

/** Which of MiMo's cards a delivered entry is drawn as. */
export function deliveredCard(item: Delivered): "office" | "html" | "file" | "url" {
  if (item.kind === "url") return "url"
  if (officeTypeOf(item.name) ?? officeTypeOf(item.path)) return "office"
  return /\.html?$/i.test(item.name) || /\.html?$/i.test(item.path) ? "html" : "file"
}

/** A path under a folder, as the folder-relative path the main process opens; empty when it is not under it. */
export function relativeInside(directory: string, file: string): string {
  const norm = (value: string) => value.replace(/\\/g, "/").replace(/\/+$/, "")
  const base = `${norm(directory)}/`
  const full = norm(file)
  return full.toLowerCase().startsWith(base.toLowerCase()) ? full.slice(base.length) : ""
}

/* A completion counts only when it is new: finished after the conversation came on screen, and just now. */
const RECENT_MS = 15_000
const FOLLOWED = new Set(["pdf_locate", "present_files"])

async function follow(part: ToolPart, directory: string | undefined) {
  if (part.name === "present_files") {
    const first = deliveredFiles([part])[0]
    if (first?.kind === "file") await openDocument({ path: first.path, name: first.name }, directory)
    return
  }
  const input = part.input ?? {}
  const file = typeof part.metadata?.path === "string" ? part.metadata.path : typeof input.file === "string" ? input.file : ""
  const snippet = typeof input.snippet === "string" ? input.snippet : ""
  const page = typeof input.page === "number" && Number.isFinite(input.page) ? input.page : undefined
  if (!file || !/\.pdf$/i.test(file)) return
  // MiMo ignores a path that is not on disk.
  const found = await window.mcode.resolveExistingPath([file]).catch(() => null)
  if (!found || found.directory) return
  await openDocument({ path: found.path }, directory)
  requestPdfLocate({ path: found.path, snippet, page })
}

/**
 * Watches the conversation on show for the two tools completing, and acts once
 * per call. A conversation opened later, or a transcript read back, has only old
 * completions and so opens nothing.
 */
export function followDeliveries(source: {
  enabled: () => boolean
  session: () => string | undefined
  messages: () => readonly Message[]
  directory: () => string | undefined
}) {
  const handled = new Set<string>()
  let since = Date.now()
  watch(source.session, () => (since = Date.now()))
  watch(
    () => {
      if (!source.enabled()) return []
      const list = source.messages()
      const found: ToolPart[] = []
      // A completion lands in the turn being written, so only the last few messages are looked at.
      for (let at = Math.max(0, list.length - 4); at < list.length; at++) {
        const message = list[at]
        if (message.role !== "assistant") continue
        for (const part of message.parts) {
          if (part.type === "tool" && FOLLOWED.has(part.name) && part.status === "completed" && !handled.has(part.callID)) found.push(part)
        }
      }
      return found
    },
    (parts) => {
      for (const part of parts) {
        if (handled.has(part.callID)) continue
        handled.add(part.callID)
        const done = part.time.completed ?? 0
        if (done < since || Date.now() - done > RECENT_MS) continue
        void follow(part, source.directory()).catch(() => undefined)
      }
    },
  )
}
