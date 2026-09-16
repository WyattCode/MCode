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
const WRITERS = new Set(["write", "edit", "multiedit"])

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
      // `file_path` since the tools took MiMo's names; `path` on turns stored before.
      const target = part.input?.file_path ?? part.input?.path
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

// ------------------------------------------------------------ the info card

/** Something to hand over, or a step on the way to it. */
export type ArtifactRole = "deliverable" | "intermediate"

/** Which icon a produced file is drawn with. */
export type ArtifactKind = "xlsx" | "docx" | "pptx" | "pdf" | "html" | "image" | "video" | "other"

export interface SessionArtifact {
  /** Project-relative where the file is inside the project, absolute otherwise. */
  path: string
  at: number
  role: ArtifactRole
  kind: ArtifactKind
}

const extensionOf = (file: string) => {
  const name = file.slice(file.lastIndexOf("/") + 1).toLowerCase()
  const dot = name.lastIndexOf(".")
  return dot > 0 ? name.slice(dot + 1) : ""
}

const stemOf = (file: string) => {
  const name = file.slice(file.lastIndexOf("/") + 1).toLowerCase()
  const dot = name.lastIndexOf(".")
  return dot > 0 ? name.slice(0, dot) : name
}

const IMAGE = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "avif"])
const VIDEO = new Set(["mp4", "webm", "mov", "m4v", "mkv"])
const AUDIO = new Set(["mp3", "wav", "m4a", "ogg", "flac"])
const OFFICE = new Set(["docx", "pptx", "xlsx"])
const NOTEBOOK = new Set(["md", "markdown", "ipynb"])

/*
 * What a person opens rather than runs. MCode has no tool for presenting files,
 * so this list stands in for the model saying "here is what I made".
 */
const DELIVERABLE = new Set([
  ...OFFICE, "doc", "ppt", "xls", "pdf", "html", "htm", "md", "markdown", "ipynb", "csv", "tsv",
  ...IMAGE, ...VIDEO, ...AUDIO,
])

export function artifactKind(file: string): ArtifactKind {
  const extension = extensionOf(file)
  if (extension === "xlsx" || extension === "xls" || extension === "csv" || extension === "tsv") return "xlsx"
  if (extension === "docx" || extension === "doc" || extension === "md" || extension === "markdown") return "docx"
  if (extension === "pptx" || extension === "ppt") return "pptx"
  if (extension === "pdf") return "pdf"
  if (extension === "html" || extension === "htm") return "html"
  if (IMAGE.has(extension)) return "image"
  if (VIDEO.has(extension)) return "video"
  return "other"
}

/** Folders a render or a scratch step lands in, rather than a finished piece. */
const WORK_FOLDERS = new Set([
  "preview", "previews", "pages", "slides", "render", "renders", "rendered", "screenshot", "screenshots",
  "thumbnail", "thumbnails", "tmp", "temp", "cache", ".cache",
])

/**
 * MiMo's demotions, applied to one conversation's deliverables as a batch: the
 * pictures and PDFs made on the way to a document are not handed over beside it.
 */
function demoted(file: string, batch: readonly string[]): boolean {
  const extension = extensionOf(file)
  const stem = stemOf(file)
  const delivered = (set: ReadonlySet<string>) =>
    batch.some((other) => other !== file && set.has(extensionOf(other)) && stemOf(other) === stem)
  const hasDocument = batch.some((other) => OFFICE.has(extensionOf(other)) || extensionOf(other) === "pdf")
  if (IMAGE.has(extension)) {
    const folders = file.toLowerCase().split("/").slice(0, -1)
    if (hasDocument && folders.some((folder) => WORK_FOLDERS.has(folder))) return true
    const images = batch.filter((other) => IMAGE.has(extensionOf(other))).length
    if (hasDocument && images >= 3 && /[_-]\d{1,3}$/.test(stem)) return true
    if (delivered(OFFICE)) return true
  }
  if (extension === "pdf" && (delivered(OFFICE) || delivered(new Set(["html", "htm"])))) return true
  if ((extension === "pdf" || extension === "html" || extension === "htm") && delivered(NOTEBOOK)) return true
  return false
}

