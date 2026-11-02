/**
 * Focused checks for P0-2: post-edit checks run after edit/write, report the
 * right checker, respect the disable switch, and do not break the tool when a
 * checker is missing or slow.
 *
 * Run on its own: `npx tsx scripts/smoke-p0-post-edit-check.ts`.
 */
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { EditTool } from "../src/server/tool/edit"
import { recordRead } from "../src/server/tool/read-tracker"
import { postEditCheck, postEditCheckDetailed, runWithTimeout, timeoutResult, which } from "../src/server/tool/post-edit-check"

let passed = 0
let failed = 0
let currentScenario = "startup"

function check(name: string, condition: boolean, detail?: unknown) {
  if (condition) {
    passed++
    console.log(`  ok   ${name}`)
  } else {
    failed++
    console.log(`  FAIL ${name}${detail === undefined ? "" : ` -> ${JSON.stringify(detail)}`}`)
  }
}

function okNote(name: string, note: string) {
  passed++
  console.log(`  ok   ${name} (${note})`)
}

function failUnexpected(name: string, error: unknown) {
  failed++
  const message = error instanceof Error ? error.message : String(error)
  console.log(`  FAIL ${name} -> unexpected exception: ${message}`)
}

async function tempDir(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "mcode-smoke-p0-check-"))
}

function context(directory: string, sessionID: string): any {
  return {
    sessionID,
    messageID: "m1",
    callID: "c1",
    directory,
    permissions: { ask: async () => {} },
    questions: {},
    signal: new AbortController().signal,
    progress: () => {},
    snapshot: async () => {},
    plan: undefined,
    agent: "build",
  }
}

async function exists(candidate: string): Promise<boolean> {
  try {
    await fs.access(candidate)
    return true
  } catch {
    return false
  }
}

