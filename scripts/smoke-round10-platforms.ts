/**
 * Round 10, macOS and Linux: the platform branches MiMo has and MCode was
 * missing (round10-platforms.md, M10-1 onwards). Nothing here needs a Mac or a
 * Linux machine: the modules take the platform as an argument, and the
 * packaging configuration is read as text.
 */
import { EventEmitter } from "node:events"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { Check } from "./smoke-round5"
import { browserCommand, browserTarget, openUrl, type Launch } from "../src/server/open-url"
import { openInBrowser } from "../src/server/mcp-oauth"
import { getConfig, validateConfiguration } from "app-builder-lib/out/util/config/config.js"
import { LinuxTargetHelper } from "app-builder-lib/out/targets/LinuxTargetHelper.js"
import { DebugLogger } from "builder-util"
import { platformShell } from "../src/server/shell-path"
import { shell as commandShell } from "../src/server/tool/bash"
import { systemPrompt } from "../src/server/session/prompt"
import { fcitxEnvironment, fromXinputrc } from "../src/main/linux-ime"
import { WINDOWS_APPS, docApps, isKnownOpenWith, openApps } from "../src/shared/open-app"
import { findBundle, installedDocApps, launchTarget, macApplicationFolders } from "../src/main/installed-apps"
import { MENU_COMMANDS, acceleratorOf, menuAccelerator, readMenuKeys } from "../src/main/menu-keys"
import { cancelPendingHide, claimDialog, dialogParent, hideWindow, micDecision, releaseDialog } from "../src/main/native-dialogs"
import { protectedFilter, protectedPaths } from "../src/server/protected-paths"
import { searchFolder, searchTree } from "../src/server/handlers"
import { packageTarget } from "./package-target.mjs"
import { dataDirs, desktopId, entryIcon, linuxIconSync, type IconSyncHost } from "../src/main/linux-icon-sync"
import sharp from "sharp"
import { pageKeyAction, type PageKeyInput } from "../src/shared/browser-page"
import { chordOf, controlChord, controlHeld, formatChord, modHeld, modText } from "../src/renderer/src/lib/keys"

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

    // Inside a browser tab the page is asked first; the same split decides what reaches the window.
    const press = (key: string, code: string, mods: Partial<PageKeyInput>): PageKeyInput => ({ type: "keyDown", key, code, control: false, shift: false, alt: false, meta: false, ...mods })
    const mac = new Map([["Ctrl+K", "app.search"], ["Meta+`", "view.terminal"], ["Shift+Meta+Tab", "session.prevRecent"]])
    const win = new Map([["Ctrl+K", "app.search"], ["Ctrl+`", "view.terminal"], ["Ctrl+Tab", "session.nextRecent"]])
    check("M10-2: in a page on a Mac, Control+K stays with the page", pageKeyAction(press("k", "KeyK", { control: true }), mac, "darwin").kind === "none")
    check("M10-2: and Command+K reaches the window", pageKeyAction(press("k", "KeyK", { meta: true }), mac, "darwin").kind === "forward")
    check("M10-2: Control+` and Control+Tab reach it, Command+` does not", pageKeyAction(press("`", "Backquote", { control: true }), mac, "darwin").kind === "forward" && pageKeyAction(press("Tab", "Tab", { control: true, shift: true }), mac, "darwin").kind === "forward" && pageKeyAction(press("`", "Backquote", { meta: true }), mac, "darwin").kind === "none")
    check("M10-2: on Windows Ctrl+` and Ctrl+Tab still reach it, the Windows key does not", pageKeyAction(press("`", "Backquote", { control: true }), win, "win32").kind === "forward" && pageKeyAction(press("Tab", "Tab", { control: true }), win, "win32").kind === "forward" && pageKeyAction(press("k", "KeyK", { meta: true }), win, "win32").kind === "none")
    const pageModule = await fs.readFile(path.join(root, "src/main/browser-page.ts"), "utf8")
    check("M10-2: the page asks with this system's platform", /pageKeyAction\(input, boundChords, process\.platform\)/.test(pageModule))

    const appVue = await fs.readFile(path.join(root, "src/renderer/src/App.vue"), "utf8")
    const handler = appVue.slice(appVue.indexOf("function onKeydown("), appVue.indexOf("const menuCommands"))
    check("M10-2: the key handler dispatches the platform chord through the binding table", /keyboardCommands\.value\.get\(chordOf\(event, app\.platform\)\)/.test(handler))
    check("M10-2: the terminal and recent-chat hints are MiMo's ctrl chords", /hint: controlChord\("`", app\.platform\)/.test(appVue) && /hint: controlChord\("Tab", app\.platform\)/.test(appVue) && /hint: controlChord\("Shift\+Tab", app\.platform\)/.test(appVue))
    const settings = await fs.readFile(path.join(root, "src/renderer/src/components/SettingsDialog.vue"), "utf8")
    check("M10-2: recording a chord knows the platform", /recordShortcutKey\(event, app\.platform\)/.test(settings))
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
    check("M10-3: prose naming both spellings keeps the Mac glyph on a Mac", modText("任务进行时按 Enter 的默认行为；Ctrl/⌘+Enter 为另一种", "darwin") === "任务进行时按 Enter 的默认行为；⌘+Enter 为另一种", modText("任务进行时按 Enter 的默认行为；Ctrl/⌘+Enter 为另一种", "darwin"))
    check("M10-3: and keeps Ctrl on Windows, in either written order", modText("Default action when pressing Enter while a task is running. Ctrl/⌘+Enter does the other.", "win32") === "Default action when pressing Enter while a task is running. Ctrl+Enter does the other." && modText("⌘/Ctrl+点击打开", "win32") === "Ctrl+点击打开")
    check("M10-3: the composer-send note is spelled for the platform", /shownModText\(t\("set\.composer\.runningSendSub"\)\)/.test(settings))
    check("M10-3: the path-open tip is spelled for the platform", /shownModText\(t\("stepList\.cmdClickOpen"\)\)/.test(await fs.readFile(path.join(root, "src/renderer/src/components/parts/ToolPart.vue"), "utf8")))
    const dialogCss = settings.slice(settings.indexOf(".font-field {"))
    check("M10-3: the update-feed field is wide for a wide- metrics face too", /min-width: 3[0-9]ch/.test(dialogCss), dialogCss.slice(0, 160))
  }

  section("Round 10 (platforms): M10-4 / M10-5 / M10-6 what the macOS and Linux packages declare")
  {
    const config = (await getConfig(root, null, null)) as any
    let valid = true
    try {
      await validateConfiguration(config, new DebugLogger(false))
    } catch (error) {
      valid = false
      check("M10-4: electron-builder accepts the configuration", false, String(error).slice(0, 300))
    }
    if (valid) check("M10-4: electron-builder accepts the configuration", true)
    const schemes = (config.protocols ?? []).flatMap((protocol: { schemes: string[] }) => protocol.schemes)
    check("M10-4: the mcode scheme is declared for the Info.plist", schemes.length === 1 && schemes[0] === "mcode", config.protocols)
    const linkModule = await fs.readFile(path.join(root, "src/shared/session-link.ts"), "utf8")
    check("M10-4: it is the scheme the app registers", /LINK_SCHEME\s*=\s*"mcode"/.test(linkModule))

    const pkg = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"))
    check("M10-5: package.json names the desktop entry", pkg.desktopName === "mcode.desktop", pkg.desktopName)
    check("M10-5: the Linux package names its .desktop file after it", config.linux?.syncDesktopName === true)
    const fakePackager = {
      appInfo: { productName: pkg.productName, description: pkg.description, sanitizedProductName: pkg.productName },
      executableName: "mcode",
      fileAssociations: [],
      config,
      platformSpecificBuildOptions: config.linux,
      info: { metadata: pkg },
    }
    const helper = new LinuxTargetHelper(fakePackager as any)
    const entry = await helper.computeDesktopEntry(config.linux, "/opt/MCode/mcode %U")
    check("M10-4: the Linux desktop entry handles mcode: links", /^MimeType=x-scheme-handler\/mcode;$/m.test(entry), entry)
    check("M10-5: the window class matches the desktop entry", /^StartupWMClass=mcode$/m.test(entry) && helper.getDesktopFileName() === "mcode", entry)

    const entitlements = await fs.readFile(path.join(root, config.mac?.entitlements ?? "missing"), "utf8").catch(() => "")
    const granted = [...entitlements.matchAll(/<key>([^<]+)<\/key>\s*<true\/>/g)].map((match) => match[1])
    check("M10-6: the app and its helpers use the same entitlements", config.mac?.entitlements === "build/entitlements.mac.plist" && config.mac?.entitlementsInherit === config.mac?.entitlements)
    check(
      "M10-6: the microphone is granted beside electron-builder's defaults",
      ["com.apple.security.cs.allow-jit", "com.apple.security.cs.allow-unsigned-executable-memory", "com.apple.security.cs.disable-library-validation", "com.apple.security.device.audio-input", "com.apple.security.automation.apple-events"].every((name) => granted.includes(name)) && granted.length === 5,
      granted,
    )
    const why = config.mac?.extendInfo?.NSMicrophoneUsageDescription
    check("M10-6: the Info.plist says why the microphone is used", typeof why === "string" && why.startsWith("MCode ") && why.length > 20, why)
  }

  section("Round 10 (platforms): M10-9 / M10-10 which shell runs a command and opens a terminal")
  {
    check("M10-10: macOS falls back to zsh", platformShell("darwin") === "/bin/zsh")
    const savedPath = process.env.PATH
    const savedShell = process.env.SHELL
    const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "mcode-r10-shell-"))
    try {
      process.env.PATH = scratch
      check("M10-10: Linux without bash on PATH falls back to /bin/sh, not /bin/bash", platformShell("linux") === "/bin/sh", platformShell("linux"))
      process.env.PATH = savedPath
      process.env.SHELL = "/usr/bin/fish"
      const picked = commandShell().command
      check("M10-9: a login shell of fish does not run commands", !/fish/i.test(picked), picked)
      // R16-B1: the prompt names no shell at all now, so what the bash tool picks is all there is to check.
      const prompt = await systemPrompt({ directory: scratch, agent: "build" })
      check("M10-9: the prompt names no shell, as MiMo's names none", !/^Shell: /m.test(prompt), prompt.slice(-200))
      check("M10-9: a configured shell is still the one commands run in", commandShell("cmd.exe").command.toLowerCase().includes("cmd"), commandShell("cmd.exe").command)
      process.env.SHELL = "/usr/bin/nu"
      check("M10-9: nor does nu", !/\bnu\b/i.test(commandShell().command), commandShell().command)
    } finally {
      process.env.PATH = savedPath
      if (savedShell === undefined) delete process.env.SHELL
      else process.env.SHELL = savedShell
      await fs.rm(scratch, { recursive: true, force: true })
    }
    const terminal = await fs.readFile(path.join(root, "src/server/shell.ts"), "utf8")
    const preferred = terminal.slice(terminal.indexOf("function preferred()"), terminal.indexOf("function preferred()") + 400)
    check("M10-10: the terminal no longer assumes /bin/bash", !terminal.includes('"/bin/bash"') && /process\.env\.SHELL \|\| platformShell\(\)/.test(preferred), preferred)
  }

  section("Round 10 (platforms): M10-11 / M10-12 fcitx and Chromium switches on Linux")
  {
    const none = () => undefined
    check("M10-11: nothing is added off Linux", Object.keys(fcitxEnvironment("win32", { GTK_IM_MODULE: "fcitx" }, () => "run_im fcitx5")).length === 0)
    let read = 0
    fcitxEnvironment("darwin", {}, () => {
      read++
      return "run_im fcitx"
    })
    check("M10-11: and ~/.xinputrc is not read there", read === 0)
    check(
      "M10-11: GTK's module fills in the other two",
      JSON.stringify(fcitxEnvironment("linux", { GTK_IM_MODULE: "fcitx5" }, none)) === JSON.stringify({ QT_IM_MODULE: "fcitx5", XMODIFIERS: "@im=fcitx5" }),
    )
    check(
      "M10-11: XMODIFIERS alone is enough",
      JSON.stringify(fcitxEnvironment("linux", { XMODIFIERS: "@im=fcitx" }, none)) === JSON.stringify({ GTK_IM_MODULE: "fcitx", QT_IM_MODULE: "fcitx" }),
    )
    check("M10-11: a value the user set is never replaced", !("GTK_IM_MODULE" in fcitxEnvironment("linux", { GTK_IM_MODULE: "ibus", QT_IM_MODULE: "fcitx" }, none)))
    check("M10-11: another input method is left alone", Object.keys(fcitxEnvironment("linux", { GTK_IM_MODULE: "ibus", XMODIFIERS: "@im=ibus" }, () => "run_im ibus")).length === 0)
    check(
      "M10-11: ~/.xinputrc's last run_im is used when the environment says nothing",
      JSON.stringify(fcitxEnvironment("linux", {}, () => "# im-config\nrun_im ibus\n  run_im fcitx5\n")) === JSON.stringify({ GTK_IM_MODULE: "fcitx5", QT_IM_MODULE: "fcitx5", XMODIFIERS: "@im=fcitx5" }),
    )
    check("M10-11: Sogou Pinyin runs on fcitx", fromXinputrc("run_im sogoupinyin") === "fcitx" && fromXinputrc("run_im Sogou") === "fcitx" && fromXinputrc("run_im ibus") === undefined)
    check(
      "M10-11: an unreadable ~/.xinputrc is no method",
      Object.keys(
        fcitxEnvironment("linux", {}, () => {
          throw new Error("EACCES")
        }),
      ).length === 0,
    )
    const main = await fs.readFile(path.join(root, "src/main/index.ts"), "utf8")
    const imeAt = main.indexOf("fcitxEnvironment(process.platform")
    check("M10-11: the main process fills the environment in before the app is ready", imeAt > 0 && imeAt < main.indexOf("app.whenReady") && /Object\.assign\(process\.env, imeFilled\)/.test(main))
    const linuxBlock = main.slice(main.indexOf('if (process.platform === "linux") {'), imeAt)
    check("M10-12: Linux asks Chromium to keep shared memory out of /dev/shm", /appendSwitch\("disable-dev-shm-usage"\)/.test(linuxBlock))
    check("M10-12: no-zygote is not passed while the sandbox is on", !/appendSwitch\("no-zygote"\)/.test(main))
    check("M10-28: Linux asks Chromium for the system voices", /appendSwitch\("enable-speech-dispatcher"\)/.test(linuxBlock))
  }

  section("Round 10 (platforms): M10-16 / M10-17 / M10-19 what a folder and a document open with")
  {
    const mac = openApps("darwin")
    check(
      "M10-16: macOS lists Terminal and MiMo's nineteen, in MiMo's order",
      mac.map((entry) => entry.id).join(",") ===
        "terminal,vscode,cursor,sublime-text,zed,xcode,android-studio,pycharm,intellij-idea,webstorm,goland,clion,rustrover,fleet,nova,iterm2,ghostty,warp,kitty,alacritty",
      mac.map((entry) => entry.id),
    )
    check("M10-16: MiMo's five application folders", macApplicationFolders("/Users/me").map((folder) => folder.replace(/\\/g, "/")).join(",") === "/Users/me/Applications,/Applications,/Applications/Utilities,/System/Applications,/System/Applications/Utilities")
    const terminal = mac.find((entry) => entry.id === "terminal")!
    const onDisk = (files: string[]) => (file: string) => files.includes(file)
    check("M10-16: the system Terminal is found where macOS keeps it", findBundle(terminal, onDisk(["/System/Applications/Utilities/Terminal.app"]), "/Users/me") === "/System/Applications/Utilities/Terminal.app")
    const pycharm = mac.find((entry) => entry.id === "pycharm")!
    check("M10-16: a PyCharm CE install counts as PyCharm", findBundle(pycharm, onDisk(["/Applications/PyCharm CE.app"]), "/Users/me") === "/Applications/PyCharm CE.app")
    check("M10-16: the user's own Applications folder is looked in first", findBundle(pycharm, onDisk(["/Applications/PyCharm.app", "/Users/me/Applications/PyCharm.app"]), "/Users/me") === "/Users/me/Applications/PyCharm.app")
    check("M10-16: TextMate and Antigravity are gone", !mac.some((entry) => entry.id === "textmate" || entry.id === "antigravity"))

    check("M10-17: Windows offers no document apps, as MiMo finds none there", ["pptx", "docx", "xlsx", "pdf"].every((kind) => docApps(kind, "win32").length === 0 && docApps(kind, "linux").length === 0))
    check("M10-17: a Word file on a Mac offers Pages, Word, WPS and LibreOffice", docApps("docx", "darwin").map((entry) => entry.label).join(",") === "Pages,Microsoft Word,WPS Office,LibreOffice")
    check("M10-17: a PDF offers Preview, Acrobat and WPS", docApps("pdf", "darwin").map((entry) => entry.label).join(",") === "Preview,Adobe Acrobat,WPS Office")
    check("M10-17: a slide deck offers Keynote first", docApps("pptx", "darwin")[0]?.label === "Keynote" && docApps("xlsx", "darwin")[0]?.label === "Numbers")
    check("M10-17: an unknown kind offers nothing", docApps("toString", "darwin").length === 0 && docApps("txt", "darwin").length === 0)
    check("M10-17: document apps may be started only on a Mac", isKnownOpenWith("Numbers", "darwin") && !isKnownOpenWith("Numbers", "win32"))
    let icons = 0
    const onWindows = await installedDocApps("docx", async () => {
      icons++
      return ""
    }, "win32")
    check("M10-17: nothing is looked for on Windows", onWindows.length === 0 && icons === 0)
    const card = await fs.readFile(path.join(root, "src/renderer/src/components/DeliveredFilesCard.vue"), "utf8")
    check("M10-17: the file card lists document apps, not the folder targets", /window\.mcode\s*\.docApps\(kind\)/.test(card) && !/useOpenWith/.test(card))

    const sublime = WINDOWS_APPS.find((entry) => entry.id === "sublime-text")!
    check("M10-19: Sublime Text is looked for as subl and sublime_text on Windows", sublime.openWith === "subl" && sublime.find?.join(",") === "subl,sublime_text")
    check("M10-19: Linux lists nothing, as MiMo does", openApps("linux").length === 0)
    check("M10-19: a plain Windows command is still started by its name", (await launchTarget("code", "win32")) === "code")
  }

  section("Round 10 (platforms): M10-18 the picture preview's tools sit away from the window buttons")
  {
    const preview = await fs.readFile(path.join(root, "src/renderer/src/components/ImagePreview.vue"), "utf8")
    const rule = (selector: string) => new RegExp(`\\n${selector.replace(/\./g, "\\.")} \\{([^}]*)\\}`).exec(preview)?.[1] ?? ""
    check("M10-18: the corner is 44 from the left on Windows and Linux", /\bleft: 44px;/.test(rule(".ip-corner")) && !/inset-inline-end/.test(rule(".ip-corner")), rule(".ip-corner"))
    check("M10-18: and 44 from the right on macOS", /\bright: 44px;/.test(rule(".ip-corner.mac")) && /\bleft: auto;/.test(rule(".ip-corner.mac")), rule(".ip-corner.mac"))
    check("M10-18: only macOS takes the right side", /class="ip-corner" :class="\{ mac: app\.platform === 'darwin' \}"/.test(preview))
  }

  section("Round 10 (platforms): M10-14 / M10-15 the macOS menu bar")
  {
    const menu = await fs.readFile(path.join(root, "src/main/menu.ts"), "utf8")
    const windowMenu = menu.slice(menu.indexOf('L("menu.window"'), menu.indexOf("Menu.setApplicationMenu"))
    check("M10-14: macOS minimizes with the role, which brings Cmd+M", /isMac\s*\?\s*\[\s*\{ role: "minimize"/.test(windowMenu) && /\{ role: "zoom"/.test(windowMenu), windowMenu.slice(0, 300))
    check("M10-14: Windows and Linux keep the written-out rows", /: \[\s*\{ label: L\("menu\.minimize", "Minimize"\), click:/.test(windowMenu))

    const none = { binds: {}, recording: false }
    check("M10-15: the built-in chords when nothing is rebound", menuAccelerator("newTask", none, "darwin") === "CmdOrCtrl+N" && menuAccelerator("settings", none, "darwin") === "CmdOrCtrl+,")
    const moved = { binds: { [MENU_COMMANDS.newTask.id]: "Ctrl+Shift+J", [MENU_COMMANDS.close.id]: "" }, recording: false }
    check("M10-15: a rebound command shows its new chord", menuAccelerator("newTask", moved, "darwin") === "CmdOrCtrl+Shift+J")
    check("M10-15: a deleted chord shows none", menuAccelerator("close", moved, "darwin") === undefined)
    check("M10-15: while recording, no item has a chord", (["settings", "newTask", "openFolder", "close"] as const).every((item) => menuAccelerator(item, { binds: {}, recording: true }, "darwin") === undefined))
    check("M10-15: the Control key is Control on a Mac and Super elsewhere", acceleratorOf("Alt+Shift+Meta+↑", "darwin") === "Alt+Shift+Control+Up" && acceleratorOf("Meta+K", "linux") === "Super+K")
    check("M10-15: the plus key is spelled for Electron", acceleratorOf("Ctrl++", "darwin") === "CmdOrCtrl+Plus" && acceleratorOf("Ctrl+Enter", "win32") === "CmdOrCtrl+Return")
    check("M10-15: an unknown modifier is no accelerator", acceleratorOf("Hyper+K", "darwin") === undefined && acceleratorOf("", "darwin") === undefined)
    check("M10-15: the menu's command ids are the renderer's", ["app.settings", "session.new", "project.open", "window.close"].every((id) => Object.values(MENU_COMMANDS).some((entry) => entry.id === id)))
    const appVue = await fs.readFile(path.join(root, "src/renderer/src/App.vue"), "utf8")
    for (const entry of Object.values(MENU_COMMANDS)) {
      // The command's own entry, from its id to its run.
      const at = appVue.indexOf(`id: "${entry.id}"`)
      const body = at < 0 ? "" : appVue.slice(at, appVue.indexOf("run:", at))
      check(`M10-15: ${entry.id} reads the same default as the menu`, body.includes(`hint: MENU_SHORTCUT_DEFAULTS["${entry.id}"]`))
    }
    check("M10-15: the IPC takes only strings and a boolean", readMenuKeys({ binds: { a: "Ctrl+A", b: 3 }, recording: true })?.binds.b === undefined && readMenuKeys({ binds: {}, recording: "yes" }) === undefined && readMenuKeys(null) === undefined)
    for (const item of ["settings", "newTask", "openFolder", "close"]) {
      check(`M10-15: the ${item} item takes its chord from the bindings`, new RegExp(`\\.\\.\\.command\\("${item}"\\)`).test(menu))
    }
    const settings = await fs.readFile(path.join(root, "src/renderer/src/components/SettingsDialog.vue"), "utf8")
    check("M10-15: recording tells the menu, and so does stopping", /recordingChord\.value = true/.test(settings) && /recordingChord\.value = keySearch\.value/.test(settings))
    check("M10-15: the window sends the bindings to the menu", /window\.mcode\.menuKeys\?\.\(\{ binds: \{ \.\.\.\(binds \?\? \{\}\) \}, recording \}\)/.test(appVue))
  }

  section("Round 10 (platforms): M10-24 / M10-25 / M10-26 microphone, dialogs and full screen")
  {
    check("M10-24: Windows refuses when its microphone setting is off", micDecision("win32", "denied") === "deny" && micDecision("win32", "restricted") === "deny")
    check("M10-24: and lets getUserMedia answer otherwise", micDecision("win32", "granted") === "allow" && micDecision("win32", "unknown") === "allow" && micDecision("win32", "not-determined") === "allow")
    check("M10-24: macOS asks once, and guides after a refusal", micDecision("darwin", "not-determined") === "ask" && micDecision("darwin", "denied") === "deny" && micDecision("darwin", "unknown") === "deny" && micDecision("darwin", "granted") === "allow")
    check("M10-24: Linux leaves it to getUserMedia", micDecision("linux", "denied") === "allow")
    const main = await fs.readFile(path.join(root, "src/main/index.ts"), "utf8")
    const mic = main.slice(main.indexOf('ipcMain.handle("mcode:mic-access"'), main.indexOf('ipcMain.handle("mcode:mic-access"') + 500)
    check("M10-24: the IPC reads the status on Windows too", /process\.platform !== "darwin" && process\.platform !== "win32"/.test(mic) && /micDecision\(process\.platform, status\)/.test(mic), mic)

    const win = { name: "window" }
    check("M10-25: macOS attaches no dialog to the window", dialogParent("darwin", win) === undefined)
    check("M10-25: Windows and Linux do", dialogParent("win32", win) === win && dialogParent("linux", win) === win && dialogParent("win32", null) === undefined)
    let blurred = 0
    const asking = { blur: () => blurred++ }
    const first = claimDialog("darwin", asking)
    const second = claimDialog("darwin", asking)
    check("M10-25: a second dialog while one is up is refused", Boolean(first) && second === undefined)
    check("M10-25: and on macOS the asking window gives way to the open one", blurred === 1)
    claimDialog("win32", asking)
    check("M10-25: Windows does not move focus", blurred === 1)
    releaseDialog(second)
    check("M10-25: a refused claim frees nothing", claimDialog("win32") === undefined)
    releaseDialog(first)
    const third = claimDialog("win32")
    check("M10-25: the dialog closing frees the next", Boolean(third))
    releaseDialog(third)
    for (const channel of ["mcode:pick-directory", "mcode:save-text"]) {
      const at = main.indexOf(`ipcMain.handle("${channel}"`)
      const body = main.slice(at, at + 1400)
      check(`M10-25: ${channel} takes the one-dialog claim and the platform's parent`, at > 0 && /claimDialog\(process\.platform, asking\)/.test(body) && /dialogParent\(process\.platform, asking\)/.test(body) && /releaseDialog\(claim\)/.test(body))
    }
    check("M10-25: no dialog is opened on the raw sender window any more", !/const owner = BrowserWindow\.fromWebContents\(event\.sender\)\s*\n\s*const options(?:: Electron\.OpenDialogOptions)? = \{\s*\n\s*(?:title|defaultPath)/.test(main))

    class FakeWindow extends EventEmitter {
      full = true
      hidden = 0
      destroyed = false
      isFullScreen() {
        return this.full
      }
      isDestroyed() {
        return this.destroyed
      }
      setFullScreen(flag: boolean) {
        this.full = flag
      }
      hide() {
        this.hidden++
      }
    }
    const plain = new FakeWindow()
    plain.full = false
    hideWindow(plain, "darwin")
    check("M10-26: a window not in full screen hides at once", plain.hidden === 1)
    const full = new FakeWindow()
    hideWindow(full, "darwin")
    check("M10-26: a full-screen window leaves full screen first", full.hidden === 0 && full.full === false)
    full.emit("leave-full-screen")
    check("M10-26: and hides once it has", full.hidden === 1)
    const again = new FakeWindow()
    hideWindow(again, "darwin")
    cancelPendingHide(again)
    again.emit("leave-full-screen")
    check("M10-26: activating the app meanwhile keeps it shown", again.hidden === 0 && again.listenerCount("leave-full-screen") === 0)
    const onWindows = new FakeWindow()
    hideWindow(onWindows, "win32")
    check("M10-26: Windows hides at once, full screen or not", onWindows.hidden === 1)
    check("M10-26: the activate handler cancels a waiting hide", /app\.on\("activate", \(\) => \{[\s\S]{0,200}cancelPendingHide\(window\)/.test(main))
  }

  section("Round 10 (platforms): M10-23 a search from the home folder stays out of its private folders")
  {
    const mac = protectedPaths("darwin", "/Users/me")
    check("M10-23: macOS keeps out of Pictures, Library and the rest", ["/Users/me/Pictures", "/Users/me/Library", "/Users/me/Desktop", "/Users/me/Library/Application Support/AddressBook"].every((file) => mac.includes(file)), mac)
    check("M10-23: Windows keeps out of AppData and OneDrive", protectedPaths("win32", "C:\\Users\\me").includes("C:\\Users\\me\\AppData") && protectedPaths("win32", "C:\\Users\\me").includes("C:\\Users\\me\\OneDrive"))
    check("M10-23: Linux has none", protectedPaths("linux", "/home/me").length === 0)
    check("M10-23: only a walk rooted at home skips them", protectedFilter("/Users/me", "darwin", "/Users/me")("/Users/me/Pictures") && !protectedFilter("/Users/me/code", "darwin", "/Users/me")("/Users/me/Pictures"))
    check("M10-23: Windows compares without case", protectedFilter("c:\\users\\ME", "win32", "C:\\Users\\me")("C:\\USERS\\me\\appdata"))

    const home = await fs.mkdtemp(path.join(os.tmpdir(), "mcode-r10-home-"))
    const savedProfile = process.env.USERPROFILE
    const savedHome = process.env.HOME
    const fenced = os.homedir
    try {
      // The per-user application folder: AppData on Windows, Library on macOS (each is on that platform's protected list).
      const appFolder = process.platform === "darwin" ? "Library/Caches" : "AppData/Roaming"
      for (const folder of ["Pictures", "Documents", appFolder, "code/Pictures"]) await fs.mkdir(path.join(home, folder), { recursive: true })
      for (const file of ["Pictures/note-a.txt", "Documents/note-b.txt", `${appFolder}/note-c.txt`, "code/note-d.txt", "code/Pictures/note-e.txt"]) {
        await fs.writeFile(path.join(home, file), "x")
      }
      process.env.USERPROFILE = home
      process.env.HOME = home
      /*
       * The suite fences `os.homedir` itself now (scripts/fenced-home), so the
       * environment no longer decides it and this section has to move the
       * fence rather than the variables. Kept as a check rather than a silent
       * assignment: the walk below is only about private folders if the folder
       * it walks really is what the product will call home.
       */
      os.homedir = () => home
      check("M10-23: the test home is the home folder", path.resolve(os.homedir()) === path.resolve(home), os.homedir())
      const names = (found: { entries: { name: string }[] }) => found.entries.map((entry) => entry.name).sort().join(",")
      if (process.platform === "win32" || process.platform === "darwin") {
        const tree = await searchTree(home, "note")
        check("M10-23: the files tab's search from home skips the private folders", names(tree) === "note-d.txt,note-e.txt", names(tree))
        const picker = await searchFolder(home, "note")
        check("M10-23: so does the @ search", names(picker) === "note-d.txt,note-e.txt", names(picker))
        const project = await searchFolder(path.join(home, "code"), "note")
        check("M10-23: a project below home searches all of itself", names(project) === "note-d.txt,note-e.txt", names(project))
        const documents = await searchTree(path.join(home, "Documents"), "note")
        check("M10-23: a private folder opened as its own project is searched", names(documents) === "note-b.txt", names(documents))
      }
    } finally {
      os.homedir = fenced
      if (savedProfile === undefined) delete process.env.USERPROFILE
      else process.env.USERPROFILE = savedProfile
      if (savedHome === undefined) delete process.env.HOME
      else process.env.HOME = savedHome
      await fs.rm(home, { recursive: true, force: true })
    }
  }

  section("Round 10 (platforms): M10-29 a package is built on the system it is for")
  {
    const pkg = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"))
    check("M10-29: there is a Linux package command", pkg.scripts["package:linux"] === "node scripts/package.mjs --linux")
    check("M10-29: each flag names its system", packageTarget(["--linux"], "linux").target === "linux" && packageTarget(["--mac"], "darwin").target === "darwin" && packageTarget(["--win"], "win32").target === "win32")
    check("M10-29: no flag builds for this machine", packageTarget([], "linux").target === "linux" && packageTarget(["--dir"], "win32").target === "win32")
    const cross = packageTarget(["--mac"], "win32")
    check("M10-29: a Mac package on Windows is refused, saying where to build it", !cross.target && /built on macOS/.test(cross.error ?? ""), cross)
    check("M10-29: so is a Linux package on a Mac", Boolean(packageTarget(["--linux"], "darwin").error))
    check("M10-29: two systems at once are refused", Boolean(packageTarget(["--win", "--linux"], "win32").error))
    const script = await fs.readFile(path.join(root, "scripts", "package.mjs"), "utf8")
    const refusedAt = script.indexOf("process.exit(1)")
    check("M10-29: the refusal comes before the version is touched", refusedAt > 0 && refusedAt < script.indexOf('run("node", ["scripts/bump-version.mjs"])') && refusedAt < script.indexOf("const before"), refusedAt)
  }

  section("Round 10 (platforms): M10-13 the macOS icon sits on Apple's grid")
  {
    /** The opaque tile and the visible extent of a PNG, as boxes. */
    const measure = async (input: Buffer | string) => {
      const { data, info } = await sharp(input).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
      const visible = [info.width, info.height, -1, -1]
      const tile = [info.width, info.height, -1, -1]
      for (let y = 0; y < info.height; y++) {
        for (let x = 0; x < info.width; x++) {
          const alpha = data[(y * info.width + x) * 4 + 3]
          for (const [box, floor] of [[visible, 8], [tile, 250]] as const) {
            if (alpha <= floor) continue
            box[0] = Math.min(box[0], x)
            box[1] = Math.min(box[1], y)
            box[2] = Math.max(box[2], x)
            box[3] = Math.max(box[3], y)
          }
        }
      }
      return { size: info.width, visible, tile }
    }
    // The icns's 1024 entry (ic10), read out of the container.
    const icns = await fs.readFile(path.join(root, "build", "icon.icns"))
    let largest: Buffer | undefined
    for (let at = 8; at + 8 <= icns.length; ) {
      const length = icns.readUInt32BE(at + 4)
      if (icns.toString("ascii", at, at + 4) === "ic10") largest = icns.subarray(at + 8, at + length)
      at += Math.max(8, length)
    }
    check("M10-13: the .icns carries a 1024 image", Boolean(largest))
    if (largest) {
      const cut = await measure(largest)
      const margin = cut.tile[0] / cut.size
      check("M10-13: its tile is 824 of 1024, centred, as Apple's grid has it", cut.size === 1024 && cut.tile.join(",") === "100,100,923,923", cut)
      check("M10-13: about 9% is left clear on each side, as MiMo's macOS icon leaves", margin > 0.08 && margin < 0.11 && cut.visible[0] > 64 && cut.visible[2] < 960, cut)
      check("M10-13: the shadow falls below the tile", cut.visible[3] - cut.tile[3] > cut.tile[1] - cut.visible[1], cut)
    }
    const full = await measure(path.join(root, "build", "icon.png"))
    check("M10-13: Windows and Linux keep the full tile", full.visible.join(",") === "0,0,1023,1023", full)
    const colourways = (await fs.readdir(path.join(root, "resources", "app-icons"))).filter((name) => name.endsWith(".png")).sort()
    const macCuts = (await fs.readdir(path.join(root, "resources", "app-icons-mac"))).filter((name) => name.endsWith(".png")).sort()
    check("M10-13: every colourway has its macOS cut", colourways.length === 7 && colourways.join(",") === macCuts.join(","), macCuts)
    for (const name of macCuts) {
      const cut = await measure(path.join(root, "resources", "app-icons-mac", name))
      check(`M10-13: ${name} for the Dock sits on the grid`, cut.tile[0] === Math.round((cut.size - Math.round(cut.size * 824 / 1024)) / 2) && cut.tile[0] / cut.size > 0.09, cut)
    }
    const main = await fs.readFile(path.join(root, "src/main/index.ts"), "utf8")
    const handler = main.slice(main.indexOf('ipcMain.handle("mcode:app-icon"'), main.indexOf('ipcMain.handle("mcode:app-icon"') + 1200)
    check("M10-13: the Dock is given the macOS cut", /appIconFile\(id, process\.platform === "darwin"\)/.test(handler) && /const folder = dock \? "app-icons-mac" : "app-icons"/.test(main))
    const builder = await fs.readFile(path.join(root, "electron-builder.yml"), "utf8")
    check("M10-13: only the macOS package carries the cuts", /\nmac:\n[\s\S]*?extraResources:\s*\n\s*- from: resources\/app-icons-mac\s*\n\s*to: app-icons-mac/.test(builder) && builder.indexOf("resources/app-icons-mac") > builder.indexOf("\nmac:"))
    const script = await fs.readFile(path.join(root, "scripts", "icons.mjs"), "utf8")
    check("M10-13: the icon script draws the cut from MCode's own icon", /await fs\.writeFile\(path\.join\(OUT, "icon\.icns"\), await buildIcns\(await macCut\(tile, MASTER\)\)\)/.test(script) && /path\.join\(APP_ICONS_MAC, `\$\{way\.id\}\.png`\), await macCut\(tile, 512\)/.test(script))
  }

  section("Round 10 (platforms): M10-20 the Linux launcher follows the chosen icon")
  {
    check("M10-20: the desktop id is CHROME_DESKTOP's, else the app name's", desktopId("mcode.desktop", "MCode") === "mcode" && desktopId(undefined, "MCode") === "mcode" && desktopId("../x", "Mé Code") === "me-code")
    check("M10-20: XDG_DATA_DIRS falls back to the standard pair", dataDirs("").join(",") === "/usr/local/share,/usr/share" && dataDirs("/a/:/b:/a").join(",") === "/a,/b")
    check("M10-20: Icon= is read from the main group only", entryIcon("[Desktop Entry]\nName=MCode\nIcon=mcode\n[Desktop Action x]\nIcon=other\n") === "mcode" && entryIcon("[Other]\nIcon=x\n") === "")

    const makeHost = (files: Map<string, Buffer>, extra: Partial<IconSyncHost>) => {
      const touched: string[] = []
      const host: IconSyncHost = {
        platform: "linux",
        home: "/home/me",
        appName: "MCode",
        chromeDesktop: "mcode.desktop",
        readBinary: async (file) => files.get(file),
        writeBinary: async (file, bytes) => void files.set(file, bytes),
        readText: async (file) => files.get(file)?.toString("utf8"),
        listDir: async (folder) => [...new Set([...files.keys()].filter((file) => file.startsWith(folder + "/")).map((file) => file.slice(folder.length + 1).split("/")[0]))],
        exists: async (file) => files.has(file),
        mkdirp: async () => {},
        touch: async (file) => void touched.push(file),
        resizePng: (bytes, size) => Buffer.concat([Buffer.from(`${size}:`), bytes]),
        ...extra,
      }
      return { host, touched }
    }
    const icon = Buffer.from("new-icon")

    // Installed from a package: a theme icon in two sizes.
    const system = new Map<string, Buffer>([
      ["/icons/brass.png", icon],
      ["/usr/share/applications/mcode.desktop", Buffer.from("[Desktop Entry]\nName=MCode\nIcon=mcode\n")],
      ["/usr/share/icons/hicolor/48x48/apps/mcode.png", Buffer.from("old")],
      ["/usr/share/icons/hicolor/256x256/apps/mcode.png", Buffer.from("old")],
      ["/usr/share/icons/hicolor/scalable/apps/mcode.svg", Buffer.from("old")],
    ])
    const installed = makeHost(system, {})
    const sync = linuxIconSync(installed.host)
    const first = await sync("/icons/brass.png")
    check("M10-20: an installed app gets a same-named icon in each size in the user's theme", first.changed && system.get("/home/me/.local/share/icons/hicolor/48x48/apps/mcode.png")?.toString() === "48:new-icon" && system.get("/home/me/.local/share/icons/hicolor/256x256/apps/mcode.png")?.toString() === "256:new-icon", first)
    check("M10-20: the system's own files are left alone", system.get("/usr/share/icons/hicolor/48x48/apps/mcode.png")?.toString() === "old")
    const second = await sync("/icons/brass.png")
    check("M10-20: the same icon again writes nothing", !second.changed && second.ok, second)
    const offLinux = await linuxIconSync({ ...installed.host, platform: "win32" })("/icons/brass.png")
    check("M10-20: nothing happens off Linux", !offLinux.changed && /not linux/.test(offLinux.reason))

    // An AppImage: only an entry of this app that names the icon file is followed.
    const bare = new Map<string, Buffer>([["/icons/brass.png", icon]])
    const lone = makeHost(bare, { appImage: "/opt/MCode.AppImage" })
    const skipped = await linuxIconSync(lone.host)("/icons/brass.png")
    check("M10-20: an AppImage without its own entry writes nothing", !skipped.changed && bare.size === 1, skipped)
    const withEntry = new Map<string, Buffer>([
      ["/icons/brass.png", icon],
      ["/data/applications/mcode.desktop", Buffer.from("[Desktop Entry]\nName=MCode\nIcon=/data/icons/mcode.png\n")],
    ])
    const image = makeHost(withEntry, { appImage: "/opt/MCode.AppImage", xdgDataHome: "/data/" })
    const written = await linuxIconSync(image.host)("/icons/brass.png")
    check("M10-20: an AppImage's entry icon is replaced and the entry touched", written.changed && withEntry.get("/data/icons/mcode.png")?.toString() === "new-icon" && image.touched.join() === "/data/applications/mcode.desktop", written)
    const main = await fs.readFile(path.join(root, "src/main/index.ts"), "utf8")
    // R34: Windows' window takes the colourway's .ico; on Linux it is still the PNG, and the launcher follows it.
    check("M10-20: choosing an icon on Linux syncs the launcher", /window\.setIcon\([^\n]*\)\s*\n\s*void syncLinuxIcon\(file\)/.test(main))
  }
}