/**
 * What a conversation produced, for the info card's 产物.
 *
 * The rule:
 * - a file a completed `present_files` call handed over is a deliverable,
 *   whatever it is and however it came to be, as MiMo's role "deliverable" is;
 * - otherwise only a file a completed `write` created counts; editing a file
 *   that was already there is a change, and the review is where changes are shown;
 * - a created document, sheet, deck, PDF, web page, markdown, notebook, table,
 *   picture, video or recording is a deliverable; anything else created
 *   (code, configuration, scripts, data, plain text) is intermediate;
 * - a deliverable is demoted to intermediate by MiMo's rules for renders made
 *   on the way to a document (see `demoted`).
 * Newest first, each file once.
 */
export function sessionArtifacts(messages: readonly Message[], directory: string): SessionArtifact[] {
  const created = new Map<string, number>()
  const key = (file: string) => file.toLowerCase()
  const shown = new Map<string, string>()
  const presented = new Set<string>()
  for (const message of messages) {
    if (message.role !== "assistant") continue
    for (const raw of message.parts) {
      const part = raw as Partial<ToolPart>
      if (part.type === "tool" && part.name === "present_files" && part.status === "completed") {
        const handed = Array.isArray(part.metadata?.files) ? part.metadata.files : []
        for (const entry of handed) {
          const target = typeof entry === "object" && entry !== null ? (entry as { path?: unknown }).path : undefined
          const file = typeof target === "string" ? projectRelative(directory, target) : undefined
          if (!file) continue
          presented.add(key(file))
          if (!created.has(key(file))) created.set(key(file), part.time?.completed ?? part.time?.created ?? message.time.created)
          shown.set(key(file), file)
        }
        continue
      }
      if (part.type !== "tool" || part.name !== "write" || part.status !== "completed") continue
      if (part.metadata?.created !== true) continue
      const target = part.input?.file_path ?? part.input?.path
      if (typeof target !== "string") continue
      const file = projectRelative(directory, target)
      if (!file) continue
      created.set(key(file), part.time?.completed ?? part.time?.created ?? message.time.created)
      shown.set(key(file), file)
    }
  }
  // A later write to the same file moves it up without changing whether it was created here.
  const touched = new Map(sessionFiles(messages, directory).written.map((entry) => [key(entry.path), entry.at]))
  const files = [...created.keys()].map((id) => ({ path: shown.get(id) ?? id, at: Math.max(created.get(id) ?? 0, touched.get(id) ?? 0) }))
  const candidates = files.filter((file) => DELIVERABLE.has(extensionOf(file.path))).map((file) => file.path)
  return files
    .map((file) => ({
      ...file,
      kind: artifactKind(file.path),
      role: (presented.has(key(file.path)) || (candidates.includes(file.path) && !demoted(file.path, candidates))
        ? "deliverable"
        : "intermediate") as ArtifactRole,
    }))
    .sort((a, b) => b.at - a.at)
}

export interface SessionReferences {
  /** What the user attached to their messages. */
  uploads: string[]
  /** Project files the session read that it did not also write, nor that were uploaded. */
  project: string[]
}

/**
 * The info card's 参考, split as MiMo splits it. A web address never appears:
 * MiMo filters them out, so its 联网搜索 group is never drawn.
 */
export function sessionReferences(messages: readonly Message[], directory: string): SessionReferences {
  const name = (file: string) => file.slice(file.lastIndexOf("/") + 1).toLowerCase()
  const uploads: string[] = []
  const seenUploads = new Set<string>()
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.role !== "user") continue
    for (const attachment of message.attachments ?? []) {
      const file = projectRelative(directory, attachment.path ?? "")
      if (!file || file.includes("://") || seenUploads.has(file.toLowerCase())) continue
      seenUploads.add(file.toLowerCase())
      uploads.push(file)
    }
  }
  const { written, read } = sessionFiles(messages, directory)
  const outputs = new Set(written.map((entry) => entry.path.toLowerCase()))
  const outputNames = new Set(written.map((entry) => name(entry.path)))
  const uploadNames = new Set(uploads.map(name))
  const project = read
    .map((entry) => entry.path)
    .filter((file) => !file.includes("://"))
    .filter((file) => !outputs.has(file.toLowerCase()) && !outputNames.has(name(file)) && !uploadNames.has(name(file)))
  return { uploads, project }
}
