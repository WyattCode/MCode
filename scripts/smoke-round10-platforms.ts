/**
 * Round 10, macOS and Linux: the platform branches MiMo has and MCode was
 * missing (round10-platforms.md, M10-1 onwards). Nothing here needs a Mac or a
 * Linux machine: the modules take the platform as an argument, and the
 * packaging configuration is read as text.
 */
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { Check } from "./smoke-round5"
import { browserCommand, browserTarget, openUrl, type Launch } from "../src/server/open-url"
import { openInBrowser } from "../src/server/mcp-oauth"

/** Every .ts and .vue file under a folder, as text keyed by its path. */
async function sources(root: string): Promise<Map<string, string>> {
  const found = new Map<string, string>()
  const walk = async (directory: string) => {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name)
      if (entry.isDirectory()) await walk(full)
      else if (/\.(ts|vue|mts)$/.test(entry.name)) found.set(full, await fs.readFile(full, "utf8"))
    }
  }
  await walk(root)
  return found
}

export async function roundTenPlatformChecks(check: Check, section: (name: string) => void): Promise<void> {
  const root = process.cwd()

  section("Round 10 (platforms): M10-1 sign-in addresses never reach a shell")
  {
    const hostile = "https://evil.example/$(touch$IFS/tmp/pwned)/`id`/%PATH%/a'b|c"
    check("M10-1: an https address is accepted as it parses", browserTarget(hostile) === new URL(hostile).href)
    check("M10-1: http is accepted", browserTarget("http://127.0.0.1:1/x") === "http://127.0.0.1:1/x")
    for (const refused of ["file:///etc/passwd", "javascript:alert(1)", "vscode://x", "ms-settings:privacy", "open -a Calculator", "", "//evil.example/x"]) {
      check(`M10-1: ${JSON.stringify(refused)} is refused`, browserTarget(refused) === undefined)
    }
    const shells = /^(sh|bash|zsh|dash|cmd(\.exe)?|powershell(\.exe)?|pwsh(\.exe)?)$/i
    for (const platform of ["win32", "darwin", "linux"] as const) {
      const target = browserTarget(hostile)!
      const [file, args] = browserCommand(target, platform)
      check(`M10-1 (${platform}): the opener is not a shell`, !shells.test(path.basename(file)), file)
      check(`M10-1 (${platform}): the address is one whole argument`, args[args.length - 1] === target && args.filter((arg) => arg.includes("evil.example")).length === 1, args)
    }
    check("M10-1: macOS opens with open, Linux with xdg-open", browserCommand("https://a/", "darwin")[0] === "open" && browserCommand("https://a/", "linux")[0] === "xdg-open")

    const calls: Array<{ file: string; args: string[]; options: unknown }> = []
    const record: Launch = (file, args, options) => {
      calls.push({ file, args, options })
    }
    check("M10-1: openUrl launches once for a web page", openUrl(hostile, record) === true && calls.length === 1)
    check("M10-1: the launch hides its window and names no shell option", JSON.stringify(calls[0]?.options) === JSON.stringify({ windowsHide: true }), calls[0]?.options)
    check("M10-1: openUrl refuses a file address without launching", openUrl("file:///C:/Windows/System32/calc.exe", record) === false && calls.length === 1)

    // The MCP sign-in keeps its test hook, and the hook sees only web pages.
    const log = path.join(os.tmpdir(), `mcode-open-${process.pid}-${Date.now()}.txt`)
    const saved = process.env.MCODE_OAUTH_OPEN_FILE
    process.env.MCODE_OAUTH_OPEN_FILE = log
    try {
      openInBrowser("javascript:alert(1)")
      openInBrowser("https://auth.example/authorize?x=1")
      const written = await fs.readFile(log, "utf8").catch(() => "")
      check("M10-1: the MCP sign-in opens only the web address", written === "https://auth.example/authorize?x=1\n", written)
    } finally {
      if (saved === undefined) delete process.env.MCODE_OAUTH_OPEN_FILE
      else process.env.MCODE_OAUTH_OPEN_FILE = saved
      await fs.rm(log, { force: true })
    }

    // No module builds a command line around an address any more.
    const texts = new Map([...(await sources(path.join(root, "src/server"))), ...(await sources(path.join(root, "src/main")))])
    const offenders = [...texts].filter(([, text]) => /\bexec\(\s*`[^`]*(?:\bopen\b|xdg-open|start\s)/.test(text) || /import\s*\{[^}]*\bexec\b[^}]*\}\s*from\s*["']node:child_process["']/.test(text))
    check("M10-1: no shell-string exec is left in the main process or the server", offenders.length === 0, offenders.map(([file]) => path.relative(root, file)))
    const mcp = texts.get(path.join(root, "src/server/mcp.ts")) ?? ""
    check("M10-1: the MCP sign-in checks the address before it waits for the browser", /browserTarget\(address\.href\)[\s\S]{0,200}waitForCallback\(state, name\)/.test(mcp))
  }
}
