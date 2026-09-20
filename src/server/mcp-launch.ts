import { execFile, type ChildProcess } from "node:child_process"
import { killTree } from "./kill-tree"

/** How long a stopping server gets after its input closes, and again after it is asked to terminate. */
export const STOP_GRACE_MS = 2_000

/** A process's children and theirs, found with pgrep; none on Windows, as in MiMo. */
async function descendants(pid: number): Promise<number[]> {
  if (process.platform === "win32") return []
  const found: number[] = []
  const queue = [pid]
  while (queue.length) {
    const current = queue.shift()!
    const text = await new Promise<string>((resolve) => execFile("pgrep", ["-P", String(current)], (_error, stdout) => resolve(String(stdout ?? ""))))
    for (const token of text.split("\n")) {
      const child = Number.parseInt(token, 10)
      if (Number.isInteger(child) && !found.includes(child)) {
        found.push(child)
        queue.push(child)
      }
    }
  }
  return found
}

/**
 * Stops a local server the way MiMo's stdio transport does: its children are
 * asked to terminate (not on Windows), its input is closed so a well-behaved
 * server can finish, and only if it is still running two seconds later is it
 * asked to terminate, and two seconds after that killed.
 *
 * On Windows that second step ends the tree rather than the process. A `.cmd`
 * or `.bat` server - npx and most published ones - runs under a `cmd.exe` this
 * launches, and `kill()` there is a TerminateProcess on `cmd.exe` alone: the
 * shell really did exit, so stopping looked done, while the server itself kept
 * its ports, its file locks and its memory with no window left to stop it.
 */
export async function terminate(child: ChildProcess, grace = STOP_GRACE_MS): Promise<void> {
  const running = () => child.exitCode === null && child.signalCode === null
  if (!running()) return
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()))
  if (child.pid !== undefined) {
    for (const pid of await descendants(child.pid).catch(() => [])) {
      try {
        process.kill(pid, "SIGTERM")
      } catch {
        // Already gone.
      }
    }
  }
  const within = (ms: number) => Promise.race([exited.then(() => true), new Promise<boolean>((resolve) => setTimeout(() => resolve(false), ms).unref())])
  child.stdin?.end()
  if (await within(grace)) return
  if (process.platform === "win32") {
    killTree(child)
    await within(grace)
    return
  }
  child.kill("SIGTERM")
  if (await within(grace)) return
  child.kill("SIGKILL")
}

/**
 * How to start a command on this platform.
 *
 * Windows cannot exec a .cmd or .bat directly - npx and most published servers
 * are exactly that - so those go through cmd.exe. What it must not do is hand
 * the shell a concatenated string: this project lives under a path with a
 * space in it, and unquoted arguments would cut the path in half. Each part is
 * quoted here and passed verbatim, so the shell does no splitting of its own.
 */
export function windowsLaunch(command: string, args: string[]) {
  if (process.platform !== "win32" || !/\.(cmd|bat)$/i.test(command)) {
    return { command, args, verbatim: false }
  }
  const quote = (value: string) => `"${value.replace(/"/g, '\\"')}"`
  const line = [command, ...args].map(quote).join(" ")
  return { command: "cmd.exe", args: ["/d", "/s", "/c", `"${line}"`], verbatim: true }
}
