import { spawn } from "node:child_process"
import { constants } from "node:fs"
import fs from "node:fs/promises"
import path from "node:path"
import { loadVerifyCommands } from "./verify-commands"

export interface Diagnostic {
  file: string
  line?: number
  column?: number
  message: string
}

export interface PostEditCheckResult {
  checker: string
  text: string
  problems: number
  status?: "ok" | "timeout"
  diagnostics?: Diagnostic[]
  rerunHint?: string
}

export interface RunResult {
  code: number | null
  stdout: string
  stderr: string
  timedOut: boolean
  aborted: boolean
}

interface RunOptions {
  cwd?: string
  signal?: AbortSignal
}

const OUTPUT_CAP = 2500
const RAW_CAP = 200_000
const MAX_JSON_CHECK_BYTES = 2 * 1024 * 1024
const SECRET_ENV_NAME = /(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i

const TS_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts"])
const JS_EXTENSIONS = new Set([".js", ".cjs", ".mjs", ".jsx"])
const NODE_CHECK_EXTENSIONS = new Set([".js", ".cjs", ".mjs"])

/** One tsc run per tsconfig at a time; later callers reuse the same raw output. */
const tscRuns = new Map<string, Promise<RunResult>>()

function nodeCommand(): string {
  return process.env.MCODE_NODE || "node"
}

function childEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [name, value] of Object.entries(process.env)) {
    if (SECRET_ENV_NAME.test(name)) continue
    if (value !== undefined) env[name] = value
  }
  env.NO_COLOR = "1"
  return env
}

function relativeFile(file: string, projectDir: string): string {
  const rel = path.relative(projectDir, file)
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return file
  return rel.split(path.sep).join("/")
}

function samePath(a: string, b: string): boolean {
  const left = path.resolve(a)
  const right = path.resolve(b)
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right
}

function isUnder(child: string, parent: string): boolean {
  const rel = path.relative(parent, child)
  if (rel === "") return true
  if (path.isAbsolute(rel)) return false
  return process.platform === "win32" ? !rel.toLowerCase().startsWith("..") : !rel.startsWith("..")
}

async function exists(candidate: string): Promise<boolean> {
  try {
    await fs.access(candidate)
    return true
  } catch {
    return false
  }
}

async function isExecutable(candidate: string): Promise<boolean> {
  try {
    const stat = await fs.stat(candidate)
    if (!stat.isFile()) return false
    if (process.platform === "win32") return true
    await fs.access(candidate, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** A shell-free `which`: only PATH entries, no command lookup through a shell. */
export async function which(command: string): Promise<string | undefined> {
  if (command.includes("/") || command.includes("\\")) {
    return await isExecutable(command) ? command : undefined
  }

  const separator = process.platform === "win32" ? ";" : ":"
  const dirs = (process.env.PATH ?? "").split(separator).filter(Boolean)
  const extensions = process.platform === "win32"
    ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean)
    : [""]

  for (const dir of dirs) {
    for (const extension of extensions) {
      const candidate = path.join(dir, command + extension)
      if (await isExecutable(candidate)) return candidate
    }
  }

  return undefined
}

function killTree(child: ReturnType<typeof spawn>): void {
  if (child.pid === undefined) return
  try {
    if (process.platform === "win32") child.kill("SIGKILL")
    else process.kill(-child.pid, "SIGKILL")
  } catch {
    try {
      child.kill("SIGKILL")
    } catch {
      // The process is already gone.
    }
  }
}

/**
 * Run a command without a shell, collecting stdout/stderr and resolving even
 * when it times out or is aborted. The caller decides how to report that.
 */
export function runWithTimeout(command: string, args: string[], ms: number, options: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(command, args, {
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        cwd: options.cwd ?? process.cwd(),
        env: childEnv(),
        detached: process.platform !== "win32",
      })
    } catch (error) {
      resolve({ code: null, stdout: "", stderr: error instanceof Error ? error.message : String(error), timedOut: false, aborted: false })
      return
    }

    let stdout = ""
    let stderr = ""
    let settled = false
    let timer: NodeJS.Timeout | undefined

    const finish = (result: RunResult) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      options.signal?.removeEventListener("abort", onAbort)
      resolve(result)
    }

    const onAbort = () => {
      killTree(child)
      finish({ code: child.exitCode ?? null, stdout, stderr, timedOut: false, aborted: true })
    }

    if (options.signal?.aborted) {
      onAbort()
      return
    }

    options.signal?.addEventListener("abort", onAbort, { once: true })

    timer = setTimeout(() => {
      killTree(child)
      finish({ code: child.exitCode ?? null, stdout, stderr, timedOut: true, aborted: false })
    }, ms)

    child.stdout?.on("data", (chunk) => {
      if (stdout.length < RAW_CAP) stdout += String(chunk)
    })
    child.stderr?.on("data", (chunk) => {
      if (stderr.length < RAW_CAP) stderr += String(chunk)
    })
    child.on("error", (error) => {
      finish({ code: null, stdout, stderr: stderr + (error instanceof Error ? error.message : String(error)), timedOut: false, aborted: false })
    })
    child.on("close", (code) => {
      finish({ code, stdout, stderr, timedOut: false, aborted: false })
    })
  })
}

