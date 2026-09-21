import fs from "node:fs/promises"
import { existsSync } from "node:fs"
import path from "node:path"
import { spawn } from "node:child_process"
import { StringDecoder } from "node:string_decoder"
import type { ToolContext, ToolDefinition } from "./types"
import { ToolError } from "./types"
import { relative, resolvePath } from "./fs-util"
import { SearchStopped, overrideMatcher, walkFiles } from "./ignore"

/** MiMo lists at most 100 files for a glob and 100 matches for a grep. */
const LIMIT = 100
const MAX_LINE_LENGTH = 2000

/*
 * glob and grep run the ripgrep the app ships, as MiMo's do: its regular
 * expressions (Rust syntax: `(?i)`, `[[:space:]]`, Unicode `\w`), its file
 * reading (UTF-16 with a byte-order mark is searched, a binary file found on
 * the way is skipped, one named outright is not) and its reading of `--glob`,
 * which outranks .gitignore. The main process names the binary in
 * MCODE_RIPGREP_PATH. Where there is none - the checks, which run the backend
 * under plain node - the walk in ignore.ts stands in for it, keeping the same
 * rules as far as JavaScript allows.
 *
 * Two things MiMo's own wrapper gets wrong are not copied: a matched line keeps
 * no trailing line break, and a line that is not UTF-8 (ripgrep hands it over
 * as bytes) is decoded with replacement characters instead of failing the call.
 * `.git` is left out at every depth, not only at the top.
 */

/** The bundled ripgrep, when the app has one. */
export function ripgrepBinary(): string | undefined {
  const named = process.env.MCODE_RIPGREP_PATH
  return named && existsSync(named) ? named : undefined
}

/** ripgrep's exclusion of `.git`, last so that no pattern the model gives can bring it back. */
const NO_GIT = "--glob=!.git"

/**
 * One ripgrep run, line by line. `onLine` returns true to stop reading, which
 * ends the process. Settles with the exit code and what it wrote to stderr, or
 * throws `SearchStopped` when the reader stopped the turn.
 */
function runRipgrep(
  binary: string,
  args: string[],
  cwd: string,
  signal: AbortSignal,
  onLine: (line: string) => boolean | void,
): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new SearchStopped())
    const child = spawn(binary, args, { cwd, env: process.env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true })
    const decoder = new StringDecoder("utf8")
    let pending = ""
    let stderr = ""
    let enough = false
    const onAbort = () => child.kill()
    signal.addEventListener("abort", onAbort, { once: true })
    const feed = (text: string) => {
      pending += text
      let cut = pending.indexOf("\n")
      while (cut !== -1 && !enough) {
        const line = pending.slice(0, cut).replace(/\r$/, "")
        pending = pending.slice(cut + 1)
        if (line && onLine(line)) {
          enough = true
          child.kill()
        }
        cut = pending.indexOf("\n")
      }
    }
    child.stdout.on("data", (chunk: Buffer) => {
      if (!enough) feed(decoder.write(chunk))
    })
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < 8000) stderr += chunk.toString("utf8")
    })
    child.on("error", (error) => {
      signal.removeEventListener("abort", onAbort)
      reject(error)
    })
    child.on("close", (code) => {
      signal.removeEventListener("abort", onAbort)
      if (signal.aborted) return reject(new SearchStopped())
      if (!enough) {
        feed(decoder.end())
        if (pending && !enough) onLine(pending)
      }
      resolve({ code: enough ? 0 : code, stderr })
    })
  })
}

/** ripgrep names a path it found relative to where it ran, as `.\src\a.ts`. */
const cleaned = (file: string) => path.normalize(file.replace(/^\.[\\/]/, ""))

async function mtimeOf(file: string): Promise<number | undefined> {
  const stat = await fs.stat(file).catch(() => undefined)
  return stat && !stat.isDirectory() ? stat.mtimeMs : undefined
}

/** MiMo's refusal for a folder to search that is not there, in this app's words. */
function noFolder(folder: string): ToolError {
  return new ToolError(`No such folder: ${folder}. Check the path; nothing was searched.`)
}

/** Turns a stop into the failure the runner records as stopped, rather than a result that looks complete. */
function stopped(error: unknown): never {
  if (error instanceof SearchStopped) throw new ToolError(error.message)
  throw error
}

