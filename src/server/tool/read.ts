import fs from "node:fs/promises"
import { createReadStream } from "node:fs"
import { createInterface } from "node:readline"
import path from "node:path"
import type { Message } from "@shared/protocol"
import type { ToolContext, ToolDefinition, ToolResult } from "./types"
import { ToolError } from "./types"
import { relative, resolvePath } from "./fs-util"
import { clearedNote } from "../session/prune"
import { builtinSkillsRoot } from "../skill"
import { shrunkImage } from "../provider/attachment-parts"
import {
  READ_AUDIO_TYPES,
  READ_IMAGE_SOURCE_BYTES,
  READ_IMAGE_TYPES,
  READ_MEDIA_BYTES,
  READ_VIDEO_TYPES,
  looksLikeMedia,
  mediaTypeOf,
} from "./read-media"

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

type ReadMedia = "image" | "PDF" | "audio" | "video"

/** Which of the kinds read attaches a type is, if it is one: MiMo's lists, nothing wider. */
function readMediaOf(mime: string): ReadMedia | undefined {
  if (READ_IMAGE_TYPES.has(mime)) return "image"
  if (mime === "application/pdf") return "PDF"
  if (READ_AUDIO_TYPES.has(mime)) return "audio"
  if (READ_VIDEO_TYPES.has(mime)) return "video"
  return undefined
}

/** Instruction files a folder can hold, the first one present standing for the folder, as MiMo looks for them. */
const INSTRUCTION_FILES = ["AGENTS.md", "CLAUDE.md", "CONTEXT.md"]

/**
 * Instruction files already claimed by a read in one reply, so two reads made
 * in the same step do not both carry the same file. Only the latest replies
 * are remembered; an older one is in the history, where the rest is judged.
 */
const claims = new Map<string, Set<string>>()
const CLAIMS_KEPT = 200

/**
 * The instruction files a history has been given: those listed by completed
 * reads whose result is still sent whole enough to hold them, as MiMo reads
 * them off `metadata.loaded`. A read whose result was cleared to make room no
 * longer carries its instructions, so they are given again.
 */
export function instructionsIn(messages: readonly Message[]): Set<string> {
  const given = new Set<string>()
  const cleared = clearedNote("read")
  for (const message of messages) {
    if (message.role !== "assistant") continue
    for (const part of message.parts) {
      if (part.type !== "tool" || part.name !== "read" || part.status !== "completed" || part.output === cleared) continue
      const loaded = part.metadata?.loaded
      if (Array.isArray(loaded)) for (const file of loaded) if (typeof file === "string") given.add(file)
    }
  }
  return given
}

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

type Loaded = readonly { file: string; content: string }[]

/**
 * The instruction files between a file's folder and the project root, as MiMo
 * adds them when a file is read: the project root's own are already in the
 * system prompt, the file being read is not its own instruction, and a file
 * the conversation was given in a result it still sends is not given again.
 */
async function instructionsFor(context: ToolContext, target: string): Promise<{ file: string; content: string }[]> {
  const root = path.resolve(context.directory)
  const given = (await context.instructionsGiven?.().catch(() => undefined)) ?? new Set<string>()
  let claimed = claims.get(context.messageID)
  if (!claimed) {
    claimed = new Set()
    claims.set(context.messageID, claimed)
    for (const key of claims.keys()) {
      if (claims.size <= CLAIMS_KEPT) break
      claims.delete(key)
    }
  }
  const found: { file: string; content: string }[] = []
  // Below the root by path, not by spelling: `D:\a` is not above `D:\ab`.
  const below = (folder: string) => {
    const rel = path.relative(root, folder)
    return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel)
  }
  for (let current = path.dirname(path.resolve(target)); below(current); current = path.dirname(current)) {
    for (const name of INSTRUCTION_FILES) {
      const file = path.join(current, name)
      if (!(await fs.stat(file).then((stat) => stat.isFile(), () => false))) continue
      if (file !== path.resolve(target) && !given.has(file) && !claimed.has(file)) {
        claimed.add(file)
        const content = (await fs.readFile(file, "utf8").catch(() => "")).trim()
        if (content) found.push({ file, content })
      }
      break
    }
  }
  return found
}

/** The instructions a read carries, after what it read. */
function withInstructions(output: string, loaded: Loaded): string {
  if (!loaded.length) return output
  return `${output}\n\n<system-reminder>\n${loaded.map((item) => `Instructions from ${item.file}:\n${item.content}`).join("\n\n")}\n</system-reminder>`
}

