import fs from "node:fs/promises"
import path from "node:path"
import { StringDecoder } from "node:string_decoder"
import { SearchStopped, overrideMatcher, walkFiles } from "./ignore"
import { ToolError } from "./types"

/*
 * The part of grep and glob that runs without ripgrep, over the JS walk.
 *
 * Split out from the tools themselves so it can run either in this thread or in
 * a worker: the regular expressions here come from the model, and a pattern
 * like `(a+)+$` backtracks for longer than anyone will wait. Nothing in
 * JavaScript can interrupt a regex mid-match - not an abort signal, not a
 * timer, because both need the event loop the match is holding - so the only
 * way to bound one is to run it somewhere that can be terminated. See
 * search-run.ts.
 */

/** MiMo lists at most 100 files for a glob and 100 matches for a grep. */
export const LIMIT = 100
export const MAX_LINE_LENGTH = 2000

export type Row = { path: string; line: number; text: string }

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

/** A matched line as the model reads it: no line break, and cut well past what is ever shown. */
export function lineText(text: string): string {
  const plain = text.replace(/\r?\n$/, "").replace(/\r$/, "")
  return plain.length > MAX_LINE_LENGTH + 1 ? plain.slice(0, MAX_LINE_LENGTH + 1) : plain
}

export async function mtimeOf(file: string): Promise<number | undefined> {
  const stat = await fs.stat(file).catch(() => undefined)
  return stat && !stat.isDirectory() ? stat.mtimeMs : undefined
}

/**
 * The matches as the tool shows them: files that are gone dropped, the most
 * recently changed file first (rows keep their order within a file), the total
 * counted, and only the first LIMIT kept. Done where the rows were found, so a
 * broad pattern does not carry every match across the thread boundary just for
 * the tool to cut it to a hundred.
 */
export async function rankMatches(rows: Row[]): Promise<{ rows: Row[]; total: number }> {
  const times = new Map<string, number>()
  for (const file of new Set(rows.map((row) => row.path))) {
    const mtime = await mtimeOf(file)
    if (mtime !== undefined) times.set(file, mtime)
  }
  const matches = rows.filter((row) => times.has(row.path)).sort((a, b) => times.get(b.path)! - times.get(a.path)!)
  return { rows: matches.slice(0, LIMIT), total: matches.length }
}

/** Files the stand-in reads whole; a larger one is read in slices so a huge log never sits in memory at once. */
const WHOLE_FILE_BYTES = 8 * 1024 * 1024

async function grepWithWalk(target: string, isFile: boolean, pattern: string, include: string | undefined, signal: AbortSignal, deadline?: number): Promise<GrepOutcome> {
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
  let timedOut = false
  if (isFile) await search(target, true)
  else
    await walkFiles(
      target,
      async (file) => {
        // Out of time before this file: stop with what there is, and say so.
        if (deadline !== undefined && Date.now() >= deadline) {
          timedOut = true
          return true
        }
        await search(file, false)
      },
      signal,
      include ? overrideMatcher(include) : undefined,
    )
  return { ...(await rankMatches(rows)), partial, ...(timedOut ? { timedOut } : {}) }
}

/** The files a glob matches through the JS walk, in the order they were found, at most `limit`. */
async function globWithWalk(root: string, pattern: string, limit: number, signal: AbortSignal, deadline?: number): Promise<GlobOutcome> {
  const found: string[] = []
  let timedOut = false
  await walkFiles(
    root,
    (absolute) => {
      if (deadline !== undefined && Date.now() >= deadline) {
        timedOut = true
        return true
      }
      found.push(absolute)
      return found.length >= limit
    },
    signal,
    overrideMatcher(pattern),
  )
  return { paths: found, ...(timedOut ? { timedOut } : {}) }
}

export interface GrepJob {
  kind: "grep"
  target: string
  isFile: boolean
  pattern: string
  include?: string
  /** When to stop walking and answer with what was found (epoch ms); the hard kill is the main thread's. */
  deadline?: number
}

export interface GlobJob {
  kind: "glob"
  root: string
  pattern: string
  limit: number
  deadline?: number
}

export type FallbackJob = GrepJob | GlobJob

export interface GrepOutcome {
  /** The first LIMIT matches, newest file first. */
  rows: Row[]
  /** How many matched in all. */
  total: number
  partial: boolean
  /** The search ran out of time before covering every file. */
  timedOut?: boolean
}

export interface GlobOutcome {
  paths: string[]
  timedOut?: boolean
}

export function runFallbackJob(job: GrepJob, signal: AbortSignal): Promise<GrepOutcome>
export function runFallbackJob(job: GlobJob, signal: AbortSignal): Promise<GlobOutcome>
export function runFallbackJob(job: FallbackJob, signal: AbortSignal): Promise<GrepOutcome | GlobOutcome>
export async function runFallbackJob(job: FallbackJob, signal: AbortSignal): Promise<GrepOutcome | GlobOutcome> {
  return job.kind === "grep" ? grepWithWalk(job.target, job.isFile, job.pattern, job.include, signal, job.deadline) : globWithWalk(job.root, job.pattern, job.limit, signal, job.deadline)
}