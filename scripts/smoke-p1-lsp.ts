/**
 * Smoke for the LSP client, diagnostics formatting, request helpers, and the
 * edit-tool integration.
 * Run: esbuild + node, or bun with aliases.
 */
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { formatLspDiagnostics, lspDiagnostics, lspRequest, shutdownLsp } from "../src/server/lsp"
import { EditTool } from "../src/server/tool/edit"
import { LspTool } from "../src/server/tool/lsp"
import { ToolError } from "../src/server/tool/types"
import type { ToolContext } from "../src/server/tool/types"
import { which } from "../src/server/tool/post-edit-check"
import { recordRead } from "../src/server/tool/read-tracker"

let passed = 0
let failed = 0

function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) {
    passed++
    console.log(`  ok   ${name}`)
  } else {
    failed++
    console.log(`  FAIL ${name}${detail === undefined ? "" : ` -> ${JSON.stringify(detail)}`}`)
  }
}

function skip(server: string) {
  passed++
  console.log(`  ok   (skipped: ${server} not installed)`)
}

const TSCONFIG = `{
  "compilerOptions": {
    "strict": true,
    "noEmit": true,
    "module": "commonjs",
    "target": "es2020"
  },
  "include": ["*.ts"]
}
`

const TS_ERROR = `function add(a: number, b: number) {
  return a + b
}
const s: string = add(1, 2)
`

const TS_FIXED = `function add(a: number, b: number) {
  return a + b
}
const s: string = String(add(1, 2))
`

const PY_ERROR = `def f(x: int) -> int:
    return x

y: str = f(1)
`

async function makeContext(directory: string): Promise<ToolContext> {
  return {
    sessionID: `smoke-p1-lsp-${Date.now()}`,
    messageID: "smoke-message",
    callID: "smoke-call",
    directory,
    permissions: {
      ask: async () => undefined,
    },
    questions: {},
    signal: new AbortController().signal,
    progress: async () => {},
    snapshot: async () => {},
  } as unknown as ToolContext
}

async function restoreEnv(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}

