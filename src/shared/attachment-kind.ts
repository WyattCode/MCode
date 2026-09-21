/**
 * What kind of file an attachment is, by its name alone.
 *
 * MiMo sorts an attached file into one of four groups by extension and nothing
 * else, and every later decision follows from the group: a picture travels in
 * the message, a text file is named so the model reads it, an Office document
 * is named together with the library that opens it, and anything else is a path
 * to work on. The same four groups decide, in the composer, whether a dropped
 * file becomes an `@mention` instead of an attachment.
 *
 * Kept here rather than in either half of the app because both halves ask: the
 * window when a file is dropped, the server when the message is built.
 */

export type AttachmentKind = "image" | "text" | "office" | "binary"

/** Pictures that travel inside the message. Deliberately no `.svg`: it is markup, and MiMo treats it as a file to open rather than a picture to send. */
const IMAGE = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp"])

/** Moving pictures. Named as their own group because the composer shows them as thumbnails; on the wire they are binary. */
const VIDEO = new Set(["mp4", "m4v", "webm", "mov", "ogv"])

/**
 * Files worth reading as text.
 *
 * Long on purpose: the short list this replaced knew about 45 extensions, so a
 * `.rst`, a `.cjs`, a `.gradle` or a `.tf` dropped on the box was attached as
 * an opaque binary rather than named for the model to read.
 */
const TEXT = new Set([
  // Prose and documentation
  "txt", "text", "md", "markdown", "mdx", "rst", "adoc", "asciidoc", "org", "tex", "bib",
  // Web
  "html", "htm", "xhtml", "xml", "vue", "svelte", "astro", "css", "scss", "sass", "less", "styl",
  // JavaScript and friends
  "js", "jsx", "mjs", "cjs", "ts", "tsx", "mts", "cts",
  // Other languages
  "py", "pyi", "pyw", "rb", "go", "rs", "java", "kt", "kts", "gradle", "swift", "scala", "clj", "cljs",
  "c", "h", "cc", "cpp", "cxx", "hh", "hpp", "hxx", "m", "mm", "cs", "fs", "php", "pl", "pm", "lua", "r",
  "dart", "ex", "exs", "erl", "hs", "jl", "nim", "zig", "v", "vb", "groovy", "sql", "graphql", "gql", "proto",
  // Shells and build files
  "sh", "bash", "zsh", "fish", "ps1", "psm1", "bat", "cmd", "awk", "sed", "mk", "cmake", "makefile", "dockerfile",
  // Configuration and data
  "json", "jsonc", "json5", "yaml", "yml", "toml", "ini", "cfg", "conf", "properties", "env", "editorconfig",
  "npmrc", "nvmrc", "babelrc", "eslintrc", "prettierrc", "gitignore", "gitattributes", "dockerignore",
  "csv", "tsv", "log", "diff", "patch", "lock", "tf", "tfvars", "hcl", "tfstate", "plist", "srt", "vtt",
])

/** Documents a model cannot read as text: reading one gives back the container, not the words. */
const OFFICE = new Set(["xlsx", "xls", "xlsm", "xlsb", "docx", "doc", "rtf", "pptx", "ppt", "pdf", "ods", "odt", "odp", "epub"])

/** The extension of a path or a bare name, lower-cased, without the dot; empty when there is none. */
export function extensionOf(file: string): string {
  const name = file.split(/[\\/]/).pop() ?? ""
  const dot = name.lastIndexOf(".")
  if (dot > 0) return name.slice(dot + 1).toLowerCase()
  // A file whose whole name says what it is: Makefile, Dockerfile, .gitignore.
  const bare = name.replace(/^\./, "").toLowerCase()
  return TEXT.has(bare) ? bare : ""
}

export function attachmentKind(file: string): AttachmentKind {
  const extension = extensionOf(file)
  if (IMAGE.has(extension)) return "image"
  if (VIDEO.has(extension)) return "binary"
  if (OFFICE.has(extension)) return "office"
  if (TEXT.has(extension)) return "text"
  return "binary"
}

/** Whether a file's name says it holds text - the same table the attachment groups use. */
export function textualName(file: string): boolean {
  return TEXT.has(extensionOf(file))
}

/** Whether a file's name says it is a picture the message can carry. */
export function imageName(file: string): boolean {
  return IMAGE.has(extensionOf(file))
}

/** Whether a file's name says it is a video - shown as a thumbnail, sent as a path. */
export function videoName(file: string): boolean {
  return VIDEO.has(extensionOf(file))
}
