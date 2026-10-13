import fs from "node:fs/promises"
import path from "node:path"
import type { ToolContext, ToolDefinition } from "./types"
import { ToolError } from "./types"
import { relative, resolvePath } from "./fs-util"
import { changed, unifiedDiff } from "../diff"
import { isMemoryPath } from "../history/service"
import { guardPlanWrite } from "../session/plan"
import { checkFresh, recordWrite } from "./read-tracker"
import { postEditCheckDetailed } from "./post-edit-check"
import type { PostEditCheckResult } from "./post-edit-check"
import {
  concreteStepFromPostEdit,
  formatStuckSuggestion,
  formatVerifyLoopNote,
  getVerifyLoopRound,
  incrementVerifyLoop,
  resetVerifyLoop,
  verifyLoopMax,
} from "../session/verify-loop"

/** The longest closest-match hint a failed edit carries. */
const HINT_MAX_CHARS = 2000

/** Edits to one file wait for each other, as MiMo's engine holds a lock per file. */
const locks = new Map<string, Promise<unknown>>()

export async function locked<T>(file: string, work: () => Promise<T>): Promise<T> {
  const key = process.platform === "win32" ? path.resolve(file).toLowerCase() : path.resolve(file)
  const before = locks.get(key) ?? Promise.resolve()
  const run = before.then(work)
  const held = run.catch(() => undefined)
  locks.set(key, held)
  try {
    return await run
  } finally {
    if (locks.get(key) === held) locks.delete(key)
  }
}

/** Blocks whose lines match once each side is trimmed. */
function* lineTrimmed(content: string, find: string): Generator<string> {
  const lines = content.split("\n")
  const wanted = find.split("\n")
  if (wanted[wanted.length - 1] === "") wanted.pop()
  for (let i = 0; i + wanted.length <= lines.length; i++) {
    if (!wanted.every((line, j) => lines[i + j].trim() === line.trim())) continue
    yield lines.slice(i, i + wanted.length).join("\n")
  }
}

/** Lines, or blocks of lines, that match once runs of whitespace count as one space. */
function* whitespaceNormalized(content: string, find: string): Generator<string> {
  const normal = (text: string) => text.replace(/\s+/g, " ").trim()
  const target = normal(find)
  if (!target) return
  const lines = content.split("\n")
  const size = find.split("\n").length
  for (let i = 0; i + size <= lines.length; i++) {
    const block = lines.slice(i, i + size).join("\n")
    if (normal(block) === target) yield block
  }
}

const trimmedLines = (text: string) => {
  const lines = text.split("\n").map((line) => line.trim())
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop()
  return lines
}

/**
 * Blocks that start and end on the quoted first and last lines, whatever came
 * between: the one whose middle agrees most with the quote, when there are several.
 */
function* blockAnchor(content: string, find: string): Generator<string> {
  const wanted = trimmedLines(find)
  if (wanted.length < 3) return
  const lines = content.split("\n")
  const first = wanted[0]!
  const last = wanted[wanted.length - 1]!
  const middle = wanted.slice(1, -1)
  const candidates: { block: string; score: number }[] = []
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.trim() !== first) continue
    for (let j = i + 2; j < lines.length; j++) {
      if (lines[j]!.trim() !== last) continue
      const between = lines.slice(i + 1, j).map((line) => line.trim())
      const shared = middle.filter((line) => between.includes(line)).length
      candidates.push({ block: lines.slice(i, j + 1).join("\n"), score: middle.length ? shared / Math.max(middle.length, between.length) : 1 })
      break
    }
  }
  if (candidates.length === 1) yield candidates[0]!.block
  else {
    const best = candidates.sort((a, b) => b.score - a.score)[0]
    if (best && best.score >= 0.3) yield best.block
  }
}

