import { spawn } from "node:child_process"

type FailingTest = {
  command: string
  cwd: string
  at: number
  timedOut?: boolean
}

type RerunResult = {
  exit: number | null
  output: string
  timedOut: boolean
  aborted?: boolean
}

type RerunRunner = (
  command: string,
  cwd: string,
  timeoutMs: number,
  signal: AbortSignal,
) => Promise<RerunResult>

type RerunOptions = {
  timeoutMs?: number
  run?: RerunRunner
}

const MAX_SESSIONS = 300
const DEFAULT_TIMEOUT_MS = 90_000
const OUTPUT_TAIL_CHARS = 1500

const failingTests = new Map<string, FailingTest>()

const ENV_ASSIGNMENT_PATTERN =
  /^(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|[^\s]*)\s+)+/

const CD_PREFIX_PATTERN = /^cd\s+(?:"[^"]*"|'[^']*'|[^\s]+)\s*&&\s*/

const TEST_SEGMENT_PATTERN =
  /^(?:(?:python(?:3)?\s+-m|npx|uv\s+run|poetry\s+run)(?:\s+(?:--\S+|-\S+))*\s+)?(?:python(?:3)?\s+-m\s+(?:pytest|unittest)|pytest|unittest|tox|jest|vitest|mocha|node\s+--test|(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test(?::[\w-]+)*|go\s+test|cargo\s+test)(?:\s|$)/

function normalizeSegment(segment: string): string {
  let normalized = segment.trim()

  while (true) {
    const withoutEnv = normalized.replace(ENV_ASSIGNMENT_PATTERN, "")
    const withoutCd = withoutEnv.replace(CD_PREFIX_PATTERN, "")

    if (withoutCd === normalized) {
      return normalized
    }

    normalized = withoutCd
  }
}

function commandSegments(command: string): string[] {
  // Blank quoted spans first so `&&` / `|` inside quotes do not split segments
  // (`git commit -m "fix || pytest broken"` must not read as a test command).
  const masked = command.replace(/"(?:[^"\\]|\\.)*"/g, '""').replace(/'(?:[^'\\]|\\.)*'/g, "''")
  return masked
    .split(/&&|\|\||;|\|/)
    .map((segment) => segment.trim())
    .filter(Boolean)
}

export function isTestCommand(command: string): boolean {
  return commandSegments(command).some((segment) =>
    TEST_SEGMENT_PATTERN.test(normalizeSegment(segment)),
  )
}

function rememberFailingTest(sessionID: string, entry: FailingTest): void {
  failingTests.delete(sessionID)
  failingTests.set(sessionID, entry)
  while (failingTests.size > MAX_SESSIONS) {
    const oldest = failingTests.keys().next()
    if (oldest.done) break
    failingTests.delete(oldest.value)
  }
}

export function noteShellRun(
  sessionID: string,
  cwd: string,
  command: string,
  _output: string,
  exit: number | null,
): void {
  if (!isTestCommand(command)) return

  if (exit === 0) {
    failingTests.delete(sessionID)
    return
  }

  if (typeof exit === "number" && exit !== 0) {
    rememberFailingTest(sessionID, {
      command,
      cwd,
      at: Date.now(),
    })
  }
}

function tailOutput(output: string): string {
  const tail = output.slice(-OUTPUT_TAIL_CHARS)
  return tail.trim()
}

function defaultRun(
  command: string,
  cwd: string,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<RerunResult> {
  return new Promise((resolve) => {
    let settled = false
    let timedOut = false
    let output = ""

    const child = spawn("bash", ["-c", command], {
      cwd,
      env: process.env,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    })

    const killProcessGroup = () => {
      if (typeof child.pid === "number") {
        try {
          process.kill(-child.pid, "SIGKILL")
        } catch {
          child.kill("SIGKILL")
        }
      } else {
        child.kill("SIGKILL")
      }
    }

    const finish = (exit: number | null, didTimeOut: boolean, wasAborted = false) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal.removeEventListener("abort", onAbort)
      resolve({
        exit,
        output,
        timedOut: didTimeOut,
        ...(wasAborted ? { aborted: true } : {}),
      })
    }

    // An interrupt is not a timeout: marking it so would retire this failing
    // test forever, so abort resolves with its own flag instead.
    const onAbort = () => {
      killProcessGroup()
      finish(null, false, true)
    }

    const timer = setTimeout(() => {
      timedOut = true
      killProcessGroup()
      finish(null, true)
    }, timeoutMs)

    child.stdout?.on("data", (chunk: Buffer | string) => {
      output += chunk.toString()
    })

    child.stderr?.on("data", (chunk: Buffer | string) => {
      output += chunk.toString()
    })

    child.on("error", () => {
      finish(null, timedOut)
    })

    child.on("close", (code) => {
      finish(code, timedOut)
    })

    signal.addEventListener("abort", onAbort, { once: true })
    if (signal.aborted) onAbort()
  })
}

export async function rerunAfterEdit(
  sessionID: string,
  signal: AbortSignal,
  options: RerunOptions = {},
): Promise<string> {
  try {
    if (process.env.MCODE_RERUN_TESTS === "0") return ""
    if (process.platform === "win32") return ""

    const remembered = failingTests.get(sessionID)
    if (!remembered) return ""
    if (remembered.timedOut) return ""

    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    const run = options.run ?? defaultRun
    const result = await run(remembered.command, remembered.cwd, timeoutMs, signal)

    // An aborted run says nothing about the test: leave the memory as it was.
    if (result.aborted) return ""

    if (result.timedOut) {
      rememberFailingTest(sessionID, {
        ...remembered,
        at: Date.now(),
        timedOut: true,
      })
    } else if (result.exit === 0) {
      failingTests.delete(sessionID)
    } else if (typeof result.exit === "number" && result.exit !== 0) {
      rememberFailingTest(sessionID, {
        ...remembered,
        at: Date.now(),
        timedOut: false,
      })
    }

    const exitText = result.exit === null ? "null" : String(result.exit)
    const timeoutText = result.timedOut ? ` (timed out after ${Math.round(timeoutMs / 1000)}s)` : ""
    const passText = result.exit === 0 ? "\nThe tests that were failing now pass." : ""

    return [
      "",
      "",
      `Re-ran the last failing test command after this edit: \`${remembered.command}\` -> exit ${exitText}${timeoutText}`,
      tailOutput(result.output),
      passText,
    ].join("\n")
  } catch {
    return ""
  }
}
