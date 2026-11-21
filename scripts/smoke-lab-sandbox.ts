/*
 * The sandbox binds the project's dependencies into the container. Where they are mounted
 * is not a detail: Node finds a package's siblings by walking up from the package looking
 * for a `node_modules` directory, so dependencies mounted at /deps can answer `import 'vue'`
 * but never `import '@vue/runtime-dom'` from inside vue — measured inside the Lab's own
 * bwrap on Linux, where the worktree layout failed with MODULE_NOT_FOUND while the plain
 * repository layout loaded vue fine. Mounting them at /work/node_modules is what makes the
 * walk-up work, and the acceptance tests and gates depend on it.
 */
import assert from "node:assert/strict"
import { sandboxCommand } from "../src/server/lab-sandbox"

type Check = (label: string, ok: boolean, detail?: unknown) => void

/** Read-only bind mounts at `target`, as consecutive argv triples (flag, host source, guest target). */
function mounts(argv: string[], target: string, source?: string): string[][] {
  const found: string[][] = []
  for (let at = 0; at + 2 < argv.length; at++) {
    if (!argv[at].startsWith("--ro-bind") || argv[at + 2] !== target) continue
    if (source && argv[at + 1] !== source) continue
    found.push(argv.slice(at, at + 3))
  }
  return found
}

export async function labSandboxChecks(check: Check) {
  const deps = "/project/node_modules"
  const worker = "/work-tree"
  const argv = sandboxCommand("linux", worker, deps, "node", ["--version"])

  check("deps are mounted at /work/node_modules", mounts(argv, "/work/node_modules", deps).length === 1, JSON.stringify(argv.filter((entry) => entry.includes("node_modules"))))
  check("the mount is read-only", argv.some((entry, at) => entry === "--ro-bind" && argv[at + 2] === "/work/node_modules"), "no read-only bind at that path")
  check("the worktree is still mounted at /work", argv.some((entry, at) => argv[at + 1] === worker && argv[at + 2] === "/work"))
  check("deps stay reachable as /deps for the tool PATH", mounts(argv, "/deps", deps).length === 1, JSON.stringify(argv.filter((entry) => entry === "/deps" || entry === deps)))
  check("nothing makes node_modules a symlink into /deps", !argv.includes("--symlink"), JSON.stringify(argv.filter((entry) => entry === "--symlink")))
  check("the deps' own binaries stay on PATH", /\/deps\/\.bin/.test(argv.join(" ")), argv.find((entry) => entry.startsWith("/usr/local/bin")))

  // The command is what bwrap runs, so a platform without a sandbox still refuses rather than running bare.
  let refused = ""
  try {
    sandboxCommand("darwin", worker, deps, "node", ["--version"])
  } catch (error) {
    refused = error instanceof Error ? error.message : String(error)
  }
  assert.ok(/Linux/i.test(refused), "a Mac run must refuse: " + refused)
  check("a non-Linux platform is refused", /bubblewrap|Linux/i.test(refused), refused)
}
