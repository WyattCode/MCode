/**
 * Round 9, MCode as a Windows application: what the package carries, how it
 * updates, installs and starts. Kept apart from smoke.ts the way the earlier
 * rounds are; smoke.ts calls `roundNineWindowsChecks` with its own check and
 * section. Nothing here starts Electron: the modules under test take their
 * Electron and file-system pieces as arguments.
 */
import fs from "node:fs/promises"
import path from "node:path"
import type { Check } from "./smoke-round5"
import { APP_NAME, noticeTitle, pinnedProfile, readSavedWindow, windowStateToSave } from "../src/main/desktop-rules"
import { PRUNE_DELAY_MS, prunableDumps, pruneCrashDumps, startLocalCrashDumps } from "../src/main/crash-dumps"
import { ENV_TIMEOUT_MS, expandPercent, parseRegQuery, parseShellEnv, refreshEnvironment, unionPath } from "../src/main/shell-env"
import { applyRuntimeEnv, bundledRuntimeEnv } from "../src/main/runtimes"
import { attachmentNote } from "../src/server/session/context"
import * as runtimesScript from "./runtimes.mjs"

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

/** Whether any of the texts imports the package (or a file inside it). */
function imports(texts: Iterable<string>, name: string): boolean {
  const quoted = name.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")
  const pattern = new RegExp(`(?:from\\s+|import\\s*\\(\\s*|require\\(\\s*)["']${quoted}(?:/[^"']*)?["']`)
  for (const text of texts) if (pattern.test(text)) return true
  return false
}

