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

const normal = (file: string) => file.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase()
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
    if (part.type !== "tool" || part.status !== "completed" || !["edit", "write", "patch"].includes(part.name)) continue
    const key = `${message.id}:${part.id}`
    if (seen.has(key)) continue
    seen.add(key)
    const input = (part.input ?? {}) as Record<string, unknown>
    const files = (part.metadata as { files?: unknown } | undefined)?.files
    const paths = [
      ...(typeof input.path === "string" ? [input.path] : []),
      ...(Array.isArray(files) ? files.map((entry) => (typeof entry === "string" ? entry : (entry as { path?: string })?.path)).filter((entry): entry is string => typeof entry === "string") : []),
    ]
    for (const file of paths) {
      const absolute = isAbsolute(file) || !directory ? file : `${directory}/${file}`
      writes.set(normal(absolute), Date.now())
    }
  }
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