/** The files a glob matches, in the order they were found, at most `limit`. */
async function globFiles(root: string, pattern: string, limit: number, signal: AbortSignal): Promise<string[]> {
  const found: string[] = []
  const binary = ripgrepBinary()
  if (binary) {
    const { code, stderr } = await runRipgrep(binary, ["--no-config", "--files", "--hidden", `--glob=${pattern}`, NO_GIT, "."], root, signal, (line) => {
      found.push(path.resolve(root, cleaned(line)))
      return found.length >= limit
    })
    if (code !== 0 && code !== 1 && !found.length) throw new ToolError(stderr.trim() || `ripgrep failed with code ${code}`)
    return found
  }
  await walkFiles(
    root,
    (absolute) => {
      found.push(absolute)
      return found.length >= limit
    },
    signal,
    overrideMatcher(pattern),
  )
  return found
}

export const GlobTool: ToolDefinition = {
  name: "glob",
  description: [
    "Find files by name. The pattern is a glob: `*.ts`, `src/**/*.vue`, `*.{js,jsx}`, `**/test/*.py`.",
    "A pattern with no slash in it matches file names at any depth, so `*.ts` finds every TypeScript file under the folder searched; one with a slash is matched against the path from that folder down.",
    "path narrows the search to one folder, the project root when left out. Hidden files are included. A file the pattern names is found even when .gitignore leaves it out, but folders .gitignore leaves out are not looked inside unless the pattern names them too.",
    "Results are absolute paths, most recently changed first, at most 100 - the newest first ordering is what makes it useful for finding what a build or another tool just wrote.",
    "Use it when you know something about the name. When you know something about the contents instead, use grep; to see what one folder holds, read the folder.",
  ].join("\n"),
  permission: "glob",
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Glob to match file names or paths against" },
      path: { type: "string", description: "Folder to search in, the project root when left out" },
    },
    required: ["pattern"],
    additionalProperties: false,
  },
  async execute(input, context) {
    const root = input.path ? await resolvePath(context, String(input.path)) : path.resolve(context.directory)
    const stat = await fs.stat(root).catch(() => undefined)
    if (stat?.isFile()) throw new ToolError(`glob's path has to be a folder: ${root}`)
    if (!stat) throw noFolder(root)

    // As MiMo's: the first 101 files the search finds, so it can say there were more, then the newest first.
    const files = await globFiles(root, String(input.pattern), LIMIT + 1, context.signal).catch(stopped)
    const found = await Promise.all(files.map(async (file) => ({ path: file, mtime: (await mtimeOf(file)) ?? 0 })))
    const truncated = found.length > LIMIT
    if (truncated) found.length = LIMIT
    found.sort((a, b) => b.mtime - a.mtime)

    const output =
      found.length === 0
        ? "No files found"
        : found.map((entry) => entry.path).join("\n") +
          (truncated ? `\n\n(Only the first ${LIMIT} files found are listed. Narrow the path or the pattern to see the rest.)` : "")
    return {
      output,
      title: relative(context.directory, root),
      metadata: { count: found.length, truncated },
    }
  },
}

type Row = { path: string; line: number; text: string }

/** A matched line as the model reads it: no line break, and cut well past what is ever shown. */
function lineText(text: string): string {
  const plain = text.replace(/\r?\n$/, "").replace(/\r$/, "")
  return plain.length > MAX_LINE_LENGTH + 1 ? plain.slice(0, MAX_LINE_LENGTH + 1) : plain
}

async function grepWithRipgrep(binary: string, cwd: string, pattern: string, include: string | undefined, file: string | undefined, signal: AbortSignal) {
  const rows: Row[] = []
  const args = ["--no-config", "--json", "--hidden", "--no-messages", ...(include ? [`--glob=${include}`] : []), NO_GIT, "--", pattern, file ?? "."]
  const { code, stderr } = await runRipgrep(binary, args, cwd, signal, (line) => {
    let item: { type?: string; data?: { path?: { text?: string; bytes?: string }; lines?: { text?: string; bytes?: string }; line_number?: number } }
    try {
      item = JSON.parse(line)
    } catch {
      return
    }
    if (item.type !== "match" || !item.data) return
    const where = item.data.path?.text ?? (item.data.path?.bytes ? Buffer.from(item.data.path.bytes, "base64").toString("utf8") : undefined)
    if (!where || typeof item.data.line_number !== "number") return
    const lines = item.data.lines
    const text = lines?.text ?? (lines?.bytes ? new TextDecoder("utf-8").decode(Buffer.from(lines.bytes, "base64")) : "")
    rows.push({ path: path.resolve(cwd, cleaned(where)), line: item.data.line_number, text: lineText(text) })
  })
  // A pattern ripgrep cannot read is said as ripgrep says it; any other exit 2 means some paths could not be read.
  if (code === 2 && !rows.length && /regex parse error|error parsing/i.test(stderr)) throw new ToolError(`Invalid regular expression: ${stderr.trim()}`)
  if (code !== 0 && code !== 1 && code !== 2) throw new ToolError(stderr.trim() || `ripgrep failed with code ${code}`)
  return { rows: code === 1 ? [] : rows, partial: code === 2 }
}

