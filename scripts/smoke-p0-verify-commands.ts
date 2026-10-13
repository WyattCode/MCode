/**
 * Focused checks for P0 verify-command discovery and hardened tsc lookup.
 *
 * Run on its own: `npx tsx scripts/smoke-p0-verify-commands.ts`.
 */
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { findTsc, postEditCheckDetailed } from "../src/server/tool/post-edit-check"
import { discoverVerifyCommands, loadVerifyCommands } from "../src/server/tool/verify-commands"

let passed = 0
let failed = 0
let currentScenario = "startup"

function check(name: string, condition: boolean, detail?: unknown): void {
  if (condition) {
    passed++
    console.log(`  ok   ${name}`)
  } else {
    failed++
    console.log(`  FAIL ${name}${detail === undefined ? "" : ` -> ${JSON.stringify(detail)}`}`)
  }
}

function failUnexpected(name: string, error: unknown): void {
  failed++
  const message = error instanceof Error ? error.message : String(error)
  console.log(`  FAIL ${name} -> unexpected exception: ${message}`)
}

async function tempDir(prefix: string): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), `mcode-smoke-${prefix}-`))
}

async function exists(candidate: string): Promise<boolean> {
  try {
    await fs.access(candidate)
    return true
  } catch {
    return false
  }
}

async function writeFile(file: string, text: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, text, "utf8")
}

function fakeTscScript(message: string): string {
  return `
const message = ${JSON.stringify(message)}
process.stdout.write(message + "\\n")
process.exit(2)
`
}

