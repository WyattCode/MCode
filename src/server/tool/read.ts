import fs from "node:fs/promises"
import path from "node:path"
import type { ToolDefinition } from "./types"
import { ToolError } from "./types"
import { relative, resolvePath } from "./fs-util"

const MAX_LINES = 2000
const MAX_LINE_LENGTH = 2000

/** Files the model gains nothing from reading as text. */
const BINARY = /\.(png|jpe?g|gif|webp|ico|bmp|tiff|pdf|zip|gz|tar|7z|rar|exe|dll|so|dylib|woff2?|ttf|eot|mp[34]|mov|avi|wasm|class|jar|bin)$/i

function count(value: unknown, fallback: number, name: string): number {
  if (value === undefined || value === null) return fallback
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) throw new ToolError(`${name} must be a number, got ${JSON.stringify(value)}`)
  return parsed
}

export const ReadTool: ToolDefinition = {
  name: "read",
  description:
    "Read a file from the project. Returns the contents with 1-based line numbers, which is the form the edit tool expects you to quote back. Use offset and limit for files too large to read at once.",
  permission: "read",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path, absolute or relative to the project root" },
      offset: { type: "number", description: "1-based line to start from" },
      limit: { type: "number", description: "Maximum number of lines to return" },
    },
    required: ["path"],
    additionalProperties: false,
  },
  async execute(input, context) {
    const target = await resolvePath(context, String(input.path))
    const display = relative(context.directory, target)

    if (BINARY.test(target)) throw new ToolError(`${display} is a binary file and cannot be read as text`)

    let stat
    try {
      stat = await fs.stat(target)
    } catch {
      throw new ToolError(await missing(context.directory, target, display))
    }
    if (stat.isDirectory()) throw new ToolError(`${display} is a directory - use the list tool instead`)

    const raw = await fs.readFile(target, "utf8")
    const lines = raw.split("\n")
    // Number("x") is NaN, Math.max(1, NaN) is NaN, and slice(NaN) reads from the
    // start - so a malformed offset used to return the whole file as if it had
    // been asked for.
    const offset = Math.max(1, Math.trunc(count(input.offset, 1, "offset")))
    const limit = Math.max(1, Math.trunc(count(input.limit, MAX_LINES, "limit")))
    const slice = lines.slice(offset - 1, offset - 1 + limit)

    const numbered = slice
      .map((line, index) => {
        const clipped = line.length > MAX_LINE_LENGTH ? line.slice(0, MAX_LINE_LENGTH) + "..." : line
        return `${String(offset + index).padStart(5)}\t${clipped}`
      })
      .join("\n")

    const remaining = lines.length - (offset - 1 + slice.length)
    const footer = remaining > 0 ? `\n\n(${remaining} more lines - re-read with offset ${offset + slice.length})` : ""

    return {
      output: numbered + footer || "(empty file)",
      title: display,
      metadata: { path: display, lines: lines.length, shown: slice.length },
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
