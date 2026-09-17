import path from "node:path"
import { statSync } from "node:fs"

/**
 * Finding shells on this machine, shared by the terminal drawer and the bash
 * tool so the two agree on which PowerShell and which git bash there are.
 */

/** The first match for a command on PATH, or undefined. A name that already has an extension is tried as written first. */
export function which(command: string): string | undefined {
  const dirs = (process.env.PATH ?? process.env.Path ?? "").split(path.delimiter).filter(Boolean)
  const suffixes = process.platform === "win32" ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";").filter(Boolean) : []
  const names = process.platform === "win32" ? [...(path.extname(command) ? [command] : []), ...suffixes.map((suffix) => command + suffix)] : [command]
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = path.join(dir, name)
      if (statSync(candidate, { throwIfNoEntry: false })?.isFile()) return candidate
    }
  }
  return undefined
}

/**
 * git's bundled bash, found by walking up from git itself.
 *
 * The reference goes exactly two directories up and looks in bin/, which holds
 * for the usual install because PATH gets `<root>/cmd/git.exe`. It does not
 * hold when git is found somewhere else in the same install: on this machine
 * PATH carries `<root>/mingw64/bin/git.exe` too, and two up from there is
 * `<root>/mingw64/bin/bash.exe`, which does not exist - so the shell silently
 * became cmd. Walking up until a bin/bash.exe turns up finds the same file
 * from either entry point and stops at the drive root.
 */
export function gitBash(): string | undefined {
  if (process.platform !== "win32") return undefined
  const git = which("git")
  if (!git) return undefined
  let dir = path.dirname(git)
  for (let up = 0; up < 4; up += 1) {
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
    const bash = path.join(dir, "bin", "bash.exe")
    if (statSync(bash, { throwIfNoEntry: false })?.size) return bash
  }
  return undefined
}

/**
 * The shell used when nothing names one, as MiMo's engine picks it: the newer
 * PowerShell first on Windows, then Windows PowerShell, git's bash and
 * COMSPEC; zsh on macOS, which every Mac has; on Linux bash from PATH, since
 * some systems have no /bin/bash, and /bin/sh when there is none.
 */
export function platformShell(platform: NodeJS.Platform = process.platform): string {
  if (platform === "win32") return which("pwsh.exe") ?? which("powershell.exe") ?? gitBash() ?? process.env.COMSPEC ?? "cmd.exe"
  if (platform === "darwin") return "/bin/zsh"
  return which("bash") ?? "/bin/sh"
}

/**
 * A POSIX-style path as Windows spells it: `/c/…`, `/c:/…`, `/cygdrive/c/…`
 * and `/mnt/c/…` all name drive C. Anything else, and any path off Windows, is
 * returned as it was.
 */
export function windowsPath(text: string): string {
  if (process.platform !== "win32") return text
  const drive = (_whole: string, letter: string) => `${letter.toUpperCase()}:/`
  return text
    .replace(/^\/([a-zA-Z]):(?:[\\/]|$)/, drive)
    .replace(/^\/([a-zA-Z])(?:\/|$)/, drive)
    .replace(/^\/cygdrive\/([a-zA-Z])(?:\/|$)/, drive)
    .replace(/^\/mnt\/([a-zA-Z])(?:\/|$)/, drive)
}
