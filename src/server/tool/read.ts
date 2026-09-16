import fs from "node:fs/promises"
import { createReadStream } from "node:fs"
import { createInterface } from "node:readline"
import path from "node:path"
import type { ToolContext, ToolDefinition } from "./types"
import { ToolError } from "./types"
import { relative, resolvePath } from "./fs-util"

/** MiMo's read limits: 2,000 lines unless the call says, lines cut at 2,000 characters, 50 KB of text in all. */
const DEFAULT_LIMIT = 2000
const MAX_LINE_LENGTH = 2000
const MAX_BYTES = 50 * 1024
/** How much of a file is looked at to decide whether it is text. */
const SAMPLE_BYTES = 4096
const PREVIEW_LINES = 20

/** Extensions MiMo treats as binary without looking inside. */
const BINARY_EXTENSIONS = new Set([
  ".zip", ".tar", ".gz", ".exe", ".dll", ".so", ".class", ".jar", ".war", ".7z",
  ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx", ".odt", ".ods", ".odp",
  ".bin", ".dat", ".obj", ".o", ".a", ".lib", ".wasm", ".pyc", ".pyo",
])

/** The media MiMo's read attaches for a model that takes it. */
const MEDIA: Record<string, "image" | "PDF" | "audio" | "video"> = {
  ".png": "image",
  ".jpg": "image",
  ".jpeg": "image",
  ".gif": "image",
  ".webp": "image",
  ".pdf": "PDF",
  ".wav": "audio",
  ".mp3": "audio",
  ".mp4": "video",
}

/** Instruction files a folder can hold, the first one present standing for the folder, as MiMo looks for them. */
const INSTRUCTION_FILES = ["AGENTS.md", "CLAUDE.md", "CONTEXT.md"]

/** Instruction files a conversation has already been given, so each arrives once. */
const loadedInstructions = new Map<string, Set<string>>()

/** Binary by extension, or by a sample holding a NUL or more than 30% control characters. */
function isBinary(file: string, sample: Buffer): boolean {
  if (BINARY_EXTENSIONS.has(path.extname(file).toLowerCase())) return true
  if (sample.length === 0) return false
  let control = 0
  for (const byte of sample) {
    if (byte === 0) return true
    if (byte < 9 || (byte > 13 && byte < 32)) control++
  }
  return control / sample.length > 0.3
}

async function sampleOf(file: string, size: number): Promise<Buffer> {
  if (size === 0) return Buffer.alloc(0)
  const handle = await fs.open(file, "r")
  try {
    const buffer = Buffer.alloc(Math.min(SAMPLE_BYTES, size))
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    return buffer.subarray(0, bytesRead)
  } finally {
    await handle.close()
  }
}

/** A folder's entries, sorted, folders (and links to folders) marked with a slash. */
async function entriesOf(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true })
  const names = await Promise.all(
    entries.map(async (entry) => {
      if (entry.isDirectory()) return `${entry.name}/`
      if (!entry.isSymbolicLink()) return entry.name
      const target = await fs.stat(path.join(dir, entry.name)).catch(() => undefined)
      return target?.isDirectory() ? `${entry.name}/` : entry.name
    }),
  )
  return names.sort((a, b) => a.localeCompare(b))
}

/**
 * The instruction files between a file's folder and the project root, as MiMo
 * adds them when a file is read: the project root's own are already in the
 * system prompt, the file being read is not its own instruction, and each file
 * is given to a conversation once.
 */
async function instructionsFor(context: ToolContext, target: string): Promise<{ file: string; content: string }[]> {
  const root = path.resolve(context.directory)
  const seen = loadedInstructions.get(context.sessionID) ?? new Set<string>()
  loadedInstructions.set(context.sessionID, seen)
  const found: { file: string; content: string }[] = []
  let current = path.dirname(path.resolve(target))
  while (current.startsWith(root) && current !== root) {
    for (const name of INSTRUCTION_FILES) {
      const file = path.join(current, name)
      if (!(await fs.stat(file).then((stat) => stat.isFile(), () => false))) continue
      if (file !== path.resolve(target) && !seen.has(file)) {
        seen.add(file)
        const content = (await fs.readFile(file, "utf8").catch(() => "")).trim()
        if (content) found.push({ file, content })
      }
      break
    }
    current = path.dirname(current)
  }
  return found
}