function cap(text: string): string {
  if (text.length <= OUTPUT_CAP) return text
  return `${text.slice(0, OUTPUT_CAP - 15)}\n… (cut)`
}

function nonEmptyLines(text: string): string[] {
  return text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
}

function localize(text: string, file: string, projectDir: string): string {
  const rel = relativeFile(file, projectDir)
  let out = text
  for (const candidate of [file, path.resolve(file)]) {
    if (candidate && out.includes(candidate)) out = out.split(candidate).join(rel)
  }
  const root = path.resolve(projectDir)
  if (root && out.includes(root)) out = out.split(root).join(".")
  return out
}

function diagnosticLine(d: Diagnostic): string {
  const loc: string[] = [d.file]
  if (d.line !== undefined) loc.push(String(d.line))
  if (d.column !== undefined) loc.push(String(d.column))
  return `${loc.join(":")}:${d.message}`
}

function formatResult(
  checker: string,
  rel: string,
  lines: string[],
  problems: number,
  diagnostics?: Diagnostic[],
  rerunHint?: string,
  textDiagnostics: Diagnostic[] | undefined = diagnostics,
): PostEditCheckResult {
  if (problems === 0) {
    return { checker, problems: 0, status: "ok", text: cap(`\n\nPost-edit check (${checker}): no problems in ${rel}.`) }
  }

  const summaryLines = lines.filter((line) => line.startsWith("+"))
  let body: string[]
  let omitted = 0

  if (textDiagnostics?.length) {
    const maxDiagnosticLines = Math.max(0, 15 - summaryLines.length)
    const shown = textDiagnostics.slice(0, maxDiagnosticLines)
    omitted = textDiagnostics.length - shown.length
    body = [...shown.map(diagnosticLine), ...summaryLines]
  } else {
    const shownLines = lines.slice(0, 15)
    omitted = Math.max(0, lines.length - shownLines.length)
    body = shownLines.length ? shownLines : ["(no details)"]
  }

  if (problems > body.length || omitted > 0) body.push(`(showing first ${body.length})`)

  const parts = [
    `\n\nPost-edit check (${checker}): ${problems} problem(s) in ${rel}`,
    ...body,
  ]
  if (rerunHint) parts.push(`Re-run: ${rerunHint}`)
  parts.push("Fix these before moving on, or say why they are expected.")

  const text = parts.join("\n")
  return {
    checker,
    problems,
    status: "ok",
    text: cap(text),
    ...(diagnostics?.length ? { diagnostics } : {}),
    ...(rerunHint ? { rerunHint } : {}),
  }
}

export function timeoutResult(checker: string, rel: string, seconds: number): PostEditCheckResult {
  return {
    checker,
    problems: 0,
    status: "timeout",
    text: `\n\nPost-edit check (${checker}): timed out after ${seconds}s; result unknown.`,
  }
}