/** A read that attaches nothing and says why, with the instructions it found. */
function noteResult(display: string, note: string, loaded: Loaded): ToolResult {
  return {
    output: withInstructions(note, loaded),
    title: display,
    metadata: { path: display, preview: note, truncated: false, loaded: loaded.map((item) => item.file) },
  }
}

const megabytes = (bytes: number) => `${Math.round((bytes / 1024 / 1024) * 10) / 10} MB`

/**
 * A picture, PDF, recording or video, as MiMo's read handles one: refused
 * with a way forward when the model cannot take it or it is too large, and
 * otherwise attached - from a copy taken now, so the result keeps showing what
 * the model was shown whatever happens to the file.
 */
async function readMedia(context: ToolContext, target: string, display: string, media: ReadMedia, mime: string, size: number, loaded: Loaded): Promise<ToolResult> {
  const label = `"${path.basename(target)}" (${mime})`
  const shrink = media === "image" && size > READ_MEDIA_BYTES
  if (media === "image" || media === "PDF") {
    const ceiling = media === "image" ? READ_IMAGE_SOURCE_BYTES : READ_MEDIA_BYTES
    if (size > ceiling) {
      return noteResult(display, `${label} is ${megabytes(size)}, more than read takes for ${media === "image" ? "a picture" : "a PDF"} (${megabytes(ceiling)}). It was not read.`, loaded)
    }
  } else if (Math.ceil(size / 3) * 4 > READ_MEDIA_BYTES) {
    return noteResult(display, `${label} is ${megabytes(size)}, more than the ${megabytes(READ_MEDIA_BYTES)} ${media === "audio" ? "a recording" : "a video"} may take once encoded for the model. It was not read.`, loaded)
  }

  const model = await context.model?.().catch(() => undefined)
  if (model) {
    if (media === "image" && !model.inputs.image) {
      const helper = model.vision
        ? `start a subagent that can see: call actor with action "run", subagent_type "general", model "${model.vision}" and a prompt asking it to look at ${target} (actor's "models" action with vision true lists the other models that can)`
        : "no connected model reads pictures - ask the user to connect one, or use an OCR tool from the shell"
      return noteResult(
        display,
        [
          `The model in this conversation cannot see pictures, so ${label} was not attached.`,
          `To learn what it shows, ${helper}.`,
          "For its raw bytes, use a hex dump in the shell (Format-Hex on Windows, xxd elsewhere) rather than read.",
        ].join("\n"),
        loaded,
      )
    }
    if (media === "PDF" && !model.inputs.pdf) {
      const skills = builtinSkillsRoot()
      const where = skills ? ` (${path.join(skills, "pdf", "SKILL.md")})` : ""
      return noteResult(
        display,
        [
          `The model in this conversation cannot take PDF files, so ${label} was not attached.`,
          `To work with what is in it, load the built-in pdf skill with the skill tool${where} and follow it: it pulls out the text, or turns pages into pictures.`,
        ].join("\n"),
        loaded,
      )
    }
    if ((media === "audio" || media === "video") && !model.inputs[media]) {
      return noteResult(
        display,
        [
          `The model in this conversation cannot take ${media}, so ${label} was not attached.`,
          `Ask the user to switch to a model that takes ${media}, or look at the file's details from the shell (ffprobe) instead.`,
        ].join("\n"),
        loaded,
      )
    }
  }

  let bytes = await fs.readFile(target)
  let sent = mime
  if (shrink) {
    const smaller = await shrunkImage({ mime, data: bytes.toString("base64") }, { maxBytes: READ_MEDIA_BYTES, maxPixels: 8000 })
    if (!smaller) {
      return noteResult(display, `${label} is ${megabytes(size)}, more than the ${megabytes(READ_MEDIA_BYTES)} read attaches, and it could not be made smaller. It was not attached.`, loaded)
    }
    bytes = Buffer.from(smaller.data, "base64")
    sent = smaller.mime
  }
  const copy = context.keepCopy ? await context.keepCopy(target, bytes) : undefined
  const verb = media === "image" ? "look at" : media === "PDF" ? "read" : media === "audio" ? "listen to" : "watch"
  const note = shrink
    ? `${label} is attached to this result, made smaller to fit (${megabytes(size)} down to ${megabytes(bytes.length)}, as ${sent}).`
    : `${label} is attached to this result for you to ${verb}.`
  return {
    output: withInstructions(note, loaded),
    title: display,
    metadata: { path: display, preview: note, truncated: false, loaded: loaded.map((item) => item.file) },
    attachments: [{ path: target, mime: sent, data: "", byPath: true, ...(copy ? { copy } : {}) }],
  }
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
  description: [
    "Read a file, or list a folder, from this machine.",
    "",
    "A file comes back as numbered lines, each written `N: text`. The number and the colon are not part of the file: what follows the prefix is the line, and that is what edit expects you to quote back. A line longer than about 2,000 characters is cut, so do not treat a read as proof of a long line's exact tail.",
    "",
    "Long files are read in parts. offset is the line to start at, counting from 1, and limit is how many lines to return; without them you get the start of the file. A read that stops early says where to continue from.",
    "",
    "How to use it well",
    "- Looking for one thing in a large file, or in a file whose lines run very long, is a job for grep: it finds the lines without reading everything around them.",
    "- When you are not sure of a path, find it with glob first rather than guessing at names until one reads.",
    "- Read a generous window rather than a series of 30-line slices of the same file: each call costs a round trip, and the small ones rarely tell you enough to act.",
    "- When you already know you need several files, read them in one step rather than one after another.",
    "- Prefer it to `cat`, `head` or `type` through bash; the numbered output is what the edit tool matches against.",
    "- A path that does not exist comes back as an error rather than an empty file, so a read that succeeds is evidence the file is there.",
    "",
    "Images and PDFs come back as attachments the model can look at directly, where the model reads that kind of file; pointed at a folder, it lists what is in it instead.",
  ].join("\n"),
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
        /*
         * No `truncated` here, deliberately, and for the reason glob and grep
         * withhold it: the runner reads that field as "this tool caps its own
         * output" and skips the shared byte cap entirely. A listing slices by
         * entry count only, and the count comes from the model, so
         * `limit: 1000000` over a node_modules tree went into the request whole
         * (R25-B4). The footer already says there is more.
         */
        metadata: { path: display || ".", preview: shown.slice(0, PREVIEW_LINES).join("\n"), loaded: [] },
      }
    }

    /*
     * What the file is, by its first bytes and then its name, as MiMo decides
     * it: a picture named .png that holds a JPEG goes as a JPEG, and a picture
     * with no extension at all is still a picture.
     */
    const sample = await sampleOf(target, stat.size)
    const mime = mediaTypeOf(target, sample)
    const media = mime ? readMediaOf(mime) : undefined
    if (mime && media) return readMedia(context, target, display, media, mime, stat.size, await instructionsFor(context, target))
    if (mime && looksLikeMedia(mime) && isBinary(target, sample)) {
      const kind = mime.startsWith("audio/") ? "audio" : mime.startsWith("video/") ? "video" : mime === "application/pdf" ? "PDF" : "image"
      const takes = kind === "audio" ? "WAV and MP3" : kind === "video" ? "MP4" : kind === "PDF" ? "PDF" : "PNG, JPEG, WebP and GIF"
      const into = kind === "audio" ? "wav" : kind === "video" ? "mp4" : kind === "PDF" ? "pdf" : "png"
      return noteResult(
        display,
        [
          `"${path.basename(target)}" is ${kind === "image" || kind === "audio" ? "an" : "a"} ${kind} file in a format read does not attach (${mime}); read takes ${takes}. It was not read.`,
          `Convert it first - for example ffmpeg -i "${target}" converted.${into}, written outside the project when it is only for this - and read the converted file.`,
        ].join("\n"),
        await instructionsFor(context, target),
      )
    }

    if (isBinary(target, sample)) throw new ToolError(`Cannot read binary file: ${display}`)

    const { raw, count, cut, more } = await linesOf(target, offset, limit)
    if (count < offset && !(count === 0 && offset === 1)) {
      throw new ToolError(`Offset ${offset} is past the end of ${display}, which has ${count} lines`)
    }
    // Only once the offset is known to be good, so a read that fails claims no instructions it never delivered.
    const loaded = await instructionsFor(context, target)
    const last = offset + raw.length - 1
    let output = `<path>${target}</path>\n<type>file</type>\n<content>\n${raw.map((line, index) => `${index + offset}: ${line}`).join("\n")}`
    if (cut) output += `\n\n(Stopped at ${MAX_BYTES / 1024} KB, after lines ${offset}-${last}. Read again with offset=${last + 1} to continue.)`
    else if (more) output += `\n\n(Lines ${offset}-${last} of ${count}. Read again with offset=${last + 1} to continue.)`
    else output += `\n\n(End of file - ${count} lines in all)`
    output += "\n</content>"
    output = withInstructions(output, loaded)

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
