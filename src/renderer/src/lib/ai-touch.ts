import { shallowRef } from "vue"
import type { Message } from "@shared/protocol"
import { useApp } from "../stores/app"
import { promptOf } from "./annotation-fx"

/*
 * MiMo's attribution of a change on disk: whether a document changed because
 * the assistant touched it - an edit or write that just finished on that file,
 * a run still going in a project that holds it, or one that ended moments ago.
 * A document view records the new bytes as the assistant's version when so,
 * with what was asked as its note, and as an outside edit otherwise.
 */

const writes = new Map<string, number>()
const ended = new Map<string, number>()
const seen = new Set<string>()
const created = new Set<string>()

/**
 * The files edits and writes just finished on, for views that follow the
 * assistant's writes rather than the disk (MiMo's web page tab). One batch holds
 * every file noted in the same tick, so a watcher never misses all but the last.
 */
export const aiWrite = shallowRef<{ files: string[]; seq: number } | null>(null)

let pending: string[] = []

function publish(file: string) {
  if (!pending.length) {
    queueMicrotask(() => {
      const files = [...new Set(pending)]
      pending = []
      aiWrite.value = { files, seq: (aiWrite.value?.seq ?? 0) + 1 }
    })
  }
  pending.push(file)
}

/** A path as compared: forward slashes, "." and ".." resolved, no doubled or trailing slash, lower case. */
export function normalPath(file: string): string {
  const slashed = file.replace(/\\/g, "/")
  const lead = slashed.startsWith("//") ? "//" : slashed.startsWith("/") ? "/" : ""
  const out: string[] = []
  for (const segment of slashed.slice(lead.length).split("/")) {
    if (!segment || segment === ".") continue
    if (segment !== "..") {
      out.push(segment)
      continue
    }
    const last = out[out.length - 1]
    // ".." stops at a root (a drive or a leading slash); a relative path keeps the ones it starts with.
    if (last === undefined ? !lead : last === "..") out.push(segment)
    else if (last !== undefined && !/^[a-z]:$/i.test(last)) out.pop()
  }
  return `${lead}${out.join("/")}`.toLowerCase()
}

const normal = normalPath
const isAbsolute = (file: string) => /^([a-zA-Z]:)?[\\/]/.test(file)

function contains(directory: string | undefined, file: string) {
  if (!directory) return false
  const root = `${normal(directory)}/`
  return normal(file).startsWith(root)
}

/** Notes the files an assistant message's finished edits and writes changed. */
export function noteToolWrites(message: Message, directory: string | undefined) {
  if (message.role !== "assistant") return
  for (const part of message.parts) {
    if (part.type !== "tool" || part.status !== "completed" || !["edit", "multiedit", "write", "patch"].includes(part.name)) continue
    const key = `${message.id}:${part.id}`
    if (seen.has(key)) continue
    seen.add(key)
    const input = (part.input ?? {}) as Record<string, unknown>
    const files = (part.metadata as { files?: unknown } | undefined)?.files
    const paths = [
      ...(typeof input.file_path === "string" ? [input.file_path] : typeof input.path === "string" ? [input.path] : []),
      ...(Array.isArray(files) ? files.map((entry) => (typeof entry === "string" ? entry : (entry as { path?: string })?.path)).filter((entry): entry is string => typeof entry === "string") : []),
    ]
    const made = part.name === "write" && (part.metadata as { created?: unknown } | undefined)?.created === true
    for (const file of paths) {
      const absolute = isAbsolute(file) || !directory ? file : `${directory}/${file}`
      writes.set(normal(absolute), Date.now())
      if (made) created.add(normal(absolute))
      publish(absolute)
    }
  }
}

/** Whether the assistant has just created this file; asked once, as MiMo plays a new deck's entrance only on its first open. */
export function takeCreated(file: string): boolean {
  return created.delete(normal(file))
}

export function noteRunEnded(sessionID: string) {
  ended.set(sessionID, Date.now())
}

export function aiTouch(file: string, windowMs = 3000): { ai: boolean; prompt: string } {
  const app = useApp()
  const now = Date.now()
  const key = normal(file)
  const directoryOf = (id: string) => app.sessions.find((session) => session.id === id)?.directory
  for (const id of app.running) {
    if (contains(directoryOf(id), file)) return { ai: true, prompt: promptOf(id) }
  }
  for (const [id, at] of ended) {
    if (now - at <= windowMs && contains(directoryOf(id), file)) return { ai: true, prompt: promptOf(id) }
  }
  const wrote = writes.get(key)
  if (wrote !== undefined && now - wrote <= windowMs) return { ai: true, prompt: "" }
  return { ai: false, prompt: "" }
}
