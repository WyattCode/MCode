import { spawn } from "node:child_process"
import fs from "node:fs/promises"
import path from "node:path"
import { killTree } from "./kill-tree"

export function sandboxCommand(platform: NodeJS.Platform, worker: string, dependencies: string, command: string, args: string[]): string[] {
  if (platform !== "linux") throw Error("Lab sandbox requires Linux with bubblewrap and user namespaces")
  return [
    "--unshare-all", "--unshare-user", "--disable-userns", "--cap-drop", "ALL", "--die-with-parent", "--new-session",
    "--clearenv", "--setenv", "PATH", "/usr/local/bin:/usr/bin:/bin:/deps/.bin",
    "--setenv", "HOME", "/tmp/home", "--setenv", "TMPDIR", "/tmp",
    "--setenv", "GIT_CONFIG_NOSYSTEM", "1", "--setenv", "GIT_CONFIG_GLOBAL", "/dev/null",
    "--setenv", "GIT_ALLOW_PROTOCOL", "", "--setenv", "GIT_TERMINAL_PROMPT", "0",
    "--setenv", "CI", "1", "--setenv", "ELECTRON_RUN_AS_NODE", "1",
    "--dev", "/dev", "--proc", "/proc", "--tmpfs", "/tmp", "--dir", "/tmp/home",
    "--ro-bind", "/usr", "/usr", "--ro-bind-try", "/bin", "/bin",
    "--ro-bind-try", "/lib", "/lib", "--ro-bind-try", "/lib64", "/lib64",
    "--ro-bind-try", "/etc/ld.so.cache", "/etc/ld.so.cache",
    "--ro-bind", dependencies, "/deps", "--ro-bind", worker, "/work",
    /*
     * Dependencies are mounted a second time, inside the project, because Node looks for a
     * package's siblings by walking up from that package for a `node_modules` directory:
     * mounted only at /deps, `import 'vue'` resolves and `import '@vue/runtime-dom'` from
     * inside vue does not, since /deps/node_modules is a path that never exists. Measured on
     * Linux with this exact sandbox — the plain repository layout loads vue (172 exports),
     * the /deps layout fails with MODULE_NOT_FOUND, and every acceptance test and gate the Lab
     * runs imports through a package.
     */
    "--ro-bind", dependencies, "/work/node_modules",
    "--ro-bind", "/dev/null", "/work/.git", "--tmpfs", "/work/out",
    "--chdir", "/work", "--", command, ...args,
  ]
}

export interface SandboxResult {
  code: number | null
  output: string
}

export async function runSandboxed(worker: string, dependencies: string, command: string, args: string[], signal: AbortSignal): Promise<SandboxResult> {
  const options = sandboxCommand(process.platform, worker, dependencies, command, args)
  signal.throwIfAborted()
  // Each check gets its own output directory, so it cannot replace a later
  // check's executable. The source checkout and dependency mount stay read-only.
  const outputDirectory = path.join(worker, "out")
  await fs.mkdir(outputDirectory, { recursive: true })
  if (!(await fs.lstat(outputDirectory)).isDirectory()) throw Error("Lab sandbox output path is not a directory")
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const child = spawn("bwrap", options, { stdio: ["ignore", "pipe", "pipe"], detached: true })
    let output = ""
    const capture = (data: Buffer) => { output = (output + data.toString()).slice(-4000) }
    child.stdout.on("data", capture)
    child.stderr.on("data", capture)
    const stop = () => killTree(child)
    const timeout = setTimeout(stop, 180_000)
    signal.addEventListener("abort", stop, { once: true })
    if (signal.aborted) stop()
    child.once("error", (error) => {
      reject(Error(`Lab sandbox could not start: ${error.message}`))
    })
    child.once("close", (code) => {
      clearTimeout(timeout)
      signal.removeEventListener("abort", stop)
      if (signal.aborted) reject(signal.reason)
      else resolve({ code, output })
    })
  })
}