async function main(): Promise<void> {
  const previousNode = process.env.MCODE_NODE
  const previousDisable = process.env.MCODE_POST_EDIT_CHECK

  try {
    delete process.env.MCODE_POST_EDIT_CHECK
    process.env.MCODE_NODE = process.execPath

    currentScenario = "discover typecheck preferred"
    try {
      const commands = discoverVerifyCommands({
        packageScripts: {
          build: "vite build",
          lint: "eslint .",
          test: "vitest run",
          typecheck: "tsc --noEmit",
        },
        packageManager: "pnpm",
      })
      check("typecheck first", commands[0] === "pnpm run typecheck", commands)
      check("lint second", commands[1] === "pnpm run lint", commands)
      check("test third", commands[2] === "pnpm run test", commands)
      check("build last", commands[3] === "pnpm run build", commands)
    } catch (error) {
      failUnexpected("discover typecheck preferred", error)
    }

    currentScenario = "discover ignores low-signal test scripts when test exists"
    try {
      const commands = discoverVerifyCommands({
        packageScripts: {
          test: "vitest run",
          "test:e2e": "playwright test",
          "test:watch": "vitest",
        },
      })
      check("plain test only", commands.length === 1 && commands[0] === "npm run test", commands)
    } catch (error) {
      failUnexpected("discover ignores low-signal test scripts when test exists", error)
    }

    currentScenario = "discover uses low-signal test scripts only when no better test exists"
    try {
      const commands = discoverVerifyCommands({
        packageScripts: {
          "test:e2e": "playwright test",
          "test:watch": "vitest",
        },
      })
      check("falls back to first test-like script", commands.length === 1 && commands[0] === "npm run test:e2e", commands)
    } catch (error) {
      failUnexpected("discover uses low-signal test scripts only when no better test exists", error)
    }

    currentScenario = "discover caps commands"
    try {
      const commands = discoverVerifyCommands({
        packageScripts: {
          typecheck: "tsc --noEmit",
          lint: "eslint .",
          test: "vitest run",
          check: "node scripts/check.js",
          build: "vite build",
        },
      })
      check("cap four commands", commands.length === 4, commands)
      check("cap order", commands.join(",") === "npm run typecheck,npm run lint,npm run test,npm run check", commands)
    } catch (error) {
      failUnexpected("discover caps commands", error)
    }

    currentScenario = "discover agents commands"
    try {
      const commands = discoverVerifyCommands({
        packageScripts: {
          lint: "eslint .",
        },
        agentsMd: [
          "Use `npm run typecheck` before committing.",
          "Run `pytest -q` for Python changes.",
          "Do not run `npm run lint` twice.",
        ].join("\n"),
      })
      check("agents typecheck added", commands.includes("npm run typecheck"), commands)
      check("agents pytest added", commands.includes("pytest -q"), commands)
      check("agents lint deduped", commands.filter((command) => command === "npm run lint").length === 1, commands)
      check("agents cap two", commands.length <= 3, commands)
    } catch (error) {
      failUnexpected("discover agents commands", error)
    }

    currentScenario = "load verify commands"
    try {
      const root = await tempDir("load-verify")
      await writeFile(path.join(root, "package.json"), JSON.stringify({
        scripts: {
          typecheck: "tsc --noEmit",
          test: "vitest run",
        },
      }, null, 2))
      await writeFile(path.join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n")
      await writeFile(path.join(root, "AGENTS.md"), "Run `pnpm run lint` after edits.\n")

      const commands = await loadVerifyCommands(root)
      check("load detects pnpm", commands[0] === "pnpm run typecheck", commands)
      check("load includes test", commands.includes("pnpm run test"), commands)
      check("load includes agents lint", commands.includes("pnpm run lint"), commands)
    } catch (error) {
      failUnexpected("load verify commands", error)
    }

    currentScenario = "findTsc bin path"
    try {
      const root = await tempDir("find-tsc-bin")
      const tsconfig = path.join(root, "tsconfig.json")
      await writeFile(tsconfig, "{}\n")
      const bin = path.join(root, "node_modules", "typescript", "bin", "tsc")
      await writeFile(bin, "#!/usr/bin/env node\n")
      await fs.chmod(bin, 0o755)

      const found = await findTsc(tsconfig, root)
      check("findTsc returns bin/tsc", found === bin, found)
    } catch (error) {
      failUnexpected("findTsc bin path", error)
    }

    currentScenario = "findTsc lib path"
    try {
      const root = await tempDir("find-tsc-lib")
      const tsconfig = path.join(root, "tsconfig.json")
      await writeFile(tsconfig, "{}\n")
      const lib = path.join(root, "node_modules", "typescript", "lib", "tsc.js")
      await writeFile(lib, "console.log('ok')\n")

      const found = await findTsc(tsconfig, root)
      check("findTsc returns lib/tsc.js", found === lib, found)
    } catch (error) {
      failUnexpected("findTsc lib path", error)
    }

    currentScenario = "post-edit fake tsc lib"
    try {
      const root = await tempDir("fake-tsc")
      const file = path.join(root, "a.ts")
      await writeFile(path.join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true, noEmit: true } }, null, 2) + "\n")
      await writeFile(file, "const x: number = \"nope\"\n")
      await writeFile(path.join(root, "node_modules", "typescript", "lib", "tsc.js"), fakeTscScript("a.ts(1,7): error TS2322: Type 'string' is not assignable to type 'number'."))

      const result = await postEditCheckDetailed(file, root, undefined, true)
      check("fake tsc checker", result?.checker === "tsc", result)
      check("fake tsc problem reported", result?.text.includes("Post-edit check (tsc): 1 problem(s) in a.ts") === true, result?.text)
      check("fake tsc diagnostic", /a\.ts:1:7:error TS2322:/.test(result?.text ?? ""), result?.text)
      check("fake tsc rerun hint", result?.rerunHint === "npx tsc -p tsconfig.json --noEmit", result?.rerunHint)
    } catch (error) {
      failUnexpected("post-edit fake tsc lib", error)
    }

    currentScenario = "post-edit project checks appended"
    try {
      const root = await tempDir("project-checks")
      const file = path.join(root, "bad.js")
      await writeFile(file, "const x = (\n")
      await writeFile(path.join(root, "package.json"), JSON.stringify({
        scripts: {
          typecheck: "tsc --noEmit",
          test: "vitest run",
        },
      }, null, 2))

      const result = await postEditCheckDetailed(file, root)
      check("project checks appended", result?.text.includes("Project checks: npm run typecheck · npm run test") === true, result?.text)
      check("project checks before final sentence", (result?.text.indexOf("Project checks:") ?? -1) < (result?.text.indexOf("Fix these before moving on") ?? -1), result?.text)
    } catch (error) {
      failUnexpected("post-edit project checks appended", error)
    }
  } catch (error) {
    failUnexpected(currentScenario, error)
  } finally {
    if (previousNode === undefined) delete process.env.MCODE_NODE
    else process.env.MCODE_NODE = previousNode
    if (previousDisable === undefined) delete process.env.MCODE_POST_EDIT_CHECK
    else process.env.MCODE_POST_EDIT_CHECK = previousDisable
    console.log(`\n${passed} passed, ${failed} failed`)
    process.exit(failed === 0 ? 0 : 1)
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
