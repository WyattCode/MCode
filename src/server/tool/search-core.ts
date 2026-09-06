import fs from "node:fs/promises"
import path from "node:path"
import { IGNORED } from "./fs-util"

/**
 * The part of searching that is pure computation over the filesystem.
 *
 * Split out from the tools themselves so it can run either in this thread or in
 * a worker: the regexes here come from the model, and a pattern like `(a+)+$`
 * backtracks for longer than anyone will wait. Nothing in JavaScript can
 * interrupt a regex mid-match, so the only way to bound it is to run it
 * somewhere that can be terminated - see search-worker.ts.
 */

export const MAX_RESULTS = 200
export const MAX_FILE_BYTES = 2_000_000

/** Translates a glob into a regex. Supports *, **, ?, and {a,b} alternation. */
export function globToRegExp(pattern: string): RegExp {
  let out = ""
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i]
    if (char === "*") {
      if (pattern[i + 1] === "*") {
        // ** spans directory separators; **/ also matches zero directories.
        i++
        if (pattern[i + 1] === "/") {
          i++
          out += "(?:.*/)?"
        } else {
          out += ".*"
        }
      } else {
        out += "[^/]*"
      }
    } else if (char === "?") out += "[^/]"
    else if (char === "{") {
      const close = pattern.indexOf("}", i)
      if (close === -1) out += "\\{"
      else {
        const options = pattern.slice(i + 1, close).split(",")
        out += `(?:${options.map((option) => option.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`
        i = close
      }
    } else out += char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  }
  return new RegExp(`^${out}$`)
}

async function walk(
  root: string,
  onFile: (absolute: string) => void | Promise<void>,
  signal?: AbortSignal,
): Promise<void> {
  const queue = [root]
  while (queue.length) {
    // Only ever set on the in-process path: a worker is stopped by being
    // terminated, which is the only thing that stops a regex mid-match.
    if (signal?.aborted) return
    const dir = queue.shift()!
    let entries
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".") && entry.name !== ".env.example") {
        if (entry.isDirectory()) continue
      }
      const absolute = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (IGNORED.has(entry.name)) continue
        queue.push(absolute)
      } else if (entry.isFile()) {
        await onFile(absolute)
      }
    }
  }
}

/** Paths are reported relative to the project, the way every tool speaks them. */
function toRelative(directory: string, target: string): string {
  return path.relative(path.resolve(directory), path.resolve(target)).split(path.sep).join("/")
}

export interface GrepJob {
  kind: "grep"
  root: string
  directory: string
  pattern: string
  ignoreCase: boolean
  include?: string
}

export interface GlobJob {
  kind: "glob"
  root: string
  directory: string
  pattern: string
}

export type SearchJob = GrepJob | GlobJob

export interface GrepResult {
  matches: { path: string; line: number; text: string }[]
  files: number
}

export interface GlobResult {
  found: { path: string; mtime: number }[]
}

export async function runGrep(job: GrepJob, signal?: AbortSignal): Promise<GrepResult> {
  const regex = new RegExp(job.pattern, job.ignoreCase ? "i" : "")
  const include = job.include ? globToRegExp(job.include) : undefined

  const matches: GrepResult["matches"] = []
  let files = 0

  await walk(
    job.root,
    async (absolute) => {
      if (matches.length >= MAX_RESULTS) return
      const rel = toRelative(job.directory, absolute)
      if (include && !include.test(rel)) return
      const stat = await fs.stat(absolute).catch(() => undefined)
      if (!stat || stat.size > MAX_FILE_BYTES) return
      const content = await fs.readFile(absolute, "utf8").catch(() => undefined)
      if (content === undefined || content.includes("\0")) return
      files++
      const lines = content.split("\n")
      for (let i = 0; i < lines.length && matches.length < MAX_RESULTS; i++) {
        if (regex.test(lines[i])) {
          matches.push({ path: rel, line: i + 1, text: lines[i].slice(0, 400) })
        }
      }
    },
    signal,
  )

  return { matches, files }
}

export async function runGlob(job: GlobJob, signal?: AbortSignal): Promise<GlobResult> {
  const regex = globToRegExp(job.pattern)
  const found: GlobResult["found"] = []

  await walk(
    job.root,
    async (absolute) => {
      const rel = toRelative(job.directory, absolute)
      if (!regex.test(rel)) return
      const stat = await fs.stat(absolute).catch(() => undefined)
      found.push({ path: rel, mtime: stat?.mtimeMs ?? 0 })
    },
    signal,
  )

  found.sort((a, b) => b.mtime - a.mtime)
  return { found }
}

export async function runJob(job: SearchJob, signal?: AbortSignal): Promise<GrepResult | GlobResult> {
  return job.kind === "grep" ? runGrep(job, signal) : runGlob(job, signal)
}