function syntaxCheckLines(text: string, file: string, projectDir: string): string[] {
  const localized = localize(text, file, projectDir)
  const out: string[] = []

  for (const line of localized.split(/\r?\n/)) {
    if (line.trim() === "") continue
    if (/^\s*at\s+/.test(line)) continue
    if (/^Node\.js v/.test(line)) continue
    out.push(line)
  }

  return out.slice(0, 15)
}

function parseSyntaxDiagnostics(raw: string, file: string, projectDir: string): Diagnostic[] {
  const rel = relativeFile(file, projectDir)
  const lines = raw.split(/\r?\n/)

  for (const line of lines) {
    const m1 = /^(.+?):(\d+)$/.exec(trimmedLine(line))
    if (m1) {
      const lineNum = parseInt(m1[2]!, 10)
      const msgLine = lines.find((l) => /^(SyntaxError|TypeError|ReferenceError|RangeError|Error):/.test(l.trim()))
      const message = msgLine?.trim() || "syntax error"
      return [{ file: rel, line: lineNum, message }]
    }

    const m2 = /File\s+"(.+?)"\s*,\s*line\s+(\d+)/.exec(trimmedLine(line))
    if (m2) {
      const lineNum = parseInt(m2[2]!, 10)
      const msgLine = lines.find((l) => /^(SyntaxError|IndentationError|TabError):/.test(l.trim()))
      const message = msgLine?.trim() || "syntax error"
      return [{ file: rel, line: lineNum, message }]
    }
  }

  const firstMeaningful = lines.find((l) => l.trim() && !/^\s*at\s/.test(l) && !/^Node\.js/.test(l))?.trim()
  return [{ file: rel, message: firstMeaningful || "syntax error" }]
}

function trimmedLine(line: string): string {
  return line.trim()
}

function syntaxRerunHint(checker: string, rel: string): string {
  if (checker === "node --check") return `node --check ${rel}`
  if (checker === "py_compile") return `python -m py_compile ${rel}`
  return `${checker} ${rel}`
}

function syntaxRunResult(
  checker: string,
  run: RunResult,
  rel: string,
  file: string,
  projectDir: string,
  timeoutSeconds: number,
): PostEditCheckResult | undefined {
  if (run.aborted) return undefined
  if (run.timedOut) return timeoutResult(checker, rel, timeoutSeconds)
  if (run.code === 0) return formatResult(checker, rel, [], 0)

  const raw = `${run.stderr}\n${run.stdout}`
  const lines = syntaxCheckLines(raw, file, projectDir)
  const diagnostics = parseSyntaxDiagnostics(raw, file, projectDir)
  const rerunHint = syntaxRerunHint(checker, rel)
  return formatResult(checker, rel, lines.length ? lines : [`${checker} failed with exit code ${run.code ?? "unknown"}`], 1, diagnostics, rerunHint)
}

function parseDiagnosticLines(lines: string[]): Diagnostic[] {
  const out: Diagnostic[] = []
  for (const line of lines) {
    const m1 = /^(.+?):(\d+):(\d+):\s*(.*)$/.exec(line)
    if (m1) {
      out.push({ file: m1[1]!, line: parseInt(m1[2]!, 10), column: parseInt(m1[3]!, 10), message: m1[4]! })
      continue
    }
    const m2 = /^(.+?):(\d+):(\d+)\s*-\s*(.*)$/.exec(line)
    if (m2) {
      out.push({ file: m2[1]!, line: parseInt(m2[2]!, 10), column: parseInt(m2[3]!, 10), message: m2[4]! })
    }
  }
  return out
}

function diagnosticRerunHint(checker: string, rel: string): string {
  if (checker === "eslint") return `npx eslint ${rel}`
  if (checker === "ruff") return `ruff check ${rel}`
  if (checker === "pyright") return `pyright ${rel}`
  return `${checker} ${rel}`
}