/*
 * The stand-in's regular expression: JavaScript's, with the spellings a model
 * brings from ripgrep turned into JavaScript's where there is one - leading
 * inline flags, named groups written `(?P<name>`, POSIX classes.
 */
export function fallbackRegex(pattern: string): RegExp {
  let source = pattern.replace(/\(\?P</g, "(?<")
  let flags = "u"
  const inline = /^\(\?([imsx]+)\)/.exec(source)
  if (inline) {
    source = source.slice(inline[0].length)
    for (const flag of inline[1]!) if (flag !== "x" && !flags.includes(flag)) flags += flag
  }
  const posixClasses: Record<string, string> = {
    alpha: "\\p{L}",
    digit: "0-9",
    alnum: "\\p{L}\\p{N}",
    space: "\\s",
    upper: "\\p{Lu}",
    lower: "\\p{Ll}",
    punct: "!-\\/:-@\\[-`{-~",
    xdigit: "0-9A-Fa-f",
    word: "\\w",
  }
  const unicode = source.replace(/\[:(\w+):\]/g, (whole, name: string) => posixClasses[name] ?? whole)
  try {
    return new RegExp(unicode, flags)
  } catch {
    // Some JavaScript that is fine without the u flag is not with it (`\-` outside a class, for one).
    return new RegExp(source, flags.replace("u", ""))
  }
}

/** What a file holds as text, as ripgrep reads it: UTF-16 by its byte-order mark, UTF-8 otherwise. */
function decoded(bytes: Buffer): string {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder("utf-16le").decode(bytes.subarray(2))
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder("utf-16be").decode(bytes.subarray(2))
  return new TextDecoder("utf-8").decode(bytes)
}

/** Files the stand-in reads whole; a larger one is read in slices so a huge log never sits in memory at once. */
const WHOLE_FILE_BYTES = 8 * 1024 * 1024

async function grepWithWalk(target: string, isFile: boolean, pattern: string, include: string | undefined, signal: AbortSignal) {
  let regex: RegExp
  try {
    regex = fallbackRegex(pattern)
  } catch (err) {
    throw new ToolError(`Invalid regular expression: ${(err as Error).message}`)
  }
  const rows: Row[] = []
  let partial = false
  const test = (file: string, lines: string[], from: number) => {
    for (let i = 0; i < lines.length; i++) {
      // Only the line feed ends a line, as in ripgrep: `$` does not match before a carriage return.
      if (regex.test(lines[i]!)) rows.push({ path: file, line: from + i, text: lineText(lines[i]!) })
    }
  }
  const search = async (file: string, named: boolean) => {
    const handle = await fs.open(file, "r").catch(() => undefined)
    if (!handle) {
      partial = true
      return
    }
    try {
      const size = (await handle.stat()).size
      const head = Buffer.alloc(Math.min(size, WHOLE_FILE_BYTES))
      await handle.read(head, 0, head.length, 0)
      const utf16 = (head[0] === 0xff && head[1] === 0xfe) || (head[0] === 0xfe && head[1] === 0xff)
      // A binary file found on the way is skipped; one named outright is still searched.
      if (!named && !utf16 && head.includes(0)) return
      if (size <= WHOLE_FILE_BYTES) {
        const text = decoded(head)
        const lines = text.split("\n")
        if (text.endsWith("\n")) lines.pop()
        test(file, lines, 1)
        return
      }
      let carry = ""
      let lineNo = 1
      let offset = 0
      const slice = Buffer.alloc(WHOLE_FILE_BYTES)
      const decoder = new StringDecoder("utf8")
      for (;;) {
        if (signal.aborted) throw new SearchStopped()
        const { bytesRead } = await handle.read(slice, 0, slice.length, offset)
        if (!bytesRead) break
        offset += bytesRead
        const lines = (carry + decoder.write(slice.subarray(0, bytesRead))).split("\n")
        carry = lines.pop() ?? ""
        test(file, lines, lineNo)
        lineNo += lines.length
      }
      const last = carry + decoder.end()
      if (last) test(file, [last], lineNo)
    } catch (error) {
      if (error instanceof SearchStopped) throw error
      partial = true
    } finally {
      await handle.close()
    }
  }
  if (isFile) await search(target, true)
  else await walkFiles(target, (file) => search(file, false), signal, include ? overrideMatcher(include) : undefined)
  return { rows, partial }
}

export const GrepTool: ToolDefinition = {
  name: "grep",
  description: [
    "Search what is inside files, with a regular expression.",
    "The pattern is ripgrep's regular-expression syntax (Rust), matched line by line: `(?i)` makes it case-insensitive, `\\w` and `\\b` understand Unicode; escape the characters that mean something in it (`\\.`, `\\(`, `\\$`) when you are looking for them literally.",
    "Narrow it with path - a folder to search, or a single file - and with include, a glob naming which files to look in (`*.ts`, `*.{ts,tsx}`). A file include names is searched even when .gitignore leaves it out.",
    "Matches come back as the matching lines grouped under each file, most recently changed files first, at most 100 matches; past that it says so, so a search that hits the cap should be narrowed rather than trusted as complete.",
    "It is faster than running grep or Select-String through bash and does not depend on which tools this machine has. Reach for it to find where something is used, then read that file; use glob when you are matching names rather than contents.",
    "It shows where matches are, not how many: to count them, per file or in all, run ripgrep through bash (`rg --count`, or `rg --count-matches` for every hit on a line) rather than grep. When rg is not on the PATH, the copy MCode ships is at the path in the MCODE_RIPGREP_PATH environment variable.",
  ].join("\n"),
  permission: "grep",
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Regular expression to search for" },
      path: { type: "string", description: "File or folder to search in, the project root when left out" },
      include: { type: "string", description: "Glob naming which files to search, e.g. *.js or *.{ts,tsx}" },
    },
    required: ["pattern"],
    additionalProperties: false,
  },
  async execute(input, context: ToolContext) {
    const pattern = String(input.pattern ?? "")
    if (!pattern) throw new ToolError("pattern is required")
    const target = input.path ? await resolvePath(context, String(input.path)) : path.resolve(context.directory)
    const include = input.include ? String(input.include) : undefined

    // As MiMo's: a folder is searched from itself, anything else from its folder, which has to exist.
    const stat = await fs.stat(target).catch(() => undefined)
    const isDir = Boolean(stat?.isDirectory())
    const cwd = isDir ? target : path.dirname(target)
    if (!(await fs.stat(cwd).then((found) => found.isDirectory(), () => false))) throw noFolder(cwd)

    const binary = ripgrepBinary()
    const { rows, partial } = await (binary
      ? grepWithRipgrep(binary, cwd, pattern, include, isDir ? undefined : path.relative(cwd, target), context.signal)
      : stat
        ? grepWithWalk(target, !isDir, pattern, include, context.signal)
        : Promise.resolve({ rows: [] as Row[], partial: true })
    ).catch(stopped)

    const empty = { output: "No files found", title: pattern, metadata: { matches: 0, truncated: false } }
    if (rows.length === 0) return empty
    const times = new Map<string, number>()
    for (const file of new Set(rows.map((row) => row.path))) {
      const mtime = await mtimeOf(file)
      if (mtime !== undefined) times.set(file, mtime)
    }
    const matches = rows.filter((row) => times.has(row.path)).sort((a, b) => times.get(b.path)! - times.get(a.path)!)
    if (matches.length === 0) return empty

    const total = matches.length
    const truncated = total > LIMIT
    const lines = [`Found ${total} matches${truncated ? ` (showing the first ${LIMIT})` : ""}`]
    let current = ""
    for (const match of matches.slice(0, LIMIT)) {
      if (current !== match.path) {
        if (current) lines.push("")
        current = match.path
        lines.push(`${match.path}:`)
      }
      const text = match.text.length > MAX_LINE_LENGTH ? `${match.text.slice(0, MAX_LINE_LENGTH)}...` : match.text
      lines.push(`  Line ${match.line}: ${text}`)
    }
    if (truncated) lines.push("", `(${LIMIT} of ${total} matches shown. Narrow the path or the pattern to see the rest.)`)
    if (partial) lines.push("", "(Some paths could not be read and were skipped.)")
    return { output: lines.join("\n"), title: pattern, metadata: { matches: total, truncated } }
  },
}
