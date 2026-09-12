import type { Message, ToolPart } from "./protocol"

/** One file a session touched, and when it last touched it. */
export interface FileTouch {
  /** Project-relative where the file is inside the project, absolute otherwise. */
  path: string
  at: number
}

export interface SessionFiles {
  /** Files the session changed - written, edited or patched - newest first. */
  written: FileTouch[]
  /** Files the session read, newest first. */
  read: FileTouch[]
}

/** Tools whose `path` input names a file they changed. */
const WRITERS = new Set(["write", "edit"])

/**
 * What a conversation has produced and what it has looked at.
 *
 * Shared between the server, which answers the artifacts page for every stored
 * session, and the window, which draws the card beside the open one - so both
 * count a file as produced under exactly the same rule.
 *
 * Only calls that completed count: a write that was refused or failed left
 * nothing behind, and a read that failed was not read. Each file is listed
 * once, at the last moment it was touched.
 */
export function sessionFiles(messages: readonly Message[], directory: string): SessionFiles {
  const written: FileTouch[] = []
  const read: FileTouch[] = []
  const seenWritten = new Set<string>()
  const seenRead = new Set<string>()
  const add = (list: FileTouch[], seen: Set<string>, file: string, at: number) => {
    const path = projectRelative(directory, file)
    if (!path || seen.has(path)) return
    seen.add(path)
    list.push({ path, at })
  }

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    // Only an assistant turn runs tools; a user message has no parts at all.
    if (message?.role !== "assistant") continue
    const parts = message.parts
    for (let at = parts.length - 1; at >= 0; at -= 1) {
      const part = parts[at] as Partial<ToolPart>
      if (part.type !== "tool" || part.status !== "completed" || !part.name) continue
      const when = part.time?.completed ?? part.time?.created ?? message.time.created
      const target = part.input?.path
      if (WRITERS.has(part.name)) {
        if (typeof target === "string") add(written, seenWritten, target, when)
      } else if (part.name === "apply_patch") {
        const files = part.metadata?.files
        if (Array.isArray(files)) {
          for (const file of files) if (typeof file === "string") add(written, seenWritten, file, when)
        }
      } else if (part.name === "read") {
        if (typeof target === "string") add(read, seenRead, target, when)
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

/** The three buckets the artifacts page sorts its files into. */
export type FileKind = "doc" | "code" | "other"

const DOC_EXTENSIONS = new Set([
  "md", "markdown", "txt", "rst", "adoc", "pdf", "doc", "docx", "rtf", "odt",
  "csv", "tsv", "xls", "xlsx", "ods", "ppt", "pptx", "odp",
])

const CODE_EXTENSIONS = new Set([
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "vue", "svelte", "py", "rb", "go", "rs", "java", "kt",
  "c", "h", "cc", "cpp", "hpp", "cs", "swift", "m", "mm", "php", "lua", "sh", "bash", "zsh", "ps1",
  "bat", "sql", "html", "htm", "css", "scss", "less", "json", "yaml", "yml", "toml", "ini", "xml",
  "gradle", "cmake", "mk", "dockerfile", "tf", "proto", "graphql", "prisma",
])

/** Which bucket a file belongs in, by its extension and then by its name. */
export function fileKind(path: string): FileKind {
  const name = path.slice(path.lastIndexOf("/") + 1).toLowerCase()
  const dot = name.lastIndexOf(".")
  // A dotfile is its own name, not an extension: ".gitignore" is configuration.
  const extension = dot > 0 ? name.slice(dot + 1) : ""
  if (DOC_EXTENSIONS.has(extension)) return "doc"
  if (CODE_EXTENSIONS.has(extension)) return "code"
  if (!extension && (name === "makefile" || name === "dockerfile")) return "code"
  return "other"
}