function diagnosticRunResult(
  checker: string,
  run: RunResult,
  rel: string,
  file: string,
  projectDir: string,
  timeoutSeconds: number,
  filter: (line: string) => boolean,
): PostEditCheckResult | undefined {
  if (run.aborted) return undefined
  if (run.timedOut) return timeoutResult(checker, rel, timeoutSeconds)

  const raw = `${run.stdout}\n${run.stderr}`
  const all = nonEmptyLines(localize(raw, file, projectDir))
  const matching = all.filter(filter)
  const lines = matching.slice(0, 15)
  const diagnostics = parseDiagnosticLines(matching)
  const rerunHint = diagnosticRerunHint(checker, rel)

  if (matching.length > 0) return formatResult(checker, rel, lines, matching.length, diagnostics, rerunHint)
  if (run.code === 0) return formatResult(checker, rel, [], 0)

  const fallback = all.slice(0, 15)
  return formatResult(checker, rel, fallback.length ? fallback : [`${checker} failed with exit code ${run.code ?? "unknown"}`], all.length || 1, undefined, rerunHint)
}

async function findTsconfig(file: string, projectDir: string): Promise<string | undefined> {
  const root = path.resolve(projectDir)
  let dir = path.resolve(path.dirname(file))

  while (isUnder(dir, root)) {
    const candidate = path.join(dir, "tsconfig.json")
    if (await exists(candidate)) return candidate
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }

  return undefined
}

function ancestorDirs(start: string): string[] {
  const out: string[] = []
  let dir = path.resolve(start)

  while (true) {
    out.push(dir)
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }

  return out
}

async function findTscInDir(dir: string): Promise<string | undefined> {
  const bin = path.join(dir, "node_modules", "typescript", "bin", "tsc")
  if (await exists(bin)) return bin

  const lib = path.join(dir, "node_modules", "typescript", "lib", "tsc.js")
  if (await exists(lib)) return lib

  return undefined
}

export async function findTsc(tsconfig: string, projectDir: string): Promise<string | undefined> {
  const seen = new Set<string>()
  const dirs = [...ancestorDirs(path.dirname(tsconfig)), ...ancestorDirs(projectDir)]

  for (const dir of dirs) {
    if (seen.has(dir)) continue
    seen.add(dir)

    const found = await findTscInDir(dir)
    if (found) return found
  }

  return await which("tsc")
}

async function findEslint(projectDir: string): Promise<string | undefined> {
  const candidate = path.join(projectDir, "node_modules", "eslint", "bin", "eslint.js")
  if (await exists(candidate)) return candidate
  return undefined
}

function isJavaScriptFile(candidate: string): boolean {
  return /\.(?:js|mjs|cjs)$/i.test(candidate)
}

function tscInvocation(tscPath: string): { command: string; args: string[] } {
  const base = path.basename(tscPath).toLowerCase()
  if (isJavaScriptFile(tscPath) || base === "tsc" || base === "tsc.js") {
    return { command: nodeCommand(), args: [tscPath] }
  }
  return { command: tscPath, args: [] }
}

async function runTsc(tsconfig: string, tscPath: string, projectDir: string): Promise<RunResult> {
  const key = path.resolve(tsconfig)
  const existing = tscRuns.get(key)
  if (existing) return await existing

  const invocation = tscInvocation(tscPath)
  const run = runWithTimeout(
    invocation.command,
    [...invocation.args, "--noEmit", "-p", tsconfig, "--pretty", "false"],
    25_000,
    { cwd: projectDir },
  )
  tscRuns.set(key, run)
  try {
    return await run
  } finally {
    if (tscRuns.get(key) === run) tscRuns.delete(key)
  }
}

function raceAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T | undefined> {
  if (!signal) return promise
  if (signal.aborted) return Promise.resolve(undefined)

  return new Promise<T | undefined>((resolve) => {
    let done = false
    const finish = (value: T | undefined) => {
      if (done) return
      done = true
      signal.removeEventListener("abort", onAbort)
      resolve(value)
    }
    const onAbort = () => finish(undefined)

    signal.addEventListener("abort", onAbort, { once: true })
    promise.then((value) => finish(value), () => finish(undefined))
  })
}

interface TscDiagnostic {
  path: string
  line: string
  column: string
  message: string
}

