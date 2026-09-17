import { execFile } from "node:child_process"

/*
 * The system browser, for addresses that come from a remote server (an MCP
 * server's authorization endpoint, a vendor's sign-in page).
 *
 * The address is never put into a shell command line: `$(...)`, backticks and
 * `%VAR%` survive URL parsing, so a string handed to /bin/sh or cmd.exe would
 * run whatever the server wrote. The opener gets the address as one argument
 * instead, and only http and https are accepted - any other scheme can start
 * a program.
 */

/** The address to open, normalised, or undefined when it is not a web page. */
export function browserTarget(url: string): string | undefined {
  if (typeof url !== "string") return undefined
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return undefined
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined
  return parsed.href
}

/** The program and its argument list that open an address on a platform. */
export function browserCommand(target: string, platform: NodeJS.Platform = process.platform): [string, string[]] {
  if (platform === "win32") return ["rundll32.exe", ["url.dll,FileProtocolHandler", target]]
  if (platform === "darwin") return ["open", [target]]
  return ["xdg-open", [target]]
}

export type Launch = (file: string, args: string[], options: { windowsHide: boolean }, done: (error: Error | null) => void) => unknown

/** Opens the address in the system browser; false when it was refused. */
export function openUrl(url: string, launch: Launch = execFile as unknown as Launch): boolean {
  const target = browserTarget(url)
  if (!target) return false
  const [file, args] = browserCommand(target)
  launch(file, args, { windowsHide: true }, () => {})
  return true
}