/** Blocks that match once each side's common indentation is taken off. */
function* indentationFlexible(content: string, find: string): Generator<string> {
  const outdent = (text: string) => {
    const lines = text.split("\n")
    const depth = Math.min(...lines.filter((line) => line.trim()).map((line) => /^[ \t]*/.exec(line)![0].length))
    return lines.map((line) => (line.trim() ? line.slice(Number.isFinite(depth) ? depth : 0) : "")).join("\n")
  }
  const wanted = find.replace(/\n$/, "")
  const target = outdent(wanted)
  const lines = content.split("\n")
  const size = wanted.split("\n").length
  for (let i = 0; i + size <= lines.length; i++) {
    const block = lines.slice(i, i + size).join("\n")
    if (outdent(block) === target) yield block
  }
}

/** The quote without the blank space around it. */
function* trimmedBoundary(content: string, find: string): Generator<string> {
  const trimmed = find.trim()
  if (!trimmed || trimmed === find) return
  if (content.includes(trimmed)) yield trimmed
  const lines = content.split("\n")
  const size = find.split("\n").length
  for (let i = 0; i + size <= lines.length; i++) {
    const block = lines.slice(i, i + size).join("\n")
    if (block.trim() === trimmed) yield block
  }
}

const UNESCAPED: Record<string, string> = { n: "\n", t: "\t", r: "\r", "\n": "\n" }

