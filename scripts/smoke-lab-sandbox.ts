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
import * as os from "node:os"
import * as path from "node:path"
import { promises as fs } from "node:fs"
import { runSandboxed, sandboxCommand } from "../src/server/lab-sandbox"

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

  /*
   * Everything above reads argv, and a perfectly spelled mount plan can still fail to behave. This
   * runs the production sandbox and observes what the dependency mount actually is. Where
   * bubblewrap is missing the case reports the gap instead of passing quietly — but only on Linux,
   * where it ought to have run.
   */
  const { spawnSync } = await import("node:child_process")
  const bwrap = spawnSync("bwrap", ["--version"], { encoding: "utf8" })
  if (bwrap.status !== 0) {
    check("the runtime mount probe ran or the platform cannot host it", process.platform !== "linux", `bubblewrap missing on Linux: ${(bwrap.stderr ?? bwrap.error?.message ?? "not installed").slice(0, 120)}`)
    return
  }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "lab-sandbox-"))
  const worktree = path.join(root, "work-tree")
  const dependencies = path.join(root, "project", "node_modules")
  await fs.mkdir(path.join(worktree, "node_modules"), { recursive: true })
  await fs.mkdir(dependencies, { recursive: true })
  await fs.writeFile(path.join(worktree, ".git"), "gitdir: /nonexistent\n")
  await fs.writeFile(path.join(dependencies, "marker.txt"), "dep-marker")
  try {
    const script = [
      "test -L /work/node_modules && echo KIND_SYMLINK || echo KIND_NOT_SYMLINK",
      "(echo hacked > /work/node_modules/pwned) 2>/dev/null; echo WRITE_RC=$?",
      "cat /work/node_modules/marker.txt",
    ].join("\n")
    const run = await runSandboxed(worktree, dependencies, "/bin/sh", ["-c", script], new AbortController().signal)
    check("inside the sandbox the dependency mount is a real directory", run.output.includes("KIND_NOT_SYMLINK"), run.output.slice(0, 200))
    check("inside the sandbox the dependency mount refuses writes", /WRITE_RC=[1-9]/.test(run.output), run.output.slice(0, 200))
    check("the dependency mount can be read from the project", run.output.includes("dep-marker"), run.output.slice(0, 200))
    const escaped = await fs.readFile(path.join(dependencies, "pwned"), "utf8").then(() => true, () => false)
    check("nothing escapes the mount onto the host's dependencies", !escaped, "a file written inside the sandbox appeared in the project's node_modules")
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
}