async function main() {
  const haveTs = Boolean(await which("typescript-language-server").catch(() => undefined))
  const havePy = Boolean(await which("pyright-langserver").catch(() => undefined))

  check(
    "formatLspDiagnostics empty",
    formatLspDiagnostics("a.ts", { server: "typescript", diagnostics: [], errors: 0 }) === "",
  )

  const formatted = formatLspDiagnostics("a.ts", {
    server: "typescript",
    diagnostics: [
      {
        file: "a.ts",
        line: 4,
        column: 7,
        message: "error 2322: Type 'number' is not assignable to type 'string'",
      },
    ],
    errors: 1,
  })
  check("formatLspDiagnostics header", formatted.includes("LSP (typescript) diagnostics for a.ts"))
  check("formatLspDiagnostics location", formatted.includes("a.ts:4:7: error 2322"))
  check("formatLspDiagnostics fix note", formatted.includes("Fix these before moving on"))

  const savedLsp = process.env.MCODE_LSP
  try {
    process.env.MCODE_LSP = "0"
    check("MCODE_LSP=0 disables", (await lspDiagnostics("a.ts", os.tmpdir())) === undefined)
  } finally {
    await restoreEnv("MCODE_LSP", savedLsp)
  }

  const txtDir = await fs.mkdtemp(path.join(os.tmpdir(), "mcode-lsp-txt-"))
  const txtFile = path.join(txtDir, "a.txt")
  await fs.writeFile(txtFile, "hello\n", "utf8")
  check("unknown extension returns undefined", (await lspDiagnostics(txtFile, txtDir)) === undefined)

  if (!haveTs) {
    skip("typescript")
    skip("typescript")
    skip("typescript")
    skip("typescript")
  } else {
    const tsDir = await fs.mkdtemp(path.join(os.tmpdir(), "mcode-lsp-ts-"))
    await fs.writeFile(path.join(tsDir, "tsconfig.json"), TSCONFIG, "utf8")
    const tsFile = path.join(tsDir, "a.ts")
    await fs.writeFile(tsFile, TS_ERROR, "utf8")
    const context = await makeContext(tsDir)

    const firstStart = Date.now()
    const first = await lspDiagnostics(tsFile, tsDir, { timeoutMs: 12000 })
    const firstElapsed = Date.now() - firstStart
    check("TS diagnostics within 15s", first !== undefined && firstElapsed < 15000, { firstElapsed })
    check("TS server", first?.server === "typescript")
    check("TS errors", (first?.errors ?? 0) >= 1)
    check("TS diagnostic line 4", Boolean(first?.diagnostics.some((d) => d.line === 4)))
    check("TS diagnostic 2322", Boolean(first?.diagnostics.some((d) => d.line === 4 && d.message.includes("2322"))))

    await fs.writeFile(tsFile, TS_FIXED, "utf8")
    const secondStart = Date.now()
    const second = await lspDiagnostics(tsFile, tsDir, { timeoutMs: 2800 })
    const secondElapsed = Date.now() - secondStart
    check("TS fixed has no errors", second?.errors === 0)
    check("TS second call reuses client under 3s", secondElapsed < 3000, { secondElapsed })

    const fixedLines = (await fs.readFile(tsFile, "utf8")).split("\n")
    const callAddColumn = fixedLines[3]!.indexOf("add") + 1
    const definition = await lspRequest("definition", tsFile, 4, callAddColumn + 1, tsDir, { timeoutMs: 12000 })
    check("TS definition points to line 1", typeof definition === "string" && definition.includes("a.ts:1:"), definition)

    const declAddColumn = fixedLines[0]!.indexOf("add") + 1
    const hover = await lspRequest("hover", tsFile, 1, declAddColumn, tsDir, { timeoutMs: 12000 })
    check("TS hover shows function add", typeof hover === "string" && hover.includes("function add"), hover)

    const stat = await fs.stat(tsFile)
    const content = await fs.readFile(tsFile, "utf8")
    await (recordRead as unknown as (...args: unknown[]) => unknown)(context.sessionID, tsFile, stat, content)

    let editResult: Awaited<ReturnType<typeof EditTool.execute>> | undefined
    try {
      editResult = await EditTool.execute(
        {
          file_path: "a.ts",
          old_string: "const s: string = String(add(1, 2))",
          new_string: "const s: string = add(1, 2)",
        },
        context,
      )
    } catch (error) {
      check("EditTool execute", false, String(error))
    }

    if (editResult) {
      const metadata = editResult.metadata as Record<string, any>
      const lsp = metadata.lsp as Record<string, any> | undefined
      check("EditTool metadata has lsp", Boolean(lsp))
      check("EditTool lsp errors", Number(lsp?.errors ?? 0) >= 1)
      check("EditTool lsp diagnostic line is number", typeof lsp?.diagnostics?.[0]?.line === "number")

      const postProblems = Number((metadata.postEditCheck as Record<string, any> | undefined)?.problems ?? 0)
      check(
        "EditTool output mentions LSP when post-edit check is clean",
        postProblems > 0 || editResult.output.includes("LSP (typescript) diagnostics"),
        { postProblems, output: editResult.output },
      )
    }

    await fs.writeFile(tsFile, TS_ERROR, "utf8")

    let lspToolResult: Awaited<ReturnType<typeof LspTool.execute>> | undefined
    try {
      lspToolResult = await LspTool.execute({ action: "diagnostics", file_path: "a.ts" }, context)
    } catch (error) {
      check("LspTool diagnostics execute", false, String(error))
    }
    check(
      "LspTool diagnostics output",
      Boolean(lspToolResult && (lspToolResult.output.includes("2322") || lspToolResult.output.includes("error"))),
      lspToolResult?.output,
    )

    let hoverRejected = false
    try {
      await LspTool.execute({ action: "hover", file_path: "a.ts" }, context)
    } catch (error) {
      hoverRejected = error instanceof ToolError
    }
    check("LspTool hover without position rejects", hoverRejected)
  }

  if (!havePy) {
    skip("python")
  } else {
    const pyDir = await fs.mkdtemp(path.join(os.tmpdir(), "mcode-lsp-py-"))
    await fs.writeFile(path.join(pyDir, "pyproject.toml"), "[project]\nname = \"fixture\"\nversion = \"0.0.0\"\n", "utf8")
    const pyFile = path.join(pyDir, "m.py")
    await fs.writeFile(pyFile, PY_ERROR, "utf8")

    const py = await lspDiagnostics(pyFile, pyDir, { timeoutMs: 12000 })
    check("Python server", py?.server === "python")
    check("Python errors", (py?.errors ?? 0) >= 1)
    check("Python diagnostic line 4", Boolean(py?.diagnostics.some((d) => d.line === 4)))
  }

  const missingDir = await fs.mkdtemp(path.join(os.tmpdir(), "mcode-lsp-missing-"))
  await fs.writeFile(path.join(missingDir, "tsconfig.json"), TSCONFIG, "utf8")
  const missingFile = path.join(missingDir, "a.ts")
  await fs.writeFile(missingFile, TS_ERROR, "utf8")

  const emptyPathDir = await fs.mkdtemp(path.join(os.tmpdir(), "mcode-lsp-empty-path-"))
  const savedPath = process.env.PATH
  try {
    process.env.PATH = emptyPathDir
    const missingStart = Date.now()
    const missing = await lspDiagnostics(missingFile, missingDir, { timeoutMs: 2000 })
    const missingElapsed = Date.now() - missingStart
    check("missing server path is graceful under 3s", missing === undefined && missingElapsed < 3000, { missingElapsed })
  } finally {
    await restoreEnv("PATH", savedPath)
  }

  await shutdownLsp().catch(() => undefined)

  console.log(`${passed} passed / ${failed} failed`)
  if (failed) process.exit(1)
}

void main().catch(async (error) => {
  console.error(error)
  await shutdownLsp().catch(() => undefined)
  console.log(`${passed} passed / ${failed + 1} failed`)
  process.exit(1)
})