function parseTscDiagnostics(raw: string, projectDir: string): TscDiagnostic[] {
  const out: TscDiagnostic[] = []
  for (const line of raw.split(/\r?\n/)) {
    const match = /^(.+?)\((\d+),(\d+)\): error (TS\d+): (.*)$/.exec(line.trim())
    if (!match) continue
    const file = path.isAbsolute(match[1]!) ? match[1]! : path.resolve(projectDir, match[1]!)
    out.push({ path: file, line: match[2]!, column: match[3]!, message: `error ${match[4]!}: ${match[5]!}` })
  }
  return out
}

function tscToDiagnostic(d: TscDiagnostic, projectDir: string): Diagnostic {
  return {
    file: relativeFile(d.path, projectDir),
    line: parseInt(d.line, 10),
    column: parseInt(d.column, 10),
    message: d.message,
  }
}

async function checkTypeScript(
  file: string,
  projectDir: string,
  rel: string,
  signal: AbortSignal | undefined,
  allowProjectTools: boolean,
): Promise<PostEditCheckResult | undefined> {
  if (!allowProjectTools) return undefined

  const tsconfig = await findTsconfig(file, projectDir)
  if (!tsconfig) return undefined

  const tscPath = await findTsc(tsconfig, projectDir)
  if (!tscPath) return undefined
  if (signal?.aborted) return undefined

  const run = await raceAbort(runTsc(tsconfig, tscPath, projectDir), signal)
  if (!run) return undefined
  if (run.aborted) return undefined
  if (run.timedOut) return timeoutResult("tsc", rel, 25)

  const relTsconfig = relativeFile(tsconfig, projectDir)
  const rerunHint = `npx tsc -p ${relTsconfig} --noEmit`

  const raw = `${run.stdout}\n${run.stderr}`
  const diagnostics = parseTscDiagnostics(raw, projectDir)
  const edited = diagnostics.filter((diagnostic) => samePath(diagnostic.path, file))
  const other = diagnostics.filter((diagnostic) => !samePath(diagnostic.path, file))

  if (edited.length === 0 && other.length === 0) {
    if (run.code === 0) return formatResult("tsc", rel, [], 0)
    const lines = nonEmptyLines(localize(raw, file, projectDir)).slice(0, 15)
    return formatResult("tsc", rel, lines.length ? lines : [`tsc failed with exit code ${run.code ?? "unknown"}`], 1, undefined, rerunHint)
  }

  const editedDiagnostics = edited.map((d) => tscToDiagnostic(d, projectDir))
  const otherExamples = other.slice(0, 3).map((d) => tscToDiagnostic(d, projectDir))
  const structured: Diagnostic[] = [...editedDiagnostics, ...otherExamples]
  const summaryLines: string[] = []

  if (other.length > 0) {
    const examples = otherExamples.map(diagnosticLine).join("; ")
    summaryLines.push(`+${other.length} errors in other files, e.g. ${examples}`)
  }

  return formatResult(
    "tsc",
    rel,
    summaryLines,
    edited.length > 0 ? edited.length : 1,
    structured,
    rerunHint,
    editedDiagnostics,
  )
}

async function hasEslintConfig(projectDir: string): Promise<boolean> {
  try {
    const entries = await fs.readdir(projectDir)
    return entries.some((name) =>
      name === "eslint.config.js" ||
      name === "eslint.config.mjs" ||
      name === "eslint.config.cjs" ||
      name.startsWith(".eslintrc"),
    )
  } catch {
    return false
  }
}

async function checkJavaScript(
  file: string,
  projectDir: string,
  rel: string,
  signal: AbortSignal | undefined,
  allowProjectTools: boolean,
): Promise<PostEditCheckResult | undefined> {
  if (allowProjectTools) {
    const eslint = await findEslint(projectDir)
    if (eslint && await hasEslintConfig(projectDir)) {
      const run = await runWithTimeout(nodeCommand(), [eslint, "--format", "unix", file], 20_000, { cwd: projectDir, signal })
      return diagnosticRunResult("eslint", run, rel, file, projectDir, 20, (line) => /:\d+:\d+:/.test(line))
    }
  }

  if (!NODE_CHECK_EXTENSIONS.has(path.extname(file).toLowerCase())) return undefined

  const run = await runWithTimeout(nodeCommand(), ["--check", file], 10_000, { cwd: projectDir, signal })
  return syntaxRunResult("node --check", run, rel, file, projectDir, 10)
}

