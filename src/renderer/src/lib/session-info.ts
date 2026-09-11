import type { ToolPart } from "@shared/protocol"

/** One entry of the plan the todowrite tool records. */
export interface Todo {
  id: string
  content: string
  status: string
}

/** As much of a message as these readers need. A user message has no parts. */
interface Turn {
  role: string
  parts?: readonly unknown[]
}

/**
 * The most recent plan in a conversation.
 *
 * Read from the transcript rather than asked for, because the tool's own result
 * carries it and the newest call is by definition the current plan - an earlier
 * one is a plan that has since been rewritten.
 */
export function latestTodos(messages: readonly Turn[]): Todo[] {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    // Only an assistant turn runs tools.
    if (message?.role !== "assistant") continue
    const parts = message.parts ?? []
    for (let at = parts.length - 1; at >= 0; at -= 1) {
      const found = (parts[at] as { metadata?: { todos?: Todo[] } }).metadata?.todos
      if (found?.length) return found
    }
  }
  return []
}

export interface SessionFiles {
  /** Files the session changed - written, edited or patched - newest first. */
  written: string[]
  /** Files the session read, newest first. */
  read: string[]
}

/** Tools whose `path` input names a file they changed. */
const WRITERS = new Set(["write", "edit"])

/**
 * What a conversation has produced and what it has looked at, as paths
 * relative to the project where they are inside it.
 *
 * Only calls that completed count: a write that was refused or failed left
 * nothing behind, and a read that failed was not read. Each file is listed
 * once, where it was last touched.
 */
export function sessionFiles(messages: readonly Turn[], directory: string): SessionFiles {
  const written: string[] = []
  const read: string[] = []
  const seenWritten = new Set<string>()
  const seenRead = new Set<string>()
  const add = (list: string[], seen: Set<string>, file: string) => {
    const shown = projectRelative(directory, file)
    if (!shown || seen.has(shown)) return
    seen.add(shown)
    list.push(shown)
  }

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.role !== "assistant") continue
    const parts = message.parts ?? []
    for (let at = parts.length - 1; at >= 0; at -= 1) {
      const part = parts[at] as Partial<ToolPart>
      if (part.type !== "tool" || part.status !== "completed" || !part.name) continue
      const target = part.input?.path
      if (WRITERS.has(part.name)) {
        if (typeof target === "string") add(written, seenWritten, target)
      } else if (part.name === "apply_patch") {
        const files = part.metadata?.files
        if (Array.isArray(files)) {
          for (const file of files) if (typeof file === "string") add(written, seenWritten, file)
        }
      } else if (part.name === "read") {
        if (typeof target === "string") add(read, seenRead, target)
      }
    }
  }
  return { written, read }
}

/**
 * A path as the project would name it: relative, with forward slashes. One
 * outside the project stays absolute, since there is nothing to be relative to.
 * The comparison ignores case, which is what the file system does on Windows
 * and costs nothing elsewhere - two files differing only in case under one
 * project root are not a thing anyone has.
 */
export function projectRelative(directory: string, file: string): string {
  const path = file.trim().replace(/[\\/]+/g, "/")
  if (!path) return ""
  const absolute = path.startsWith("/") || /^[a-zA-Z]:\//.test(path)
  if (!absolute) return path.replace(/^(\.\/)+/, "")
  const root = directory.replace(/[\\/]+/g, "/").replace(/\/$/, "")
  if (root && path.toLowerCase().startsWith(`${root.toLowerCase()}/`)) return path.slice(root.length + 1)
  return path
}