export async function roundNineWindowsChecks(check: Check, section: (name: string) => void): Promise<void> {
  const root = process.cwd()
  const pkg = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8")) as {
    dependencies: Record<string, string>
    devDependencies: Record<string, string>
  }

  section("Round 9 (Windows): the asar carries only what the main process loads")
  {
    /*
     * electron-builder copies every entry of `dependencies` into app.asar as it
     * is. A package only the renderer imports is already inside the renderer's
     * bundle, so listing it there ships it twice.
     */
    const mainSide = [
      ...(await sources(path.join(root, "src/main"))).values(),
      ...(await sources(path.join(root, "src/server"))).values(),
      ...(await sources(path.join(root, "src/preload"))).values(),
      ...(await sources(path.join(root, "src/shared"))).values(),
    ]
    const renderer = [...(await sources(path.join(root, "src/renderer"))).values()]
    const rendererOnly = Object.keys(pkg.dependencies).filter((name) => imports(renderer, name) && !imports(mainSide, name))
    check("no runtime dependency is one only the renderer imports", rendererOnly.length === 0, rendererOnly)
    const addons = ["@xterm/addon-unicode11", "@xterm/addon-webgl"]
    check(
      "the terminal's addons are build-time packages, beside xterm itself",
      addons.every((name) => pkg.devDependencies[name] && !pkg.dependencies[name] && imports(renderer, name)) && Boolean(pkg.devDependencies["@xterm/xterm"]),
    )
    // The links addon was listed and never imported: the terminal opens links through its own handler.
    const unused = "@xterm/addon-web-links"
    check("the links addon nothing imports is not listed at all", !pkg.dependencies[unused] && !pkg.devDependencies[unused] && !imports(renderer, unused))
    const lock = JSON.parse(await fs.readFile(path.join(root, "package-lock.json"), "utf8")) as {
      packages: Record<string, { dev?: boolean; dependencies?: Record<string, string>; devDependencies?: Record<string, string> }>
    }
    check(
      "and the lock file agrees, so npm ci installs them as dev packages and skips the links addon",
      addons.every((name) => lock.packages[`node_modules/${name}`]?.dev === true && !lock.packages[""]?.dependencies?.[name]) &&
        !lock.packages[`node_modules/${unused}`] &&
        !lock.packages[""]?.devDependencies?.[unused],
    )
  }

  section("Round 9 (Windows): the product is called MCode, and the profile stays where it was")
  {
    const manifest = pkg as unknown as { name: string; productName?: string }
    check("package.json names the product, so the packaged app reports MCode rather than mcode", manifest.productName === APP_NAME && manifest.name === "mcode")
    const main = await fs.readFile(path.join(root, "src/main/index.ts"), "utf8")
    const menu = await fs.readFile(path.join(root, "src/main/menu.ts"), "utf8")
    check(
      "the tray, the notification fallback and the app menu use the product name, never app.getName()",
      /tray\.setToolTip\(APP_NAME\)/.test(main) && /noticeTitle\(notice\)/.test(main) && /label: APP_NAME/.test(menu) && !/getName\(\)\)/.test(main.replace(/pinnedProfile\([^)]*\)/, "")) && !/app\.name\b/.test(menu),
    )
    check("a notice with neither project nor title is headed MCode", noticeTitle({}) === "MCode")
    const posix = path.posix.join
    const win = path.win32.join
    check(
      "Linux: the default profile the new name would give (~/.config/MCode) is pinned back to ~/.config/mcode",
      pinnedProfile("/home/u/.config/MCode", "/home/u/.config", "MCode", posix) === "/home/u/.config/mcode",
    )
    check(
      "a profile chosen on purpose - a probe's, or --user-data-dir - is never moved",
      pinnedProfile("/tmp/probe-data", "/home/u/.config", "MCode", posix) === undefined &&
        pinnedProfile("C:\\probe\\data", "C:\\Users\\u\\AppData\\Roaming", "Electron", win) === undefined,
    )
    check(
      "Windows: the same folder spelled the old way, so nothing moves on disk",
      pinnedProfile("C:\\Users\\u\\AppData\\Roaming\\MCode", "C:\\Users\\u\\AppData\\Roaming", "MCode", win) === "C:\\Users\\u\\AppData\\Roaming\\mcode" &&
        pinnedProfile("C:\\Users\\u\\AppData\\Roaming\\mcode", "C:\\Users\\u\\AppData\\Roaming", "mcode", win) === undefined,
    )
    const pinAt = main.indexOf("pinnedProfile(app.getPath(\"userData\")")
    const firstRead = main.indexOf("app.getPath(\"userData\")", pinAt + 40)
    check(
      "and the pin runs before anything else in the main module reads the profile",
      pinAt > 0 && main.indexOf("app.getPath(\"userData\")") === pinAt + "pinnedProfile(".length && firstRead > pinAt && /if \(pinned\) app\.setPath\("userData", pinned\)/.test(main),
    )
  }

  section("Round 9 (Windows): window state is MiMo's - saved as the last window goes, never full screen")
  {
    const normal = { x: 100, y: 80, width: 1200, height: 800 }
    const baseline = { x: 100, y: 80, width: 1200, height: 800 }
    check(
      "a minimised window writes nothing, so a maximised window minimised and quit from the tray reopens maximised",
      windowStateToSave({ minimized: true, fullScreen: false, maximized: false, normalBounds: normal }, baseline) === undefined,
    )
    check("a full-screen window writes nothing either", windowStateToSave({ minimized: false, fullScreen: true, maximized: false, normalBounds: normal }, baseline) === undefined)
    const maximized = windowStateToSave({ minimized: false, fullScreen: false, maximized: true, normalBounds: { ...normal, x: 101 } }, baseline)
    check(
      "a maximised window saves its normal bounds and the flag, and nothing about full screen",
      JSON.stringify(maximized) === JSON.stringify({ bounds: baseline, maximized: true }),
      maximized,
    )
    const moved = windowStateToSave({ minimized: false, fullScreen: false, maximized: false, normalBounds: { x: 300, y: 80, width: 1000, height: 800 } }, baseline)
    check("a real move or resize is taken as measured; scaling noise within 4 px is not", moved?.bounds.x === 300 && moved.bounds.width === 1000 && maximized?.bounds.x === 100)
    const old = readSavedWindow({ bounds: normal, maximized: true, fullScreen: true })
    check("a window.json an earlier release wrote with fullScreen reads back without it", JSON.stringify(old) === JSON.stringify({ bounds: normal, maximized: true }), old)
    check("a file without whole bounds is no state at all", readSavedWindow({ bounds: { x: 1, y: 2, width: 3 } }) === undefined && readSavedWindow(null) === undefined)
    const main = await fs.readFile(path.join(root, "src/main/index.ts"), "utf8")
    const state = await fs.readFile(path.join(root, "src/main/window-state.ts"), "utf8")
    const restoreBody = /export function restore\(\)[\s\S]*?\n\}/.exec(state)?.[0] ?? "fullScreen"
    check("the window is never put back into full screen at launch", !/setFullScreen\(true\)/.test(main) && !/fullScreen/i.test(restoreBody) && !/saved\.fullScreen/.test(main))
    check(
      "saving happens on close (for the last window) and for every window at quit, not on each move or resize",
      !/\.on\("(resize|move|maximize|unmaximize|enter-full-screen|leave-full-screen)"/.test(state) &&
        /if \(isLast\(\)\) saveWindowState\(window\)/.test(state) &&
        /before-quit[\s\S]{0,400}for \(const window of windows\) saveWindowState\(window\)/.test(main),
    )
  }

  section("Round 9 (Windows): native crashes leave a local dump and nothing is uploaded")
  {
    const started: unknown[] = []
    const folders: string[] = []
    const logged: string[] = []
    const folder = startLocalCrashDumps({
      reporter: { start: (options) => void started.push(options) },
      setCrashFolder: (where) => void folders.push(where),
      profile: path.join("C:", "profile"),
      log: (line) => void logged.push(line),
    })
    check(
      "the reporter starts with uploads off, writing into the profile's Crashpad folder, and says where",
      JSON.stringify(started) === JSON.stringify([{ uploadToServer: false }]) &&
        folder === path.join("C:", "profile", "Crashpad") &&
        folders[0] === folder &&
        logged.some((line) => line.includes(folder!)),
      { started, folders, logged },
    )
    const failed = startLocalCrashDumps({
      reporter: {
        start: () => {
          throw new Error("no crashpad")
        },
      },
      setCrashFolder: () => {},
      profile: "p",
      log: () => {},
    })
    check("a reporter that will not start is logged and the app goes on", failed === undefined)
    const day = 24 * 60 * 60 * 1000
    const now = 100 * day
    const dump = (name: string, ageDays: number, size = 4096) => ({ relativePath: name, sizeBytes: size, mtimeMs: now - ageDays * day })
    const recent = Array.from({ length: 12 }, (_, index) => dump(`reports/r${index}.dmp`, index / 10))
    const pruned = prunableDumps([...recent, dump("reports/old.dmp", 15), dump("reports/tiny.dmp", 1, 8), dump("reports/huge.dmp", 1, 200 * 1024 * 1024), dump("settings.dat", 90), dump("metadata", 90)], now).map((entry) => entry.relativePath)
    check(
      "pruning keeps MiMo's newest ten, drops dumps older than 14 days or implausibly small or large, and never touches Crashpad's own files",
      pruned.sort().join(",") === ["reports/huge.dmp", "reports/old.dmp", "reports/r10.dmp", "reports/r11.dmp", "reports/tiny.dmp"].join(","),
      pruned,
    )
    const removedFiles: string[] = []
    const tree: Record<string, { name: string; dir: boolean; size?: number; mtimeMs?: number }[]> = {
      [path.join("root")]: [
        { name: "reports", dir: true },
        { name: "settings.dat", dir: false, size: 40, mtimeMs: 0 },
      ],
      [path.join("root", "reports")]: [
        { name: "a.dmp", dir: false, size: 4096, mtimeMs: now },
        { name: "b.dmp", dir: false, size: 4096, mtimeMs: now - 20 * day },
      ],
    }
    const removed = await pruneCrashDumps(
      "root",
      {
        readdir: async (directory) => (tree[directory] ?? []).map((entry) => ({ name: entry.name, isDirectory: () => entry.dir, isFile: () => !entry.dir })),
        stat: async (file) => {
          const entry = tree[path.dirname(file)]?.find((candidate) => candidate.name === path.basename(file))
          return { size: entry?.size ?? 0, mtimeMs: entry?.mtimeMs ?? 0 }
        },
        unlink: async (file) => void removedFiles.push(file),
      },
      now,
    )
    check("the sweep walks Crashpad's folders and deletes only what the rule picks", JSON.stringify(removed) === JSON.stringify(["reports/b.dmp"]) && removedFiles.length === 1, { removed, removedFiles })
    const main = await fs.readFile(path.join(root, "src/main/index.ts"), "utf8")
    check(
      "the main process starts it before the app is ready and sweeps ten seconds after",
      PRUNE_DELAY_MS === 10_000 && /startLocalCrashDumps\(\{\s*reporter: crashReporter/.test(main) && main.indexOf("startLocalCrashDumps({") < main.indexOf("app.whenReady().then(async") && !/uploadToServer: true/.test(main),
    )
  }

  section("Round 9 (Windows): the environment is refreshed from the registry or the login shell at launch")
  {
    const machine = [
      "",
      "HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment",
      "    ComSpec    REG_EXPAND_SZ    %SystemRoot%\\system32\\cmd.exe",
      "    Path    REG_EXPAND_SZ    %SystemRoot%\\system32;C:\\Program Files\\Git\\cmd",
      "    NUMBER_OF_PROCESSORS    REG_SZ    8",
      "    USERNAME    REG_SZ    SYSTEM",
      "    Some Name    REG_SZ    with spaces",
      "    Blob    REG_BINARY    0102",
      "",
    ].join("\r\n")
    const user = [
      "",
      "HKEY_CURRENT_USER\\Environment",
      "    Path    REG_EXPAND_SZ    %USERPROFILE%\\AppData\\Local\\Programs\\Python\\Python312\\;C:\\Users\\u\\.cargo\\bin;c:\\program files\\git\\cmd\\",
      "    JAVA_HOME    REG_SZ    C:\\Program Files\\Java\\jdk-21",
      "    TOOL_DIR    REG_EXPAND_SZ    %JAVA_HOME%\\bin",
      "    张三的变量    REG_SZ    D:\\资料\\工具",
      "",
    ].join("\r\n")
    check(
      "reg query output: string values only, names with spaces, PATH under one spelling",
      JSON.stringify(parseRegQuery(machine)) ===
        JSON.stringify({ ComSpec: "%SystemRoot%\\system32\\cmd.exe", PATH: "%SystemRoot%\\system32;C:\\Program Files\\Git\\cmd", NUMBER_OF_PROCESSORS: "8", USERNAME: "SYSTEM", "Some Name": "with spaces" }),
      parseRegQuery(machine),
    )
    const calls: { file: string; args: string[]; options: Record<string, unknown> }[] = []
    const winEnv: Record<string, string | undefined> = {
      SystemRoot: "C:\\Windows",
      USERPROFILE: "C:\\Users\\u",
      USERNAME: "u",
      PATH: "C:\\Windows\\system32;C:\\Old\\bin",
      ComSpec: "C:\\Windows\\system32\\cmd.exe",
    }
    const fromRegistry = refreshEnvironment({
      env: winEnv,
      platform: "win32",
      development: false,
      home: "C:\\Users\\u",
      exec: (file, args, options) => {
        calls.push({ file, args, options })
        return Buffer.from(args.join(" ").includes("HKCU") ? user : machine, "utf8")
      },
    })
    check(
      "Windows reads both keys read-only through cmd with the UTF-8 code page, hidden and bounded",
      calls.length === 2 &&
        calls.every((call) => call.file === "C:\\Windows\\system32\\cmd.exe" && /chcp 65001>nul & "C:\\Windows\\System32\\reg\.exe" query "HK(LM|CU)\\/.test(call.args.at(-1) ?? "") && !/\badd\b|\bdelete\b|\bimport\b/i.test(call.args.join(" ")) && call.options.timeout === ENV_TIMEOUT_MS && call.options.windowsHide === true) &&
        /HKLM/.test(calls[0].args.at(-1) ?? "") && /HKCU/.test(calls[1].args.at(-1) ?? ""),
      calls.map((call) => call.args.at(-1)),
    )
    check(
      "the registry PATH comes first, expanded, machine before user, each folder once regardless of case or a trailing slash",
      winEnv.PATH === "C:\\Windows\\system32;C:\\Program Files\\Git\\cmd;C:\\Users\\u\\AppData\\Local\\Programs\\Python\\Python312\\;C:\\Users\\u\\.cargo\\bin;C:\\Old\\bin",
      winEnv.PATH,
    )
    check(
      "new variables are added and expanded, a non-ASCII one intact; values the process already has - USERNAME above all - stay",
      winEnv.JAVA_HOME === "C:\\Program Files\\Java\\jdk-21" && winEnv.TOOL_DIR === "C:\\Program Files\\Java\\jdk-21\\bin" && winEnv["张三的变量"] === "D:\\资料\\工具" && winEnv.USERNAME === "u" && winEnv.ComSpec === "C:\\Windows\\system32\\cmd.exe",
      winEnv,
    )
    check("and it says what it added", fromRegistry.source === "registry" && fromRegistry.added.includes("JAVA_HOME") && fromRegistry.added.includes("PATH") && !fromRegistry.added.includes("USERNAME"), fromRegistry)

    const failing = { PATH: "C:\\keep" } as Record<string, string | undefined>
    const failed = refreshEnvironment({
      env: failing,
      platform: "win32",
      development: false,
      home: "",
      exec: () => {
        throw new Error("ETIMEDOUT")
      },
    })
    check("a registry that cannot be read changes nothing", failed.source === "unchanged" && failing.PATH === "C:\\keep" && Object.keys(failing).length === 1)
    let devCalls = 0
    refreshEnvironment({ env: {}, platform: "win32", development: true, home: "", exec: () => (devCalls++, "") })
    check("a development run is left alone, as MiMo's is", devCalls === 0)

    const shellCalls: { file: string; args: string[]; options: Record<string, unknown> }[] = []
    const macEnv: Record<string, string | undefined> = { PATH: "/usr/bin:/bin", HOME: "/Users/u", ELECTRON_RUN_AS_NODE: "1", LANG: "en_US.UTF-8" }
    const printed = `Welcome banner\0__MCODE_LOGIN_ENV_BEGIN__\0PATH=/opt/homebrew/bin:/usr/bin:/bin\0HOMEBREW_PREFIX=/opt/homebrew\0LANG=zh_CN.UTF-8\0bad-name=x\0__MCODE_LOGIN_ENV_END__\0`
    const fromShell = refreshEnvironment({
      env: macEnv,
      platform: "darwin",
      development: false,
      home: "/Users/u",
      exec: (file, args, options) => {
        shellCalls.push({ file, args, options })
        return printed
      },
    })
    const baseline = shellCalls[0]?.options.env as Record<string, string> | undefined
    check(
      "macOS asks the interactive login shell, from home, without Electron's variables, bounded",
      shellCalls.length === 1 && shellCalls[0].file === "/bin/zsh" && shellCalls[0].args[0] === "-ilc" && shellCalls[0].options.cwd === "/Users/u" && shellCalls[0].options.timeout === ENV_TIMEOUT_MS && baseline?.PATH === "/usr/bin:/bin" && !("ELECTRON_RUN_AS_NODE" in (baseline ?? {})),
      shellCalls,
    )
    check(
      "the shell's PATH goes first, its new variables are added, and what the process set stays",
      macEnv.PATH === "/opt/homebrew/bin:/usr/bin:/bin" && macEnv.HOMEBREW_PREFIX === "/opt/homebrew" && macEnv.LANG === "en_US.UTF-8" && !("bad-name" in macEnv) && fromShell.source === "login-shell",
      macEnv,
    )
    const linuxCalls: string[][] = []
    refreshEnvironment({ env: { SHELL: "/usr/bin/fish", PATH: "/usr/bin" }, platform: "linux", development: false, home: "/home/u", exec: (file, args) => (linuxCalls.push([file, ...args]), "no markers here") })
    check("Linux uses $SHELL with -lc, and output without the markers changes nothing", linuxCalls[0]?.[0] === "/usr/bin/fish" && linuxCalls[0]?.[1] === "-lc")
    check(
      "the shell output parser takes the last marked block and only valid names",
      JSON.stringify(parseShellEnv("__MCODE_LOGIN_ENV_BEGIN__\0A=1\0__MCODE_LOGIN_ENV_END__\0echo __MCODE_LOGIN_ENV_BEGIN__\0B=2=3\x001C=4\0__MCODE_LOGIN_ENV_END__\0")) === JSON.stringify({ B: "2=3" }) &&
        parseShellEnv("A=1") === undefined,
    )
    check("percent expansion ignores case and keeps unknown names", expandPercent("%systemroot%\\x;%NOPE%", { SystemRoot: "C:\\W" }) === "C:\\W\\x;%NOPE%")
    check("POSIX PATH entries are compared exactly", unionPath("/a:/B", "/b:/a:", ":", false) === "/a:/B:/b")
    const main = await fs.readFile(path.join(root, "src/main/index.ts"), "utf8")
    check(
      "the refresh runs as the main module loads, before the backend starts",
      main.indexOf("refreshEnvironment({") > 0 && main.indexOf("refreshEnvironment({") < main.indexOf("startBackend(app.getPath") && /development: Boolean\(process\.env\.ELECTRON_RENDERER_URL\)/.test(main),
    )
  }

  section("Round 9 (Windows): Node.js, Python and ripgrep ship with the app, as MiMo's do")
  {
    const packaged = path.join("C:", "Apps", "MCode", "resources")
    const present = new Set([
      path.join(packaged, "runtimes", "win32-x64", "node", "node.exe"),
      path.join(packaged, "runtimes", "win32-x64", "node", "node_modules", "npm", "bin", "npm-cli.js"),
      path.join(packaged, "runtimes", "win32-x64", "python", "python.exe"),
      path.join(packaged, "runtimes", "win32-x64", "ripgrep", "rg.exe"),
      path.join("repo", "resources", "runtimes", "win32-x64", "python", "python.exe"),
    ])
    const found = bundledRuntimeEnv({ resourcesDir: packaged, devDir: path.join("repo", "resources", "runtimes"), platform: "win32", arch: "x64", exists: (file) => present.has(file) })
    check(
      "the packaged app names each runtime it carries, from resources/runtimes/win32-x64, and turns Python's bytecode writing off",
      found.MCODE_NODE === path.join(packaged, "runtimes", "win32-x64", "node", "node.exe") &&
        found.MCODE_NPM?.endsWith(path.join("npm", "bin", "npm-cli.js")) === true &&
        found.MCODE_PYTHON === path.join(packaged, "runtimes", "win32-x64", "python", "python.exe") &&
        found.MCODE_RIPGREP_PATH === path.join(packaged, "runtimes", "win32-x64", "ripgrep", "rg.exe") &&
        found.PYTHONDONTWRITEBYTECODE === "1",
      found,
    )
    const devOnly = bundledRuntimeEnv({ devDir: path.join("repo", "resources", "runtimes"), platform: "win32", arch: "x64", exists: (file) => present.has(file) })
    check("an unpackaged run finds the repository's copy, and a runtime that is missing is simply not named", JSON.stringify(devOnly) === JSON.stringify({ MCODE_PYTHON: path.join("repo", "resources", "runtimes", "win32-x64", "python", "python.exe"), PYTHONDONTWRITEBYTECODE: "1" }), devOnly)
    check("another platform looks in its own folder and finds nothing here", Object.keys(bundledRuntimeEnv({ resourcesDir: packaged, platform: "darwin", arch: "arm64", exists: (file) => present.has(file) })).length === 0)
    const env: Record<string, string | undefined> = { MCODE_PYTHON: "D:\\my\\python.exe" }
    const applied = applyRuntimeEnv(env, found)
    check(
      "a variable the user set wins; the rest are added, and nothing goes on PATH",
      env.MCODE_PYTHON === "D:\\my\\python.exe" && env.MCODE_NODE === found.MCODE_NODE && !applied.includes("MCODE_PYTHON") && applied.includes("MCODE_RIPGREP_PATH") && env.PATH === undefined,
      applied,
    )
    const main = await fs.readFile(path.join(root, "src/main/index.ts"), "utf8")
    check(
      "the main process names them before the backend starts, from the package or the repository",
      /applyRuntimeEnv\(\s*process\.env,\s*bundledRuntimeEnv\(\{\s*resourcesDir: app\.isPackaged \? process\.resourcesPath : undefined,\s*devDir: app\.isPackaged \? undefined : path\.join\(here, "\.\.", "\.\.", "resources", "runtimes"\)/.test(main) &&
        main.indexOf("bundledRuntimeEnv({") < main.indexOf("startBackend(app.getPath"),
    )

    // The script that fetches them.
    const hosts = /^https:\/\/(nodejs\.org\/dist\/|github\.com\/astral-sh\/python-build-standalone\/releases\/download\/|github\.com\/BurntSushi\/ripgrep\/releases\/download\/|files\.pythonhosted\.org\/packages\/)/
    const downloads = runtimesScript.DOWNLOADS as { id: string; file: string; url: string; size: number; sha256: string }[]
    check(
      "every download is a publisher's official https address with an exact size and sha256",
      downloads.length === 24 && downloads.every((entry) => hosts.test(entry.url) && entry.url.endsWith(encodeURIComponent(entry.file).replace(/%2B/g, "%2B")) && entry.size > 1000 && /^[0-9a-f]{64}$/.test(entry.sha256)),
      downloads.filter((entry) => !hosts.test(entry.url)).map((entry) => entry.url),
    )
    const wheels = (runtimesScript.WHEELS as { name: string; version: string; file: string }[]).map((wheel) => `${wheel.name} ${wheel.version}`)
    const mimo = ["chardet 7.6.0", "defusedxml 0.7.1", "et-xmlfile 2.0.0", "lxml 5.3.0", "numpy 2.5.2", "openpyxl 3.1.5", "pandas 2.2.3", "pillow 11.1.0", "pip 26.1.2", "pypdf 5.1.0", "pypdfium2 5.12.1", "python-dateutil 2.9.0.post0", "python-docx 1.1.2", "python-pptx 1.0.2", "pytz 2026.3.post1", "reportlab 4.2.5", "six 1.17.0", "typing-extensions 4.16.0", "tzdata 2026.3", "xlsxwriter 3.2.0"]
    check("the Python packages are MiMo's twenty, at MiMo's versions, as Windows x64 or pure wheels", JSON.stringify(wheels) === JSON.stringify(mimo) && (runtimesScript.WHEELS as { file: string }[]).every((wheel) => /(cp312-cp312-win_amd64|py3-none-win_amd64|none-any)\.whl$/.test(wheel.file)), wheels)
    check(
      "Node.js 24.18 (the line Electron 41 runs), Python 3.12.13 (MiMo's), ripgrep 15.1.0 (MiMo's), and no LibreOffice",
      runtimesScript.NODE.version === "24.18.1" && runtimesScript.PYTHON.version === "3.12.13" && runtimesScript.RIPGREP.version === "15.1.0" && !downloads.some((entry) => /libreoffice|soffice/i.test(entry.url)),
    )

    const scratch = await fs.mkdtemp(path.join((await import("node:os")).tmpdir(), "mcode-runtimes-"))
    const good = { file: "a.bin", size: 5, sha256: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824" }
    await fs.writeFile(path.join(scratch, "a.bin"), "hello")
    check("a file of the right size and hash passes", (await runtimesScript.fileProblem(path.join(scratch, "a.bin"), good)) === undefined)
    await fs.writeFile(path.join(scratch, "a.bin"), "hellp")
    check("one changed byte is refused by its hash", (await runtimesScript.fileProblem(path.join(scratch, "a.bin"), good)) === "hash")
    await fs.writeFile(path.join(scratch, "a.bin"), "hello!")
    check("a different length is refused by its size", (await runtimesScript.fileProblem(path.join(scratch, "a.bin"), good)) === "size")
    let refused = ""
    try {
      await runtimesScript.cachedArchive({ ...good, id: "a", url: "https://example.invalid/a.bin" }, scratch, () => {}, false)
    } catch (error) {
      refused = String(error)
    }
    check("a tampered cached archive is deleted and never used", /not in the cache/.test(refused) && !(await fs.stat(path.join(scratch, "a.bin")).catch(() => undefined)))
    await fs.mkdir(path.join(scratch, "tree", "python"), { recursive: true })
    await fs.writeFile(path.join(scratch, "tree", "python", "clean.txt"), "nothing local here")
    await fs.writeFile(path.join(scratch, "tree", "python", "launcher.exe"), Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from("c:\\builds\\staging\\python.exe", "utf16le")]))
    await fs.writeFile(path.join(scratch, "tree", "record.json"), '{"url": "file:///C:/Builds/Staging/x.whl"}')
    const leaks = (runtimesScript.findLocalPaths(path.join(scratch, "tree"), ["C:\\Builds\\Staging"]) as string[]).sort()
    check("the leak scan finds a build path in any spelling - UTF-16, lower case, forward slashes", JSON.stringify(leaks) === JSON.stringify([path.join("python", "launcher.exe"), "record.json"]), leaks)
    await fs.rm(scratch, { recursive: true, force: true })

    const licences = path.join(root, "resources", "licenses")
    const text = async (name: string) => (await fs.readFile(path.join(licences, name), "utf8").catch(() => "")).replace(/\r\n/g, "\n")
    const packages = await text("python-packages.txt")
    const sections = [...packages.matchAll(/^={79}\n(\S+) (\S+) - /gm)].map((match) => `${match[1].toLowerCase().replace(/_/g, "-")} ${match[2]}`)
    check(
      "the committed licence texts are the ones the script writes: each names the version it covers, one section per package",
      (await text("node.txt")).startsWith(`Node.js ${runtimesScript.NODE.version} (`) &&
        (await text("python.txt")).startsWith(`Python ${runtimesScript.PYTHON.version}, python-build-standalone ${runtimesScript.PYTHON.build} (`) &&
        /LICENSE\.openssl-3\.txt[\s\S]*Apache License/.test(await text("python.txt")) &&
        (await text("ripgrep.txt")).startsWith(`ripgrep ${runtimesScript.RIPGREP.version} (`) &&
        JSON.stringify(sections) === JSON.stringify(mimo) &&
        !/ships no licence file/.test(packages),
      sections,
    )
    const tree = path.join(root, "resources", "runtimes", "win32-x64")
    if (await fs.stat(path.join(tree, "python", "python.exe")).catch(() => undefined)) {
      check("and with the runtimes placed, they match the files in the tree exactly", (runtimesScript.checkLicences(tree, licences, false) as string[]).length === 0)
    } else {
      check("(no runtimes placed in this checkout: the tree comparison runs in scripts/runtimes.mjs at package time)", true)
    }

    const builder = await fs.readFile(path.join(root, "electron-builder.yml"), "utf8")
    const ignore = await fs.readFile(path.join(root, ".gitignore"), "utf8")
    const packageScript = await fs.readFile(path.join(root, "scripts", "package.mjs"), "utf8")
    check(
      "a Windows package places and verifies them first and carries them beside the asar; git never holds them",
      /win:[\s\S]*extraResources:\s*\n\s*- from: resources\/runtimes\/win32-x64\s*\n\s*to: runtimes\/win32-x64/.test(builder) &&
        /^resources\/runtimes\/$/m.test(ignore) &&
        /if \(status === 0 && forWindows\) status = run\("node", \["scripts\/runtimes\.mjs"\]\)/.test(packageScript) &&
        packageScript.indexOf("scripts/runtimes.mjs") < packageScript.indexOf("scripts/bump-version.mjs"),
    )
    const skills = await Promise.all(["docx", "pdf", "pptx", "xlsx", "data-analytics"].map((name) => fs.readFile(path.join(root, "resources", "skills", name, "SKILL.md"), "utf8")))
    check("the document skills tell the model to use the bundled Python and skip the install checks", skills.every((skill) => skill.includes('"$MCODE_PYTHON"') && skill.includes("$env:MCODE_PYTHON")))
    const before = process.env.MCODE_PYTHON
    process.env.MCODE_PYTHON = "C:\\x\\python.exe"
    const withPython = attachmentNote([{ path: "C:\\docs\\book.xlsx" }], "C:\\docs") ?? ""
    delete process.env.MCODE_PYTHON
    const withoutPython = attachmentNote([{ path: "C:\\docs\\book.xlsx" }], "C:\\docs") ?? ""
    if (before !== undefined) process.env.MCODE_PYTHON = before
    check(
      "an attached Office file points at the bundled Python when there is one, and asks to check the library when there is not",
      withPython.includes("MCODE_PYTHON") && !withPython.includes("Check that the library is installed") && withoutPython.includes("Check that the library is installed") && !withoutPython.includes("MCODE_PYTHON"),
    )
  }
}
