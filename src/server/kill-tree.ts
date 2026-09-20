import { spawn, type ChildProcess } from "node:child_process"

/**
 * Ends a child and everything it started.
 *
 * A process that has launched another is the ordinary case for one that has to
 * be interrupted - a shell running a server, and on Windows the `cmd.exe` a
 * `.cmd` server is started through - and signalling the child alone leaves that
 * server running. Windows offers no process groups, so its tree is walked by
 * taskkill; elsewhere the child leads a group that can be signalled as a whole.
 *
 * Failures are swallowed on purpose: by the time this runs the process may have
 * exited on its own, and there is nothing useful to say about that.
 */
export function killTree(child: ChildProcess): void {
  if (!child.pid) return
  if (process.platform === "win32") {
    try {
      spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true }).on("error", () => child.kill("SIGKILL"))
    } catch {
      child.kill("SIGKILL")
    }
    return
  }
  try {
    process.kill(-child.pid, "SIGKILL")
  } catch {
    child.kill("SIGKILL")
  }
}
