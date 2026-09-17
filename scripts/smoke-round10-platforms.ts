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
import { chordOf, controlChord, controlHeld, formatChord, modHeld } from "../src/renderer/src/lib/keys"

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

  section("Round 10 (platforms): M10-2 / M10-3 Command and Control are two keys on a Mac")
  {
    const key = (init: Partial<KeyboardEvent>) =>
      ({ ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, isComposing: false, keyCode: 0, key: "", code: "", ...init }) as KeyboardEvent
    const cmdK = key({ metaKey: true, key: "k", code: "KeyK" })
    const controlK = key({ ctrlKey: true, key: "k", code: "KeyK" })
    check("M10-2: Command+K records as the stored Ctrl+K on a Mac", chordOf(cmdK, "darwin") === "Ctrl+K")
    check("M10-2: Control+K records as Meta+K on a Mac, not as Ctrl+K", chordOf(controlK, "darwin") === "Meta+K", chordOf(controlK, "darwin"))
    check("M10-2: both held record both", chordOf(key({ metaKey: true, ctrlKey: true, key: "k", code: "KeyK" }), "darwin") === "Ctrl+Meta+K")
    check("M10-2: Ctrl+K is Ctrl+K on Windows and Linux", chordOf(controlK, "win32") === "Ctrl+K" && chordOf(controlK, "linux") === "Ctrl+K")
    check("M10-2: the Windows key is its own modifier", chordOf(key({ metaKey: true, key: "k", code: "KeyK" }), "win32") === "Meta+K")
    check("M10-2: mod is Command alone on a Mac", modHeld(cmdK, "darwin") && !modHeld(controlK, "darwin") && !modHeld({ ctrlKey: true, metaKey: true }, "darwin"))
    check("M10-2: mod is Ctrl alone elsewhere", modHeld(controlK, "win32") && !modHeld(cmdK, "win32") && modHeld(controlK, "linux"))
    check("M10-2: MiMo's ctrl is the Control key everywhere", controlHeld(controlK) && !controlHeld(cmdK))
    check("M10-2: the terminal chord is Control+` on a Mac", controlChord("`", "darwin") === "Meta+`" && formatChord(controlChord("`", "darwin"), "darwin") === "⌃`")
    check("M10-2: and Ctrl+` elsewhere, as it always was", controlChord("`", "win32") === "Ctrl+`" && controlChord("`", "linux") === "Ctrl+`")
    const back = key({ ctrlKey: true, shiftKey: true, key: "Tab", code: "Tab" })
    check("M10-2: Control+Shift+Tab on a Mac matches its stored chord", chordOf(back, "darwin") === controlChord("Shift+Tab", "darwin"), [chordOf(back, "darwin"), controlChord("Shift+Tab", "darwin")])
    check("M10-2: Ctrl+Shift+Tab on Windows keeps its stored chord", chordOf(back, "win32") === controlChord("Shift+Tab", "win32") && controlChord("Shift+Tab", "win32") === "Ctrl+Shift+Tab")
    check("M10-3: a Mac draws the recent-chat chord with the Control glyph", formatChord(controlChord("Shift+Tab", "darwin"), "darwin") === "⌃⇧⇥", formatChord(controlChord("Shift+Tab", "darwin"), "darwin"))
    check("M10-3: a Mac draws mod as the command glyph", formatChord("Ctrl+Alt+P", "darwin") === "⌥⌘P")

    const appVue = await fs.readFile(path.join(root, "src/renderer/src/App.vue"), "utf8")
    const handler = appVue.slice(appVue.indexOf("function onKeydown("), appVue.indexOf("const menuCommands"))
    check("M10-2: the key handler never folds Command into Ctrl", handler.length > 1000 && !/ctrlKey\s*\|\|\s*event\.metaKey/.test(handler) && /modHeld\(event, platform\)/.test(handler))
    check("M10-2: the key handler reads rebindings with the platform", /chordOf\(event, platform\)/.test(handler))
    check("M10-2: the terminal is not in the Command table", !/"`":/.test(handler) && /controlHeld\(event\)[^\n]*Backquote/.test(handler))
    check("M10-2: the terminal and recent-chat hints are MiMo's ctrl chords", /hint: controlChord\("`", app\.platform\)/.test(appVue) && /hint: controlChord\("Tab", app\.platform\)/.test(appVue) && /hint: controlChord\("Shift\+Tab", app\.platform\)/.test(appVue))
    const settings = await fs.readFile(path.join(root, "src/renderer/src/components/SettingsDialog.vue"), "utf8")
    check("M10-2: recording a chord knows the platform", !/chordOf\(event\)/.test(settings) && /chordOf\(event, app\.platform\)/.test(settings))
    const shown: Array<[string, RegExp]> = [
      ["src/renderer/src/lib/tip.ts", /shownChord\(tip\.hint\)/],
      ["src/renderer/src/components/ContextMenu.vue", /shownChord\(item\.hint\)[\s\S]*shownChord\(child\.hint\)/],
      ["src/renderer/src/components/AppMenu.vue", /shownChord\(item\.hint\)/],
      ["src/renderer/src/components/RightPanel.vue", /shownChord\(hints\[tool\]/],
      ["src/renderer/src/components/Sidebar.vue", /shortcut: shownChord\(/],
    ]
    for (const [file, pattern] of shown) {
      check(`M10-3: ${path.basename(file)} draws its shortcuts for the platform`, pattern.test(await fs.readFile(path.join(root, file), "utf8")))
    }
  }
}