/** Lines from `offset` on, within the line and byte limits, and how many lines the file has as far as it was read. */
async function linesOf(file: string, offset: number, limit: number) {
  const stream = createReadStream(file, { encoding: "utf8" })
  const reader = createInterface({ input: stream, crlfDelay: Infinity })
  const raw: string[] = []
  let bytes = 0
  let count = 0
  let cut = false
  let more = false
  try {
    for await (const text of reader) {
      count++
      if (count < offset) continue
      if (raw.length >= limit) {
        more = true
        continue
      }
      const line = text.length > MAX_LINE_LENGTH ? `${text.slice(0, MAX_LINE_LENGTH)}… (line cut at ${MAX_LINE_LENGTH} characters)` : text
      const size = Buffer.byteLength(line, "utf8") + (raw.length > 0 ? 1 : 0)
      if (bytes + size > MAX_BYTES) {
        cut = true
        more = true
        break
      }
      raw.push(line)
      bytes += size
    }
  } finally {
    reader.close()
    stream.destroy()
  }
  return { raw, count, cut, more }
}

export const ReadTool: ToolDefinition = {
  name: "read",
  description:
    "Read a file or list a folder. A file comes back as numbered lines, each written `N: text` - the text after that prefix is what the edit tool expects you to quote back. Long files are read in parts: pass offset (the line to start at) and limit. Output stops at 2,000 lines or 50 KB and says where to continue.",
  permission: "read",
  parameters: {
    type: "object",
    properties: {
      file_path: { type: "string", description: "Path of the file or folder, absolute or relative to the project root" },
      offset: { type: "number", description: "Line to start from, counting from 1" },
      limit: { type: "number", description: `Most lines to return, ${DEFAULT_LIMIT} when left out` },
    },
    required: ["file_path"],
    additionalProperties: false,
  },
  async execute(input, context) {
    const offset = input.offset === undefined ? 1 : Number(input.offset)
    if (!Number.isInteger(offset) || offset < 1) throw new ToolError(`offset has to be a line number of 1 or more: ${String(input.offset)}`)
    const limit = input.limit === undefined ? DEFAULT_LIMIT : Number(input.limit)
    if (!Number.isInteger(limit) || limit < 1) throw new ToolError(`limit has to be a whole number of 1 or more: ${String(input.limit)}`)

    const target = await resolvePath(context, String(input.file_path))
    const display = relative(context.directory, target)
    /*
     * Why the stat failed, not merely that it did.
     *
     * Every failure used to become "File not found", suggestions and all - so a
     * protected folder, a file owned by someone else or a Windows directory
     * this process cannot traverse was described as absent. The sensible next
     * move for a model told that is to create the file, or to hunt for a
     * spelling mistake that was never made. MiMo keeps the two apart, `noent`
     * from `denied`, and so does this.
     */
    const stat = await fs.stat(target).then(
      (value) => value,
      (err: NodeJS.ErrnoException) => err.code ?? "EUNKNOWN",
    )
    if (typeof stat === "string") {
      if (statFailure(stat) === "denied") throw new ToolError(denied(display), "error.readDenied", { path: display })
      throw new ToolError(await missing(context.directory, target, display))
    }

    if (stat.isDirectory()) {
      const entries = await entriesOf(target)
      const shown = entries.slice(offset - 1, offset - 1 + limit)
      const more = offset - 1 + shown.length < entries.length
      const footer = more
        ? `(${shown.length} of ${entries.length} entries shown; read again with offset=${offset + shown.length} for the rest)`
        : `(${entries.length} entries)`
      return {
        output: [`<path>${target}</path>`, "<type>directory</type>", "<entries>", shown.join("\n"), "", footer, "</entries>"].join("\n"),
        title: display || ".",
        metadata: { path: display || ".", preview: shown.slice(0, PREVIEW_LINES).join("\n"), truncated: more, loaded: [] },
      }
    }

    /*
     * MiMo attaches images, PDFs, audio and video for a model that takes them,
     * and this does the same: the file rides on the result by its path and is
     * read when the request is built. A model that cannot read that kind of
     * file gets the line below instead, which is what MiMo says to one without
     * the input.
     */
    const media = MEDIA[path.extname(target).toLowerCase()]
    if (media) {
      const how = media === "PDF" ? "If its text is what matters and it did not come through, extract it with a command-line tool." : "Inspect it with a command-line tool if it did not come through."
      const note = `"${path.basename(target)}" is ${media === "image" || media === "audio" ? "an" : "a"} ${media} file, attached to this result. ${how}`
      return {
        output: note,
        title: display,
        metadata: { path: display, preview: note, truncated: false, loaded: [] },
        // By path, as a user's attachment is: what it is and what it weighs are settled when the request is built.
        attachments: [{ path: target, mime: "", data: "", byPath: true }],
      }
    }

    if (isBinary(target, await sampleOf(target, stat.size))) throw new ToolError(`Cannot read binary file: ${display}`)

    const loaded = await instructionsFor(context, target)
    const { raw, count, cut, more } = await linesOf(target, offset, limit)
    if (count < offset && !(count === 0 && offset === 1)) {
      throw new ToolError(`Offset ${offset} is past the end of ${display}, which has ${count} lines`)
    }
    const last = offset + raw.length - 1
    let output = `<path>${target}</path>\n<type>file</type>\n<content>\n${raw.map((line, index) => `${index + offset}: ${line}`).join("\n")}`
    if (cut) output += `\n\n(Stopped at ${MAX_BYTES / 1024} KB, after lines ${offset}-${last}. Read again with offset=${last + 1} to continue.)`
    else if (more) output += `\n\n(Lines ${offset}-${last} of ${count}. Read again with offset=${last + 1} to continue.)`
    else output += `\n\n(End of file - ${count} lines in all)`
    output += "\n</content>"
    if (loaded.length) {
      output += `\n\n<system-reminder>\n${loaded.map((item) => `Instructions from ${item.file}:\n${item.content}`).join("\n\n")}\n</system-reminder>`
    }

    return {
      output,
      title: display,
      metadata: {
        path: display,
        lines: count,
        preview: raw.slice(0, PREVIEW_LINES).join("\n"),
        truncated: cut || more,
        loaded: loaded.map((item) => item.file),
      },
    }
  },
}