async function main(): Promise<void> {
  const previousEnv = {
    disable: process.env.MCODE_POST_EDIT_CHECK,
    node: process.env.MCODE_NODE,
  }

  try {
    delete process.env.MCODE_POST_EDIT_CHECK
    const scriptDir = path.dirname(fileURLToPath(import.meta.url))
    const repoRoot = path.resolve(scriptDir, "..")
    const repoTypescript = path.join(repoRoot, "node_modules", "typescript")

    // JS syntax error reported via node --check.
    currentScenario = "js syntax error"
    try {
      const root = await tempDir()
      const file = path.join(root, "bad.js")
      await fs.writeFile(file, "const x = (\n", "utf8")
      const result = await postEditCheckDetailed(file, root)
      check("js syntax error checker", result?.checker === "node --check", result)
      check("js syntax error reported", result?.text.includes("Post-edit check (node --check): 1 problem(s) in bad.js") === true, result?.text)
      check("js syntax error has detail", /SyntaxError|Unexpected end of input|Unexpected token/.test(result?.text ?? ""), result?.text)
    } catch (error) {
      failUnexpected("js syntax error", error)
    }

    // Valid JS -> no problems.
    currentScenario = "valid js"
    try {
      const root = await tempDir()
      const file = path.join(root, "good.js")
      await fs.writeFile(file, "const x = 1\n", "utf8")
      const result = await postEditCheckDetailed(file, root)
      check("valid js checker", result?.checker === "node --check", result)
      check("valid js no problems", result?.text === "\n\nPost-edit check (node --check): no problems in good.js.", result?.text)
    } catch (error) {
      failUnexpected("valid js", error)
    }

    // JSON parse error.
    currentScenario = "json parse error"
    try {
      const root = await tempDir()
      const file = path.join(root, "bad.json")
      await fs.writeFile(file, "{ \"a\": 1, }\n", "utf8")
      const result = await postEditCheckDetailed(file, root)
      check("json checker", result?.checker === "json", result)
      check("json parse error reported", result?.text.includes("Post-edit check (json): 1 problem(s) in bad.json") === true, result?.text)
      check("json parse error message", /JSON|Unexpected|Expected/i.test(result?.text ?? ""), result?.text)
    } catch (error) {
      failUnexpected("json parse error", error)
    }

    // Python syntax error via py_compile, if python is available.
    currentScenario = "python syntax error"
    try {
      const python = (await which("python3")) ?? (await which("python"))
      const ruff = await whichForSmoke("ruff")
      const pyright = await whichForSmoke("pyright")

      if (!python && !ruff && !pyright) {
        okNote("python syntax error", "no python/ruff/pyright on PATH")
      } else {
        const root = await tempDir()
        const file = path.join(root, "bad.py")
        await fs.writeFile(file, "def f(:\n", "utf8")
        const result = await postEditCheckDetailed(file, root)

        if (ruff || pyright) {
          check(
            "python syntax error reported by available checker",
            result?.problems === 1 && /SyntaxError|invalid syntax|expected|error/i.test(result?.text ?? ""),
            result,
          )
        } else {
          check("python checker is py_compile when ruff/pyright absent", result?.checker === "py_compile", result)
          check("python syntax error reported", result?.text.includes("Post-edit check (py_compile): 1 problem(s) in bad.py") === true, result?.text)
          check("python syntax error has detail", /SyntaxError|invalid syntax|expected/i.test(result?.text ?? ""), result?.text)
        }
      }
    } catch (error) {
      failUnexpected("python syntax error", error)
    }

    // TypeScript project with local typescript symlink.
    currentScenario = "typescript project"
    try {
      if (!await exists(repoTypescript)) {
        okNote("typescript project", "repo node_modules/typescript missing")
      } else {
        const root = await tempDir()
        await fs.mkdir(path.join(root, "node_modules"), { recursive: true })
        await fs.symlink(repoTypescript, path.join(root, "node_modules", "typescript"), "junction")
        await fs.writeFile(path.join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true, noEmit: true } }, null, 2) + "\n", "utf8")
        await fs.writeFile(path.join(root, "a.ts"), "const x: number = \"nope\"\n", "utf8")
        await fs.writeFile(path.join(root, "b.ts"), "const y: number = \"also nope\"\n", "utf8")

        const result = await postEditCheckDetailed(path.join(root, "a.ts"), root, undefined, true)
        check("ts checker", result?.checker === "tsc", result)
        check("ts edited file problem reported", result?.text.includes("Post-edit check (tsc): 1 problem(s) in a.ts") === true, result?.text)
        check("ts edited file line number", /a\.ts:1:\d+:error TS\d+:/.test(result?.text ?? ""), result?.text)
        check("ts other file counted", /\+1 errors in other files/.test(result?.text ?? ""), result?.text)
        check("ts other file example", /b\.ts:1:\d+:error TS\d+:/.test(result?.text ?? ""), result?.text)
      }
    } catch (error) {
      failUnexpected("typescript project", error)
    }

    // TypeScript project check is skipped when project tools are not allowed.
    currentScenario = "typescript project skipped"
    try {
      const root = await tempDir()
      await fs.writeFile(path.join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true, noEmit: true } }, null, 2) + "\n", "utf8")
      await fs.writeFile(path.join(root, "a.ts"), "const x: number = \"nope\"\n", "utf8")

      if (await exists(repoTypescript)) {
        await fs.mkdir(path.join(root, "node_modules"), { recursive: true })
        await fs.symlink(repoTypescript, path.join(root, "node_modules", "typescript"), "junction")
      }

      const result = await postEditCheckDetailed(path.join(root, "a.ts"), root, undefined, false)
      check("ts skipped when allowProjectTools is false", result === undefined, result)
    } catch (error) {
      failUnexpected("typescript project skipped", error)
    }

    // Disabled by environment.
    currentScenario = "disabled"
    try {
      process.env.MCODE_POST_EDIT_CHECK = "0"
      const root = await tempDir()
      const file = path.join(root, "bad.js")
      await fs.writeFile(file, "const x = (\n", "utf8")
      const result = await postEditCheck(file, root)
      check("disabled returns undefined", result === undefined, result)
    } catch (error) {
      failUnexpected("disabled", error)
    } finally {
      if (previousEnv.disable === undefined) delete process.env.MCODE_POST_EDIT_CHECK
      else process.env.MCODE_POST_EDIT_CHECK = previousEnv.disable
    }

    // Unknown extension.
    currentScenario = "unknown extension"
    try {
      const root = await tempDir()
      const file = path.join(root, "note.md")
      await fs.writeFile(file, "# hi\n", "utf8")
      const result = await postEditCheck(file, root)
      check("unknown extension returns undefined", result === undefined, result)
    } catch (error) {
      failUnexpected("unknown extension", error)
    }

    // Timeout helper.
    currentScenario = "timeout helper"
    try {
      const run = await runWithTimeout(process.env.MCODE_NODE || "node", ["-e", "setTimeout(() => {}, 5000)"], 300)
      check("timeout helper times out", run.timedOut === true, run)
    } catch (error) {
      failUnexpected("timeout helper", error)
    }

    // Timeout text.
    currentScenario = "timeout text"
    try {
      const result = timeoutResult("node --check", "bad.js", 10)
      check("timeout text exact", result.text === "\n\nPost-edit check (node --check): timed out after 10s; result unknown.", result.text)
      check("timeout problems zero", result.problems === 0, result)
      check("timeout status", result.status === "timeout", result)
    } catch (error) {
      failUnexpected("timeout text", error)
    }

    // EditTool output ends with post-edit check text.
    currentScenario = "edit tool appends check"
    try {
      const root = await tempDir()
      const file = path.join(root, "bad.js")
      await fs.writeFile(file, "const x = 1\n", "utf8")
      const stamp = await fs.stat(file)
      await recordRead("s1", file, { mtimeMs: stamp.mtimeMs, size: stamp.size }, "const x = 1\n")
      const result = await EditTool.execute({ file_path: "bad.js", old_string: "const x = 1", new_string: "const x = (" }, context(root, "s1"))
      check("edit output has post-edit check", result.output.includes("Post-edit check (node --check): 1 problem(s) in bad.js"), result.output)
      check("edit metadata has checker", result.metadata?.postEditCheck?.checker === "node --check", result.metadata)
      check("edit metadata has problems", result.metadata?.postEditCheck?.problems === 1, result.metadata)
      check("edit output has Re-run", result.output.includes("Re-run:"), result.output)

      const diagnostics = result.metadata?.postEditCheck?.diagnostics
      check("edit metadata has diagnostics array", Array.isArray(diagnostics) && diagnostics.length >= 1, diagnostics)
      check(
        "edit diagnostics have file and message",
        Array.isArray(diagnostics) && diagnostics.every((d: any) => typeof d?.file === "string" && typeof d?.message === "string"),
        diagnostics,
      )

      const rerunHint = result.metadata?.postEditCheck?.rerunHint
      check("edit metadata has non-empty rerunHint", typeof rerunHint === "string" && rerunHint.length > 0, result.metadata)
    } catch (error) {
      failUnexpected("edit tool appends check", error)
    }
  } catch (error) {
    failUnexpected(currentScenario, error)
  } finally {
    if (previousEnv.disable === undefined) delete process.env.MCODE_POST_EDIT_CHECK
    else process.env.MCODE_POST_EDIT_CHECK = previousEnv.disable
    if (previousEnv.node === undefined) delete process.env.MCODE_NODE
    else process.env.MCODE_NODE = previousEnv.node
    console.log(`\n${passed} passed, ${failed} failed`)
    process.exit(failed === 0 ? 0 : 1)
  }
}

async function whichForSmoke(command: string): Promise<string | undefined> {
  if (command.includes("/") || command.includes("\\")) return await exists(command) ? command : undefined

  const separator = process.platform === "win32" ? ";" : ":"
  const dirs = (process.env.PATH ?? "").split(separator).filter(Boolean)
  const extensions = process.platform === "win32"
    ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean)
    : [""]

  for (const dir of dirs) {
    for (const extension of extensions) {
      const candidate = path.join(dir, command + extension)
      if (await exists(candidate)) return candidate
    }
  }

  return undefined
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