/** The quote with the escapes a model writes when it means the characters (`\n`, `\t`, `\"`) read as those characters. */
function* escapeNormalized(content: string, find: string): Generator<string> {
  const plain = find.replace(/\\(n|t|r|'|"|`|\\|\n|\$)/g, (_, char: string) => UNESCAPED[char] ?? char)
  if (plain !== find && content.includes(plain)) yield plain
}

/** Blocks of the quote's length anchored on its first and last lines, with at least half the lines between agreeing. */
function* contextAware(content: string, find: string): Generator<string> {
  const wanted = trimmedLines(find)
  if (wanted.length < 3) return
  const lines = content.split("\n")
  for (let i = 0; i + wanted.length <= lines.length; i++) {
    const block = lines.slice(i, i + wanted.length)
    if (block[0]!.trim() !== wanted[0] || block[block.length - 1]!.trim() !== wanted[wanted.length - 1]) continue
    const middle = wanted.slice(1, -1).map((line, at) => [line, block[at + 1]!.trim()] as const).filter(([line]) => line)
    const agreeing = middle.filter(([line, found]) => line === found).length
    if (!middle.length || agreeing / middle.length >= 0.5) yield block.join("\n")
  }
}

/**
 * The text in the file an edit most likely meant, for the error that says it
 * was not found - MiMo points the model at it so the retry quotes the file as
 * it is. Only the hint is loose; the replacement itself stays exact. The
 * matchers are tried in MiMo's order.
 */
export function closestMatch(content: string, find: string): string | undefined {
  for (const matcher of [lineTrimmed, blockAnchor, indentationFlexible, whitespaceNormalized, trimmedBoundary, escapeNormalized, contextAware]) {
    for (const match of matcher(content, find)) {
      if (match && match !== find && content.includes(match)) return match
    }
  }
  return undefined
}

/** The file's own line endings win: text quoted with \n still lands as \r\n in a CRLF file. */
function endingOf(text: string): "\r\n" | "\n" {
  return text.includes("\r\n") ? "\r\n" : "\n"
}

/** Both \r\n and a lone \n: no single rule describes this file's endings, so no fuzzy tier is trusted. */
function mixedEndings(text: string): boolean {
  return text.includes("\r\n") && /(^|[^\r])\n/.test(text)
}

interface Change {
  oldString: string
  newString: string
  replaceAll: boolean
}

type MatchTier = "trailing-whitespace" | "trim" | "unicode" | "normalize" | "indentation"

interface MatchRange {
  start: number
  end: number
}

interface ReplaceResult {
  updated: string
  occurrences: number
  matchTier?: MatchTier
  ranges?: MatchRange[]
  reindented?: boolean
}

const TIER_LABEL: Record<MatchTier, string> = {
  "trailing-whitespace": "trailing whitespace",
  trim: "leading and trailing whitespace",
  unicode: "typographic quotes and unicode spaces",
  normalize: "typographic quotes, unicode spaces and surrounding whitespace",
  indentation: "indentation differences",
}

function stripCR(line: string): string {
  return line.endsWith("\r") ? line.slice(0, -1) : line
}

function quoteLines(text: string): string[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n")
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop()
  return lines
}

function normalizeUnicodeLine(line: string): string {
  return line
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
    .replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, "-")
    .replace(/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g, " ")
    .replace(/\u2026/g, "...")
}

function normalizeTrimmedLine(line: string): string {
  return normalizeUnicodeLine(line).trim()
}

function commonIndent(lines: string[]): string {
  const indents = lines.filter((line) => line.trim()).map((line) => /^[ \t]*/.exec(line)?.[0] ?? "")
  if (!indents.length) return ""
  let prefix = indents[0]!
  for (const indent of indents.slice(1)) {
    let i = 0
    while (i < prefix.length && i < indent.length && prefix[i] === indent[i]) i++
    prefix = prefix.slice(0, i)
    if (!prefix) break
  }
  return prefix
}

function removeIndent(line: string, indent: string): string {
  if (!line.trim()) return ""
  if (indent && line.startsWith(indent)) return line.slice(indent.length)
  return line
}

function findIndentationMatches(actual: string[], wanted: string[]): number[] {
  const size = wanted.length
  if (size === 0 || actual.length < size) return []
  const matches: number[] = []
  const quoteIndent = commonIndent(wanted)

  for (let i = 0; i + size <= actual.length; i++) {
    const block = actual.slice(i, i + size).map(stripCR)
    const blockIndent = commonIndent(block)
    let ok = true
    for (let j = 0; j < size; j++) {
      if (removeIndent(wanted[j]!, quoteIndent) !== removeIndent(block[j]!, blockIndent)) {
        ok = false
        break
      }
    }
    if (ok) matches.push(i)
  }

  return matches
}

function findTierMatches(actual: string[], wanted: string[], tier: MatchTier): number[] {
  const size = wanted.length
  if (size === 0 || actual.length < size) return []
  const matches: number[] = []

  if (tier === "trailing-whitespace") {
    const target = wanted.map((line) => line.trimEnd())
    for (let i = 0; i + size <= actual.length; i++) {
      let ok = true
      for (let j = 0; j < size; j++) {
        if (stripCR(actual[i + j]!).trimEnd() !== target[j]) {
          ok = false
          break
        }
      }
      if (ok) matches.push(i)
    }
    return matches
  }

  if (tier === "trim") {
    const target = wanted.map((line) => line.trim())
    const indentationMatches = new Set(findIndentationMatches(actual, wanted))
    for (let i = 0; i + size <= actual.length; i++) {
      if (indentationMatches.has(i)) continue
      let ok = true
      for (let j = 0; j < size; j++) {
        if (stripCR(actual[i + j]!).trim() !== target[j]) {
          ok = false
          break
        }
      }
      if (ok) matches.push(i)
    }
    return matches
  }

  if (tier === "unicode") {
    const target = wanted.map(normalizeUnicodeLine)
    for (let i = 0; i + size <= actual.length; i++) {
      let ok = true
      for (let j = 0; j < size; j++) {
        if (normalizeUnicodeLine(stripCR(actual[i + j]!)) !== target[j]) {
          ok = false
          break
        }
      }
      if (ok) matches.push(i)
    }
    return matches
  }

  if (tier === "normalize") {
    const target = wanted.map(normalizeTrimmedLine)
    const indentationMatches = new Set(findIndentationMatches(actual, wanted))
    for (let i = 0; i + size <= actual.length; i++) {
      if (indentationMatches.has(i)) continue
      let ok = true
      for (let j = 0; j < size; j++) {
        if (normalizeTrimmedLine(stripCR(actual[i + j]!)) !== target[j]) {
          ok = false
          break
        }
      }
      if (ok) matches.push(i)
    }
    return matches
  }

  return findIndentationMatches(actual, wanted)
}

function nonOverlapping(matches: number[], size: number): boolean {
  for (let i = 1; i < matches.length; i++) {
    if (matches[i]! - matches[i - 1]! < size) return false
  }
  return true
}

function replacementLines(newString: string, ending: "\r\n" | "\n", tier: MatchTier | undefined, quoteIndent: string, blockIndent: string): string[] {
  if (newString === "") return []
  const lines = newString.replace(/\r\n/g, "\n").split("\n").map(stripCR)
  const trailingNewline = lines.length > 1 && lines[lines.length - 1] === ""
  if (trailingNewline) lines.pop()

  const logical = tier === "indentation"
    ? lines.map((line) => {
        if (!line.trim()) return ""
        if (quoteIndent && line.startsWith(quoteIndent)) return blockIndent + line.slice(quoteIndent.length)
        return line
      })
    : lines

  const result = logical.map((line) => (ending === "\r\n" ? `${line}\r` : line))
  if (trailingNewline) result.push("")
  return result
}

function applyLineMatches(original: string, matches: number[], size: number, newString: string, ending: "\r\n" | "\n", tier: MatchTier | undefined, wanted: string[]): string {
  const raw = original.split("\n")
  const trailing = raw.length > 1 && raw[raw.length - 1] === ""
  const actual = trailing ? raw.slice(0, -1) : raw.slice()
  const result = actual.slice()
  const quoteIndent = tier === "indentation" ? commonIndent(wanted) : ""

  for (const start of [...matches].sort((a, b) => b - a)) {
    const block = actual.slice(start, start + size).map(stripCR)
    const blockIndent = tier === "indentation" ? commonIndent(block) : ""
    const replacement = replacementLines(newString, ending, tier, quoteIndent, blockIndent)
    result.splice(start, size, ...replacement)
  }

  return result.join("\n") + (trailing ? "\n" : "")
}

function lineAt(text: string, index: number): number {
  let line = 1
  for (let i = 0; i < index && i < text.length; i++) {
    if (text[i] === "\n") line++
  }
  return line
}

function exactOccurrences(text: string, find: string): number[] {
  if (!find) return []
  const out: number[] = []
  let index = text.indexOf(find)
  while (index !== -1) {
    out.push(index)
    index = text.indexOf(find, index + find.length)
  }
  return out
}

function formatRanges(ranges: MatchRange[]): string {
  return ranges.map((range) => `${range.start}-${range.end}`).join(", ")
}

function candidateLines(actual: string[], matches: number[], size: number): string {
  return matches
    .slice(0, 5)
    .map((start) => {
      const block = actual.slice(start, start + size).map(stripCR)
      const shown = block.slice(0, 3).map((line, i) => `  ${start + i + 1}: ${line.trim()}`)
      if (block.length > 3) shown.push(`  … (${block.length - 3} more)`)
      return shown.join("\n")
    })
    .join("\n")
}

function numberedHint(original: string, hint: string): string {
  const index = original.indexOf(hint)
  if (index === -1) return hint
  const startLine = lineAt(original, index)
  const lines = hint.split("\n")
  const endLine = startLine + Math.max(0, lines.length - 1)
  const body = lines.map((line, i) => `  ${startLine + i}: ${stripCR(line)}`).join("\n")
  return `(lines ${startLine}-${endLine})\n${body}`
}

function fuzzyError(display: string, tier: MatchTier, matches: number[], size: number, actual: string[]): ToolError {
  const label = TIER_LABEL[tier]
  const candidates = candidateLines(actual, matches, size)
  return new ToolError(
    `old_string was not found exactly in ${display}, and the closest match (ignoring ${label}) appears ${matches.length} times, so nothing was written. Include surrounding lines so it matches only once, or set replace_all to change every one.\n${candidates}`,
  )
}

/**
 * One replacement, on text rather than on the disk. Throws what the
 * model should read when the quote is missing or is not unique.
 */
function replaceIn(original: string, change: Change, ending: "\r\n" | "\n", display: string): ReplaceResult {
  const inFileEndings = (text: string) => {
    const plain = text.replaceAll("\r\n", "\n")
    return ending === "\n" ? plain : plain.replaceAll("\n", "\r\n")
  }
  const find = inFileEndings(change.oldString)
  const replacement = inFileEndings(change.newString)

  const first = original.indexOf(find)
  if (first !== -1) {
    const occurrences = original.split(find).length - 1
    if (occurrences > 1 && !change.replaceAll) {
      const starts = exactOccurrences(original, find).map((index) => lineAt(original, index))
      const shown = starts.slice(0, 5).map((line) => `  ${line}`).join("\n")
      throw new ToolError(
        `old_string appears ${occurrences} times in ${display}, and replace_all is not set. Set replace_all to change every one, or include surrounding lines so it matches only once.\n${shown}`,
      )
    }
    const updated = change.replaceAll ? original.split(find).join(replacement) : original.slice(0, first) + replacement + original.slice(first + find.length)
    return { updated, occurrences }
  }

  const raw = original.split("\n")
  const trailing = raw.length > 1 && raw[raw.length - 1] === ""
  const actual = trailing ? raw.slice(0, -1) : raw
  const wanted = quoteLines(change.oldString)

  // A file with both \r\n and a lone \n has no single ending rule to lean on,
  // so no fuzzy tier is trusted: fall through to the exact not-found error.
  const mixed = mixedEndings(original)

  if (wanted.length > 0 && !mixed) {
    for (const tier of ["trailing-whitespace", "trim", "unicode", "normalize", "indentation"] as const) {
      const matches = findTierMatches(actual, wanted, tier)
      if (matches.length === 0) continue

      if (matches.length > 1) {
        if (change.replaceAll && nonOverlapping(matches, wanted.length)) {
          const updated = applyLineMatches(original, matches, wanted.length, change.newString, ending, tier, wanted)
          const ranges = matches.map((start) => ({ start: start + 1, end: start + wanted.length }))
          return {
            updated,
            occurrences: matches.length,
            matchTier: tier,
            ranges,
            reindented: tier === "indentation",
          }
        }
        throw fuzzyError(display, tier, matches, wanted.length, actual)
      }

      const start = matches[0]!
      const updated = applyLineMatches(original, matches, wanted.length, change.newString, ending, tier, wanted)
      return {
        updated,
        occurrences: 1,
        matchTier: tier,
        ranges: [{ start: start + 1, end: start + wanted.length }],
        reindented: tier === "indentation",
      }
    }
  }

  const hint = closestMatch(original, change.oldString)
  const shownRaw = hint ? numberedHint(original, hint) : undefined
  const shown = shownRaw && shownRaw.length > HINT_MAX_CHARS ? `${shownRaw.slice(0, HINT_MAX_CHARS)}\n… (cut)` : shownRaw
  const lead = `old_string was not found in ${display}. It has to match the file exactly, including whitespace, indentation and line endings.`
  if (!shown) throw new ToolError(lead)
  const [header, ...body] = shown.split("\n")
  throw new ToolError(
    `${lead}\n\nThe closest text in the file ${header} - note its exact whitespace, and send it again as old_string:\n${body.join("\n")}`,
  )
}

/**
 * What a file holds now, or undefined when there is no file there at all.
 *
 * Only a path that does not exist is a new file (T10-31). A folder, a file this
 * app may not read or anything else that fails is said before anyone is asked
 * to approve a "new" file - approving one used to end in a crash, or in a file
 * that could be written but not read being overwritten unseen.
 */
export async function currentText(target: string, display: string): Promise<string | undefined> {
  try {
    if ((await fs.stat(target)).isDirectory()) throw new ToolError(`${display} is a folder, not a file`)
    return await fs.readFile(target, "utf8")
  } catch (error) {
    if (error instanceof ToolError) throw error
    const code = (error as NodeJS.ErrnoException).code
    if (code === "ENOENT") {
      // Windows says ENOENT for a path that runs through a file; that is no place for a new one.
      for (let parent = path.dirname(target); parent !== path.dirname(parent); parent = path.dirname(parent)) {
        const stat = await fs.stat(parent).catch(() => undefined)
        if (!stat) continue
        if (!stat.isDirectory()) throw new ToolError(`${display} could not be read (${path.basename(parent)} is a file, not a folder), so it was not changed.`)
        break
      }
      return undefined
    }
    if (code === "EACCES" || code === "EPERM") {
      throw new ToolError(`Permission denied: ${display} exists but this app is not allowed to read it, so it was not changed.`, "error.readDenied", { path: display })
    }
    throw new ToolError(`${display} could not be read (${code ?? (error as Error).message}), so it was not changed.`)
  }
}

/**
 * The last look before the bytes land: the file must still hold exactly the
 * text the diff the user approved was computed from (or still be absent, for a
 * new file). Anything else - an editor, a formatter, another tool that ran
 * while the approval was open - stops the write.
 */
async function unchangedSince(target: string, display: string, expected: string | undefined): Promise<void> {
  const changedError = () => new ToolError(`${display} changed while the edit was waiting for approval; nothing was written. Read it again.`)
  let now: string | undefined
  try {
    now = await fs.readFile(target, "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw changedError()
    now = undefined
  }
  if (now === expected) return
  throw changedError()
}

function allowProjectTools(context: ToolContext): boolean {
  try {
    return Boolean(
      context.permissions &&
      typeof context.permissions.action === "function" &&
      context.permissions.action("bash") === "allow",
    )
  } catch {
    return false
  }
}

function verifyLoopForCheck(sessionID: string, display: string, check: PostEditCheckResult | undefined): { text: string; metadata?: Record<string, unknown> } {
  if (!check) return { text: "" }

  if (check.problems > 0) {
    const round = incrementVerifyLoop(sessionID)
    const max = verifyLoopMax()
    const stuck = round > max
    const concrete = concreteStepFromPostEdit({
      checker: check.checker,
      problems: check.problems,
      path: display,
      status: check.status,
      rerunHint: check.rerunHint,
    })
    const text = stuck
      ? formatStuckSuggestion(check.problems, round, max, concrete)
      : formatVerifyLoopNote(check.problems, round, max, concrete)
    return { text, metadata: { round, max, stuck } }
  }

  if (check.status !== "timeout") resetVerifyLoop(sessionID)
  return {
    text: "",
    metadata: {
      round: getVerifyLoopRound(sessionID),
      max: verifyLoopMax(),
      stuck: false,
    },
  }
}

function postEditCheckMetadata(check: PostEditCheckResult): Record<string, unknown> {
  return {
    checker: check.checker,
    problems: check.problems,
    ...(check.status ? { status: check.status } : {}),
    ...(check.diagnostics?.length ? { diagnostics: check.diagnostics } : {}),
    ...(check.rerunHint ? { rerunHint: check.rerunHint } : {}),
  }
}

export const WriteTool: ToolDefinition = {
  name: "write",
  description: [
    "Write a file: create it, or replace everything that was in it.",
    "",
    "Before using it",
    "- On a file that already exists, read it first. write replaces the whole file, so anything you did not know was there is gone.",
    "- For a change to part of a file, use edit instead. Rewriting a file wholesale to change three lines loses whatever you had not noticed and makes the change unreadable to the user.",
    "- For a Jupyter notebook (.ipynb), use notebook_edit: writing the JSON by hand loses outputs and cell ids.",
    "",
    "Writing it",
    "- file_path is absolute, or relative to the project root. Missing folders on the way to it are created.",
    "- content is the file as it should end up, in full, with the line endings and final newline the rest of the project uses.",
    "- Build a large file in parts: write a first portion with this tool, then add the rest with edit calls. A single call carrying the whole of a big file can run past the reply's output limit, and then the file is left cut off part way through.",
    "- Write only the files the work needs. Do not add a README, a summary of what you did, a licence header or a test file nobody asked for.",
    "- Follow the project's own conventions - imports, naming, formatting - rather than the ones you would choose on a blank page. Read a file beside it first when you are not sure what they are.",
    "The result is a diff of what changed, and the user sees it; there is no need to repeat the file back in your reply.",
  ].join("\n"),
  permission: "edit",
  parameters: {
    type: "object",
    properties: {
      file_path: { type: "string", description: "Path of the file, absolute or relative to the project root" },
      content: { type: "string", description: "Full contents to write" },
    },
    required: ["file_path", "content"],
    additionalProperties: false,
  },
  async execute(input, context) {
    const target = await resolvePath(context, String(input.file_path), "write")
    const display = relative(context.directory, target)
    // plan: planning writes its plan file and nothing else.
    guardPlanWrite(context, target, display)
    const content = String(input.content)

    return locked(target, async () => {
      const previous = await currentText(target, display)
      const stale = await checkFresh(context.sessionID, target, previous)
      if (stale) {
        throw new ToolError(`${display} has changed since you last read it (modified on disk after your read - by a command, a formatter or another tool). Read it again before editing; nothing was written.`)
      }

      const { diff, filediff } = changed(display, unifiedDiff(display, previous ?? "", content))

      // memory: memory files are written without asking, as MiMo does.
      if (!isMemoryPath(target)) await context.permissions.ask({
        sessionID: context.sessionID,
        messageID: context.messageID,
        callID: context.callID,
        // Creating a file is judged as an edit, as MiMo and OpenCode judge it (R16-C6).
        kind: "edit",
        directory: context.directory,
        title: previous === undefined ? "Create file" : "Overwrite file",
        subject: display,
        preview: diff,
      })

      await context.snapshot(target)
      await fs.mkdir(path.dirname(target), { recursive: true })
      await unchangedSince(target, display, previous)
      await fs.writeFile(target, content, "utf8")
      await recordWrite(context.sessionID, target, content)

      const check = await postEditCheckDetailed(target, context.directory, context.signal, allowProjectTools(context)).catch(() => undefined)
      const loop = verifyLoopForCheck(context.sessionID, display, check)
      const output = `${previous === undefined ? "Created" : "Overwrote"} ${display} (${content.split("\n").length} lines)${check?.text ?? ""}${loop.text}`

      return {
        output,
        title: display,
        metadata: {
          path: display,
          diff,
          filediff,
          created: previous === undefined,
          ...(check ? {
            postEditCheck: postEditCheckMetadata(check),
            ...(loop.metadata ? { verifyLoop: loop.metadata } : {}),
          } : {}),
        },
      }
    })
  },
}

export const EditTool: ToolDefinition = {
  name: "edit",
  description: [
    "Replace one exact piece of text in a file with another.",
    "",
    "Before using it",
    "Read the file first, in this conversation. The text you quote has to match the file byte for byte, and a file you have not read is one you are quoting from memory.",
    "",
    "Quoting old_string",
    "- Copy it from the read tool's output with the `N: ` line-number prefix removed. The number and colon are the tool's, not the file's.",
    "- Keep the indentation exactly as it is - tabs where the file has tabs - and do not normalise whitespace or line endings.",
    "- It has to appear exactly once in the file. If it does not, the call fails and nothing is written: take more of the surrounding lines until the quote is unique, rather than guessing.",
    "- Set replace_all to change every occurrence instead. That is the way to rename a symbol through a file; it is the wrong way to change one of several similar-looking lines.",
    "",
    "What it does",
    "- new_string has to differ from old_string, and is written as given. Small differences in trailing spaces, leading/trailing whitespace, typographic quotes, unicode punctuation/spaces, or indentation are tolerated when the match is unique, and the result says when that happened; still quote exactly.",
    "- An empty old_string writes new_string as the whole file, creating it when it is not there. Use write for that instead unless you are creating a small file in passing.",
    "- One call changes one place in one file; make one call per change.",
    "- The result is a diff, and the user sees it. Do not paste the changed lines back into your reply.",
  ].join("\n"),
  permission: "edit",
  parameters: {
    type: "object",
    properties: {
      file_path: { type: "string", description: "Path of the file, absolute or relative to the project root" },
      old_string: { type: "string", description: "Exact text to replace, including indentation" },
      new_string: { type: "string", description: "Replacement text, different from old_string" },
      replace_all: { type: "boolean", description: "Replace every occurrence instead of requiring exactly one" },
    },
    required: ["file_path", "old_string", "new_string"],
    additionalProperties: false,
  },
  async execute(input, context) {
    const target = await resolvePath(context, String(input.file_path), "write")
    const display = relative(context.directory, target)
    // plan: planning writes its plan file and nothing else.
    guardPlanWrite(context, target, display)
    const oldString = String(input.old_string)
    const newString = String(input.new_string)
    const replaceAll = input.replace_all === true

    if (oldString === newString) throw new ToolError("old_string and new_string are the same, so there is nothing to change")

    return locked(target, async () => {
      // memory: memory files are edited without asking, as MiMo does.
      const ask = async (diff: string) =>
        isMemoryPath(target) ||
        context.permissions.ask({
          sessionID: context.sessionID,
          messageID: context.messageID,
          callID: context.callID,
          kind: "edit",
          directory: context.directory,
          title: "Edit file",
          subject: display,
          preview: diff,
        })

      // MiMo's edit with nothing to find writes the whole file.
      if (oldString === "") {
        const previous = await currentText(target, display)
        const stale = await checkFresh(context.sessionID, target, previous)
        if (stale) {
          throw new ToolError(`${display} has changed since you last read it (modified on disk after your read - by a command, a formatter or another tool). Read it again before editing; nothing was written.`)
        }

        const { diff, filediff } = changed(display, unifiedDiff(display, previous ?? "", newString))
        await ask(diff)
        await context.snapshot(target)
        await fs.mkdir(path.dirname(target), { recursive: true })
        await unchangedSince(target, display, previous)
        await fs.writeFile(target, newString, "utf8")
        await recordWrite(context.sessionID, target, newString)

        const check = await postEditCheckDetailed(target, context.directory, context.signal, allowProjectTools(context)).catch(() => undefined)
        const loop = verifyLoopForCheck(context.sessionID, display, check)
        const output = `${previous === undefined ? "Created" : "Overwrote"} ${display}${check?.text ?? ""}${loop.text}`

        return {
          output,
          title: display,
          metadata: {
            path: display,
            diff,
            filediff,
            created: previous === undefined,
            ...(check ? {
              postEditCheck: postEditCheckMetadata(check),
              ...(loop.metadata ? { verifyLoop: loop.metadata } : {}),
            } : {}),
          },
        }
      }

      const stat = await fs.stat(target).catch(() => undefined)
      if (!stat) throw new ToolError(`File not found: ${display}`)
      if (stat.isDirectory()) throw new ToolError(`${display} is a folder, not a file`)
      const original = await fs.readFile(target, "utf8")

      const stale = await checkFresh(context.sessionID, target, original)
      if (stale) {
        throw new ToolError(`${display} has changed since you last read it (modified on disk after your read - by a command, a formatter or another tool). Read it again before editing; nothing was written.`)
      }

      const { updated, occurrences, matchTier, ranges, reindented } = replaceIn(original, { oldString, newString, replaceAll }, endingOf(original), display)
      const { diff, filediff } = changed(display, unifiedDiff(display, original.replaceAll("\r\n", "\n"), updated.replaceAll("\r\n", "\n")))
      await ask(diff)
      await context.snapshot(target)
      await unchangedSince(target, display, original)
      await fs.writeFile(target, updated, "utf8")
      await recordWrite(context.sessionID, target, updated)

      let output = `Edited ${display}`
      if (matchTier && ranges) {
        const rangeText = `matched lines ${formatRanges(ranges)}`
        const tierText = `after ignoring ${TIER_LABEL[matchTier]}`
        const reindentText = reindented ? "; new_string re-indented" : ""
        output += replaceAll ? ` (${occurrences} occurrences, ${rangeText} ${tierText}${reindentText})` : ` (${rangeText} ${tierText}${reindentText})`
      } else if (replaceAll) {
        output += ` (${occurrences} occurrences)`
      }

      const check = await postEditCheckDetailed(target, context.directory, context.signal, allowProjectTools(context)).catch(() => undefined)
      const loop = verifyLoopForCheck(context.sessionID, display, check)
      output += check?.text ?? ""
      output += loop.text

      return {
        output,
        title: display,
        metadata: {
          path: display,
          diff,
          filediff,
          occurrences: replaceAll ? occurrences : 1,
          ...(matchTier ? { matchTier } : {}),
          ...(ranges ? { ranges } : {}),
          ...(reindented ? { reindented: true } : {}),
          ...(check ? {
            postEditCheck: postEditCheckMetadata(check),
            ...(loop.metadata ? { verifyLoop: loop.metadata } : {}),
          } : {}),
        },
      }
    })
  },
}