/*
 * The reference's `ReadTool.miss`: a path that is not there is answered with
 * up to three names from the same directory that contain the requested name
 * or are contained by it, compared without case. So `net` is answered with
 * `net.c` and `net.o`, and `Config.ts` with `config.ts` - but `net.h` beside
 * only `net.c` gets nothing, because neither name contains the other. That
 * is the reference's rule as it stands, kept as it stands.
 */
/**
 * Which of MiMo's two answers a failed stat is.
 *
 * Its file reader keeps `noent` and `denied` apart, each from its own
 * try/catch. Everything here used to collapse into "not found", so a
 * protected folder or a file owned by someone else was reported as absent -
 * and the model's reasonable next move was to create it.
 */
export function statFailure(code: string | undefined): "missing" | "denied" {
  return code === "EACCES" || code === "EPERM" ? "denied" : "missing"
}

/**
 * What the model reads for a file it is not allowed to open.
 *
 * Said as a refusal rather than as an absence, and without the near-name
 * suggestions: the file is there, so offering other spellings of its name
 * would only send the model looking for a file that does not exist.
 */
function denied(display: string): string {
  return `Permission denied: ${display} exists but this app is not allowed to read it. Ask the user to grant access, or work from a file it can read.`
}

async function missing(root: string, target: string, display: string): Promise<string> {
  const dir = path.dirname(target)
  const base = path.basename(target).toLowerCase()
  const entries = await fs.readdir(dir).catch(() => [] as string[])
  const near = entries
    .filter((name) => name.toLowerCase().includes(base) || base.includes(name.toLowerCase()))
    .slice(0, 3)
    .map((name) => relative(root, path.join(dir, name)))
  if (near.length === 0) return `File not found: ${display}`
  return `File not found: ${display}\nDid you mean one of these?\n${near.join("\n")}`
}
