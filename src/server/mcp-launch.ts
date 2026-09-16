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
