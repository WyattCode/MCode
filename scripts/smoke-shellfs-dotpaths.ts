import "./fenced-home"
import os from "node:os"
import path from "node:path"
import fs from "node:fs/promises"
import { scanCommand } from "../src/server/tool/bash-scan"
import { insideReal, resolveInside, resolvePath } from "../src/server/tool/fs-util"
import type { ToolContext } from "../src/server/tool/types"

function check(name: string, ok: boolean) {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}`)
  if (!ok) process.exitCode = 1
}

async function main() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "mcode-shellfs-dotpaths-"))
  try {
    const project = path.join(directory, "project")
    const cache = path.join(project, "..cache")
    await fs.mkdir(cache, { recursive: true })
    const accepts = (target: string) => {
      try { return resolveInside(project, target) === path.resolve(project, target) } catch { return false }
    }
    let asked = false
    const context = {
      directory: project,
      permissions: { allowsOutside: () => false, ask: async () => { asked = true } },
    } as unknown as ToolContext
    check("Lexical containment accepts ..cache", accepts("..cache"))
    check("Real containment accepts ..cache", await insideReal(project, cache))
    check("Path resolution accepts ..cache without outside approval", await resolvePath(context, "..cache") === cache && !asked)
    check("Shell scan keeps ..cache inside the project", (await scanCommand("ls ..cache", project, project, false)).dirs.length === 0)
    check("Parent directory remains outside", !accepts("..") && !await insideReal(project, directory))
    check("Sibling directory remains outside", !accepts("../sibling") && !await insideReal(project, path.join(directory, "sibling")))
    if (process.platform !== "win32") {
      check("Backslash also marks a parent prefix", !accepts("..\\sibling"))
    }
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