async function checkPython(file: string, projectDir: string, rel: string, signal?: AbortSignal): Promise<PostEditCheckResult | undefined> {
  const ruff = await which("ruff")
  if (ruff) {
    const run = await runWithTimeout(ruff, ["check", "--output-format", "concise", "--no-fix", file], 20_000, { cwd: projectDir, signal })
    return diagnosticRunResult("ruff", run, rel, file, projectDir, 20, (line) => /:\d+:\d+:/.test(line))
  }

  const pyright = await which("pyright")
  if (pyright) {
    const run = await runWithTimeout(pyright, [file], 30_000, { cwd: projectDir, signal })
    return diagnosticRunResult("pyright", run, rel, file, projectDir, 30, (line) => line.includes(" - error"))
  }

  const python = await which("python3") ?? await which("python")
  if (python) {
    const run = await runWithTimeout(python, ["-m", "py_compile", file], 10_000, { cwd: projectDir, signal })
    return syntaxRunResult("py_compile", run, rel, file, projectDir, 10)
  }

  return undefined
}

async function checkJson(file: string, projectDir: string, rel: string): Promise<PostEditCheckResult | undefined> {
  try {
    const stat = await fs.stat(file)
    if (stat.size > MAX_JSON_CHECK_BYTES) return undefined
  } catch {
    return undefined
  }

  let text: string
  try {
    text = await fs.readFile(file, "utf8")
  } catch {
    return undefined
  }

  try {
    JSON.parse(text)
    return formatResult("json", rel, [], 0)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const diagnostics: Diagnostic[] = [{ file: rel, message }]
    return formatResult("json", rel, [message], 1, diagnostics)
  }
}

async function appendProjectChecks(
  result: PostEditCheckResult | undefined,
  projectDir: string,
  signal?: AbortSignal,
): Promise<PostEditCheckResult | undefined> {
  if (!result || result.problems <= 0 || signal?.aborted) return result

  try {
    const commands = await loadVerifyCommands(projectDir)
    if (!commands.length) return result

    const extra = `Project checks: ${commands.join(" · ")}`
    if (result.text.includes(extra)) return result

    const finalSentence = "Fix these before moving on, or say why they are expected."
    let text = result.text
    if (text.includes(finalSentence)) {
      text = text.replace(finalSentence, `${extra}\n${finalSentence}`)
    } else {
      text = `${text}\n${extra}`
    }

    return { ...result, text: cap(text) }
  } catch {
    return result
  }
}

/**
 * Run the project-appropriate quick check for a freshly written file. Returns
 * undefined when there is nothing to report, no checker applies, or the check
 * was aborted.
 */
export async function postEditCheckDetailed(
  file: string,
  projectDir: string,
  signal?: AbortSignal,
  allowProjectTools: boolean = false,
): Promise<PostEditCheckResult | undefined> {
  if (process.env.MCODE_POST_EDIT_CHECK === "0") return undefined
  if (signal?.aborted) return undefined

  const rel = relativeFile(file, projectDir)
  const ext = path.extname(file).toLowerCase()

  try {
    let result: PostEditCheckResult | undefined

    if (TS_EXTENSIONS.has(ext)) result = await checkTypeScript(file, projectDir, rel, signal, allowProjectTools)
    else if (JS_EXTENSIONS.has(ext)) result = await checkJavaScript(file, projectDir, rel, signal, allowProjectTools)
    else if (ext === ".py") result = await checkPython(file, projectDir, rel, signal)
    else if (ext === ".json") result = await checkJson(file, projectDir, rel)

    return await appendProjectChecks(result, projectDir, signal)
  } catch {
    return undefined
  }
}

export async function postEditCheck(
  file: string,
  projectDir: string,
  signal?: AbortSignal,
  allowProjectTools: boolean = false,
): Promise<string | undefined> {
  return (await postEditCheckDetailed(file, projectDir, signal, allowProjectTools))?.text
}
