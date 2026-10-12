import { spawn } from "node:child_process"
import { constants } from "node:fs"
import fs from "node:fs/promises"
import path from "node:path"

export interface PostEditCheckResult {
  checker: string
  text: string
  problems: number
  status?: "ok" | "timeout"
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

function formatResult(checker: string, rel: string, lines: string[], problems: number): PostEditCheckResult {
  if (problems === 0) {
    return { checker, problems: 0, status: "ok", text: cap(`\n\nPost-edit check (${checker}): no problems in ${rel}.`) }
  }

  const body = lines.length ? lines.slice(0, 15) : ["(no details)"]
  if (problems > body.length) body.push(`(showing first ${body.length})`)
  const text = [
    `\n\nPost-edit check (${checker}): ${problems} problem(s) in ${rel}`,
    ...body,
    "Fix these before moving on, or say why they are expected.",
  ].join("\n")

  return { checker, problems, status: "ok", text: cap(text) }
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

  const lines = syntaxCheckLines(`${run.stderr}\n${run.stdout}`, file, projectDir)
  return formatResult(checker, rel, lines.length ? lines : [`${checker} failed with exit code ${run.code ?? "unknown"}`], 1)
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

  if (matching.length > 0) return formatResult(checker, rel, lines, matching.length)
  if (run.code === 0) return formatResult(checker, rel, [], 0)

  const fallback = all.slice(0, 15)
  return formatResult(checker, rel, fallback.length ? fallback : [`${checker} failed with exit code ${run.code ?? "unknown"}`], all.length || 1)
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

async function findTsc(tsconfig: string, projectDir: string): Promise<string | undefined> {
  const root = path.resolve(projectDir)
  let dir = path.resolve(path.dirname(tsconfig))

  while (isUnder(dir, root)) {
    const candidate = path.join(dir, "node_modules", "typescript", "bin", "tsc")
    if (await exists(candidate)) return candidate
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }

  return undefined
}

async function findEslint(projectDir: string): Promise<string | undefined> {
  const candidate = path.join(projectDir, "node_modules", "eslint", "bin", "eslint.js")
  if (await exists(candidate)) return candidate
  return undefined
}

async function runTsc(tsconfig: string, tscPath: string, projectDir: string): Promise<RunResult> {
  const key = path.resolve(tsconfig)
  const existing = tscRuns.get(key)
  if (existing) return await existing

  const run = runWithTimeout(nodeCommand(), [tscPath, "--noEmit", "-p", tsconfig, "--pretty", "false"], 25_000, { cwd: projectDir })
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

function formatDiagnostic(diagnostic: TscDiagnostic, projectDir: string): string {
  return `${relativeFile(diagnostic.path, projectDir)}(${diagnostic.line},${diagnostic.column}): ${diagnostic.message}`
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

  const raw = `${run.stdout}\n${run.stderr}`
  const diagnostics = parseTscDiagnostics(raw, projectDir)
  const edited = diagnostics.filter((diagnostic) => samePath(diagnostic.path, file))
  const other = diagnostics.filter((diagnostic) => !samePath(diagnostic.path, file))

  if (edited.length === 0 && other.length === 0) {
    if (run.code === 0) return formatResult("tsc", rel, [], 0)
    const lines = nonEmptyLines(localize(raw, file, projectDir)).slice(0, 15)
    return formatResult("tsc", rel, lines.length ? lines : [`tsc failed with exit code ${run.code ?? "unknown"}`], 1)
  }

  const maxEdited = other.length > 0 ? 14 : 15
  const lines = edited.slice(0, maxEdited).map((diagnostic) => formatDiagnostic(diagnostic, projectDir))
  if (other.length > 0) {
    const examples = other.slice(0, 3).map((diagnostic) => formatDiagnostic(diagnostic, projectDir)).join("; ")
    lines.push(`+${other.length} errors in other files, e.g. ${examples}`)
  }

  return formatResult("tsc", rel, lines, edited.length > 0 ? edited.length : 1)
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
    return formatResult("json", rel, [message], 1)
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
    if (TS_EXTENSIONS.has(ext)) return await checkTypeScript(file, projectDir, rel, signal, allowProjectTools)
    if (JS_EXTENSIONS.has(ext)) return await checkJavaScript(file, projectDir, rel, signal, allowProjectTools)
    if (ext === ".py") return await checkPython(file, projectDir, rel, signal)
    if (ext === ".json") return await checkJson(file, projectDir, rel)
  } catch {
    return undefined
  }

  return undefined
}

export async function postEditCheck(
  file: string,
  projectDir: string,
  signal?: AbortSignal,
  allowProjectTools: boolean = false,
): Promise<string | undefined> {
  return (await postEditCheckDetailed(file, projectDir, signal, allowProjectTools))?.text
}
