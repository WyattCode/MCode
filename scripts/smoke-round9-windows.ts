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
import { NsisUpdater } from "electron-updater"
import { HELPER_SWEEP_TIMEOUT_MS, compareVersions, createUpdater, feedProblem, helperSweep, isProtectedInstall, refusal, staleInstallers, type AutoUpdaterLike, type FeedInfo } from "../src/main/updater"
import { createTransactions } from "../src/main/update-transaction"

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
      "Node.js 24.18.1 (its npm 11.16.0 is the one MiMo bundles), Python 3.12.13 (MiMo's), ripgrep 15.1.0 (MiMo's), and no LibreOffice",
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

  section("Round 9 (Windows): updates through electron-updater - newer only, sha512 always, installed after the backend closes")
  {
    /*
     * The decisions run through electron-updater's own isUpdateAvailable (a
     * real NsisUpdater with a stand-in app); only the network and the download
     * are simulated.
     */
    const real = new NsisUpdater(null as never, {
      version: "0.2.5",
      name: "mcode",
      isPackaged: true,
      appUpdateConfigPath: "unused.yml",
      userDataPath: path.join(root, "out"),
      baseCachePath: path.join(root, "out"),
      whenReady: () => Promise.resolve(),
      quit: () => {},
      relaunch: () => {},
      onQuit: () => {},
    } as never)
    real.logger = null
    const sha512 = "A".repeat(86) + "=="
    const day = 24 * 60 * 60 * 1000
    const now = Date.parse("2026-09-17T00:00:00Z")
    const library = {
      autoDownload: false,
      autoInstallOnAppQuit: false,
      allowDowngrade: false,
      allowPrerelease: true,
      disableWebInstaller: false,
      requestHeaders: null as Record<string, string> | null,
      isUpdateSupported: (() => true) as AutoUpdaterLike["isUpdateSupported"],
      feeds: [] as unknown[],
      installs: [] as [boolean | undefined, boolean | undefined][],
      downloads: 0,
      info: { version: "0.2.5", files: [{ url: "MCode-0.2.5-x64.exe", sha512 }] } as FeedInfo,
      checkFails: false,
      downloadFails: false,
      setFeedURL(options: unknown) {
        this.feeds.push(options)
      },
      async checkForUpdates() {
        if (this.checkFails) throw new Error("HTTP 503")
        real.allowDowngrade = this.allowDowngrade
        real.isUpdateSupported = this.isUpdateSupported as never
        const available = await real.isUpdateAvailable(this.info as never)
        let downloadPromise: Promise<string[]> | null = null
        if (available && this.autoDownload) {
          this.downloads++
          downloadPromise = this.downloadFails ? Promise.reject(new Error("sha512 checksum mismatch, expected A== got B==")) : Promise.resolve([`C:/cache/pending/MCode-${this.info.version}-x64.exe`])
        }
        return { isUpdateAvailable: available, updateInfo: this.info, downloadPromise }
      },
      quitAndInstall(silent?: boolean, forceRun?: boolean) {
        this.installs.push([silent, forceRun])
      },
    }
    const timers: { kind: string; ms: number }[] = []
    const phases: string[] = []
    let feed = ""
    const updater = createUpdater({
      currentVersion: "0.2.5",
      feedURL: () => feed,
      autoUpdater: library,
      emit: (state) => phases.push(state.phase),
      log: () => {},
      now: () => now,
      scheduler: {
        setTimeout: (_run, ms) => timers.push({ kind: "timeout", ms }),
        setInterval: (_run, ms) => timers.push({ kind: "interval", ms }),
        clearTimeout: () => {},
        clearInterval: () => {},
      },
    })
    updater.start()
    updater.start()
    check("MiMo's schedule: first check at 5 s, then every 3 h, set up once", JSON.stringify(timers) === JSON.stringify([{ kind: "timeout", ms: 5000 }, { kind: "interval", ms: 3 * 60 * 60 * 1000 }]))
    check(
      "the library downloads on its own and installs on quit, as MiMo leaves it; no pre-releases, no web installer, and an anonymous staging id",
      library.autoDownload && library.autoInstallOnAppQuit && !library.allowPrerelease && library.disableWebInstaller && library.requestHeaders?.["x-user-staging-id"] === "none",
    )

    const noFeed = await updater.checkNow()
    check("with no feed configured nothing is fetched and the check says so", noFeed.outcome === "no-feed" && library.feeds.length === 0 && phases.length === 0)
    feed = "http://updates.example.com/mcode/"
    const plain = await updater.checkNow()
    check("a plain-http feed on the network is refused before anything is fetched (its hashes could be rewritten on the way)", plain.outcome === "failed" && /https/.test(plain.error ?? "") && library.feeds.length === 0)
    feed = "https://updates.example.com/mcode/"
    const current = await updater.checkNow()
    check(
      "the same version is current; the feed is set as a generic folder before the check",
      current.outcome === "current" && current.phase === "idle" && phases.join(",") === "checking,idle" && JSON.stringify(library.feeds.at(-1)) === JSON.stringify({ provider: "generic", url: feed, useMultipleRangeRequest: false }),
      { current, phases },
    )

    library.info = { version: "0.2.4", files: [{ url: "MCode-0.2.4-x64.exe", sha512 }], releaseDate: new Date(now - day).toISOString() }
    const older = await updater.checkNow()
    check("N9-1: an older version in the feed is not an update and is never downloaded", older.outcome === "current" && library.downloads === 0, older)
    library.info = { ...library.info, rollback: true, releaseDate: new Date(now - 40 * day).toISOString() }
    check("even a declared rollback is refused once it is more than 30 days old", (await updater.checkNow()).outcome === "current" && library.downloads === 0)
    library.info = { ...library.info, rollback: "yes" as unknown, releaseDate: new Date(now - day).toISOString() }
    check("and the declaration has to be exactly `rollback: true`", (await updater.checkNow()).outcome === "current" && library.downloads === 0)

    library.info = { version: "0.3.0", files: [{ url: "MCode-0.3.0-x64.exe" }], releaseNotes: "- faster" }
    const unverifiable = await updater.checkNow()
    check("N9-2: a newer version without a sha512 is refused as a failure, not downloaded", unverifiable.outcome === "failed" && unverifiable.during === "check" && /sha512/.test(unverifiable.error ?? "") && library.downloads === 0, unverifiable)
    library.info = { version: "0.3.0", files: [{ url: "MCode-0.3.0-x64.exe", sha512: "abc" }] }
    check("so is one whose sha512 is not a real digest", (await updater.checkNow()).outcome === "failed" && library.downloads === 0)

    library.info = { version: "0.3.0", files: [{ url: "MCode-0.3.0-x64.exe", sha512 }], releaseNotes: [{ version: "0.3.0", note: "- faster" }, { version: "0.2.9", note: "- smaller" }] }
    library.downloadFails = true
    phases.length = 0
    const badDownload = await updater.checkNow()
    check("a download that fails verification leaves nothing ready", badDownload.outcome === "failed" && badDownload.during === "download" && badDownload.ready === null && updater.readyVersion() === undefined && phases.join(",") === "checking,downloading,idle", { badDownload, phases })
    check("and nothing can be installed", updater.install("C:\\Users\\u\\AppData\\Local\\Programs\\MCode\\MCode.exe") === false && library.installs.length === 0)
    library.downloadFails = false
    phases.length = 0
    const pending = updater.checkNow()
    check("a second check while one runs is skipped", (await updater.checkNow()).outcome === "busy")
    const ready = await pending
    check(
      "a newer, verified installer downloads and becomes ready with its notes",
      ready.outcome === "ready" && ready.ready?.version === "0.3.0" && ready.ready.notes === "- faster\n\n- smaller" && phases.join(",") === "checking,downloading,ready",
      { ready, phases },
    )
    library.checkFails = true
    check("a failure after that is silent and keeps the ready update", (await updater.checkNow()).phase === "ready" && updater.readyVersion() === "0.3.0")
    library.checkFails = false

    library.info = { version: "0.2.4", files: [{ url: "MCode-0.2.4-x64.exe", sha512: "0".repeat(128) }], rollback: true, releaseDate: new Date(now - 2 * day).toISOString() }
    const rollbackUpdater = createUpdater({ currentVersion: "0.2.5", feedURL: () => feed, autoUpdater: library, emit: () => {}, log: () => {}, now: () => now })
    const rolledBack = await rollbackUpdater.checkNow()
    check("a declared, recent rollback (hex digest) is the one older version that downloads", rolledBack.outcome === "ready" && rolledBack.version === "0.2.4", rolledBack)

    check("N9-3: installing runs the installer silently and relaunches the app", updater.install("C:\\Users\\u\\AppData\\Local\\Programs\\MCode\\MCode.exe") && JSON.stringify(library.installs.at(-1)) === JSON.stringify([true, true]))
    updater.install("D:\\Apps\\MCode\\MCode.exe")
    check("an install elsewhere is silent too", JSON.stringify(library.installs.at(-1)) === JSON.stringify([true, true]))
    updater.install("C:\\Program Files\\MCode\\MCode.exe")
    check("under Program Files the installer shows its window, so Windows can ask for elevation (MiMo's rule)", JSON.stringify(library.installs.at(-1)) === JSON.stringify([false, true]))
    check(
      "which folders count as protected",
      isProtectedInstall("C:\\Program Files (x86)\\MCode\\MCode.exe") && isProtectedInstall("c:/program files/MCode/MCode.exe") && !isProtectedInstall("C:\\Users\\u\\Program Files Stuff\\MCode.exe") && !isProtectedInstall("D:\\Apps\\MCode\\MCode.exe"),
    )
    check(
      "versions compare by number, segment by segment",
      compareVersions("0.2.10", "0.2.9") === 1 && compareVersions("1.0.0", "0.9.9") === 1 && compareVersions("0.2.5", "0.2.5") === 0 && compareVersions("0.2.4", "0.2.5") === -1 && compareVersions("0.3", "0.3.0") === 0,
    )
    check(
      "the feed rules: https anywhere, http only to this machine",
      feedProblem("https://x.example/") === undefined && feedProblem("http://127.0.0.1:8080/f/") === undefined && feedProblem("http://localhost/f/") === undefined && feedProblem("http://10.0.0.2/f/") !== undefined && feedProblem("file:///C:/f/") !== undefined && feedProblem("not a url") !== undefined,
    )
    check(
      "the refusal rule on its own: legacy single-file entries are read too, equal versions are not updates",
      refusal({ version: "0.3.0", sha512 }, "0.2.5", now) === undefined && refusal({ version: "0.3.0" }, "0.2.5", now) !== undefined && refusal({ version: "0.2.5", sha512 }, "0.2.5", now) !== undefined,
    )

    // N9-16: what an earlier update left behind.
    const stale = staleInstallers({ tempNames: ["mcode-0.2.3.exe", "mcode-0.2.4.exe", "mcode-notes.txt", "mcode-0.2.4.exe.part", "other.exe", "mcode-0.3.0.dmg"], pendingFile: "MCode-0.2.5-x64.exe", currentVersion: "0.2.5" })
    check("the old updater's installers in the temporary folder are found, and nothing else there", JSON.stringify(stale.temp) === JSON.stringify(["mcode-0.2.3.exe", "mcode-0.2.4.exe", "mcode-0.3.0.dmg"]), stale)
    check(
      "the pending installer goes once its version is running (or older), and stays while it is still to be installed",
      stale.pending &&
        staleInstallers({ tempNames: [], pendingFile: "MCode-0.2.4-x64.exe", currentVersion: "0.2.5" }).pending &&
        !staleInstallers({ tempNames: [], pendingFile: "MCode-0.2.6-x64.exe", currentVersion: "0.2.5" }).pending &&
        !staleInstallers({ tempNames: [], currentVersion: "0.2.5" }).pending,
    )

    // MiMo's sweep of helpers running from resources\ before the installer.
    const sweep = helperSweep("C:\\Users\\o'brien\\AppData\\Local\\Programs\\MCode\\MCode.exe", "win32", true)
    check(
      "the sweep ends only processes under the install's resources folder, quoting the path for PowerShell",
      sweep?.file === "powershell.exe" &&
        sweep.prefix === "C:\\Users\\o'brien\\AppData\\Local\\Programs\\MCode\\resources\\" &&
        (sweep.args.at(-1) ?? "").includes("StartsWith('C:\\Users\\o''brien\\AppData\\Local\\Programs\\MCode\\resources\\'") &&
        HELPER_SWEEP_TIMEOUT_MS === 3000,
      sweep,
    )
    check(
      "and never runs for a development build, another platform, or a drive root",
      helperSweep("C:\\x\\MCode.exe", "win32", false) === undefined && helperSweep("/opt/MCode/mcode", "linux", true) === undefined && helperSweep("C:\\MCode.exe", "win32", true) === undefined,
    )

    // N9-4: the transaction record.
    let stored: string | undefined
    let clock = now
    const store = {
      read: () => stored,
      write: (text: string) => void (stored = text),
      remove: () => void (stored = undefined),
    }
    const transactions = createTransactions(store, () => clock)
    check("no record is nothing to report", transactions.reconcile("0.2.5") === undefined)
    transactions.begin("0.2.5", "0.3.0")
    transactions.markInstallerStarted()
    clock += 60_000
    check("the target version started: the update finished and the record goes", transactions.reconcile("0.3.0") === undefined && stored === undefined)
    transactions.begin("0.2.5", "0.3.0")
    transactions.markInstallerStarted()
    const mismatch = transactions.reconcile("0.2.5")
    check("the installer started but the old version came back: interrupted, said once", mismatch?.error === "version-mismatch" && mismatch.targetVersion === "0.3.0" && stored === undefined && transactions.reconcile("0.2.5") === undefined)
    transactions.begin("0.2.5", "0.3.0")
    check("a pending record that is still fresh is left for later (the installer may still be working)", transactions.reconcile("0.2.5") === undefined && stored !== undefined)
    clock += 61 * 60 * 1000
    check("an hour on, it is interrupted as stale", transactions.reconcile("0.2.5")?.error === "stale" && stored === undefined)
    transactions.begin("0.2.5", "0.3.0")
    transactions.markFailed(new Error("spawn EACCES"))
    check("an installer that failed to start is reported with its reason", JSON.stringify(transactions.reconcile("0.2.5")) === JSON.stringify({ targetVersion: "0.3.0", error: "spawn EACCES" }))
    stored = "{not json"
    check("a damaged record is reported and removed", transactions.reconcile("0.2.5")?.error === "invalid" && stored === undefined)
    const unwritable = createTransactions({
      read: () => undefined,
      write: () => {
        throw new Error("EACCES")
      },
      remove: () => {},
    })
    check("a record that cannot be written does not stop anything", unwritable.begin("0.2.5", "0.3.0") === false)

    // How the main process wires it.
    const main = await fs.readFile(path.join(root, "src/main/index.ts"), "utf8")
    const handler = /ipcMain\.handle\("mcode:install-update"[\s\S]*?\n {2}\}\)\n/.exec(main)?.[0] ?? ""
    // Everything the handler does itself, leaving out the deferred install it hands to the quit path.
    const beforeRun = handler.replace(/pendingInstall = \(\) => \{[\s\S]*?\n {4}\}\n/, "")
    check(
      "the install request records the transaction and quits; the installer itself waits for the quit path",
      /updateTransactions\.begin\(pkg\.version, target\)/.test(beforeRun) &&
        beforeRun.length < handler.length &&
        !/\.install\(|quitAndInstall|openPath|spawn/.test(beforeRun) &&
        /updater\.install\(process\.execPath\)\) updateTransactions\.markInstallerStarted\(\)/.test(handler) &&
        /helperSweep\(process\.execPath, process\.platform, app\.isPackaged\)/.test(handler),
    )
    check(
      "and the quit path runs it only after the backend has closed (or at once when there is none)",
      /void closed\.finally\(\(\) => \{\s*runPendingInstall\(\)\s*app\.quit\(\)/.test(main) && /if \(!backend\) return runPendingInstall\(\)/.test(main),
    )
    check(
      "electron-updater is loaded the way MiMo loads it, the feed comes from the setting or MCODE_UPDATE_URL, and the interruption reaches the window",
      /import\("electron-updater"\)/.test(main) &&
        /process\.env\.MCODE_UPDATE_URL\?\.trim\(\) \|\| backend\?\.runtime\.config\.get\(\)\.updateFeed/.test(main) &&
        /updateTransactions\.reconcile\(pkg\.version\)/.test(main) &&
        /report \? \{ \.\.\.state, interrupted: report \}/.test(main),
    )
    const app = await fs.readFile(path.join(root, "src/renderer/src/App.vue"), "utf8")
    check("the window shows the interruption as a failure notice", /if \(state\.interrupted\) notifyFailure\(t\("update\.interrupted"/.test(app) && !/no-installer|update\.found/.test(app))
    const updaterSource = await fs.readFile(path.join(root, "src/main/updater.ts"), "utf8")
    check("MCode's own feed code is gone: no JSON feed, no hand-rolled download or sha256", !/fetchFeed|parseFeed|sha256\(|createHash|fetch\(/.test(updaterSource + handler) && !/node:crypto/.test(updaterSource))
    const builder = await fs.readFile(path.join(root, "electron-builder.yml"), "utf8")
    const packageScript = await fs.readFile(path.join(root, "scripts", "package.mjs"), "utf8")
    check(
      "the package writes app-update.yml and latest.yml for a placeholder that can never resolve, and never publishes; the private repository is named nowhere",
      /^publish:\n {2}provider: generic\n {2}url: https:\/\/updates\.invalid\/mcode\/$/m.test(builder) && !/provider: github|WyattCode/.test(builder) && /"--publish", "never"/.test(packageScript),
    )
  }

  section("Round 9 (Windows): a one-click, per-user installer whose uninstall cleans up after MCode")
  {
    const builder = await fs.readFile(path.join(root, "electron-builder.yml"), "utf8")
    const nsis = /^nsis:\n((?: {2}.*\n|\s*#.*\n)+)/m.exec(builder)?.[1] ?? ""
    check(
      "N9-6: one click, current user only, no folder page, and MCode's own include",
      /^ {2}oneClick: true$/m.test(nsis) && /^ {2}perMachine: false$/m.test(nsis) && !/allowToChangeInstallationDirectory|selectPerMachineByDefault/.test(nsis) && /^ {2}include: build\/installer\.nsh$/m.test(nsis),
      nsis,
    )
    const script = await fs.readFile(path.join(root, "build", "installer.nsh"), "utf8").catch(() => "")
    const init = /!macro customInit\n([\s\S]*?)!macroend/.exec(script)?.[1] ?? ""
    check(
      "a first install gets the product's folder name; an install the registry knows, or a /D= choice, is left where it is",
      /ReadRegStr \$(\w+) HKCU "\$\{INSTALL_REGISTRY_KEY\}" InstallLocation/.test(init) &&
        /GetDParameter/.test(init) &&
        /\$\{if\} \$mcodeKnownFolder == ""\n\s*\$\{andIf\} \$mcodeChosenFolder == ""/.test(init) &&
        /StrCpy \$INSTDIR "\$mcodeProgramsFolder\\\$\{PRODUCT_FILENAME\}"/.test(init),
      init,
    )
    const uninstall = /!macro customUnInstall\n([\s\S]*?)!macroend/.exec(script)?.[1] ?? ""
    check(
      "N9-10: a real uninstall removes the mcode: handler only when it points into this installation, and the updater cache; an update's uninstall touches neither",
      /^\s*\$\{ifNot\} \$\{isUpdated\}/.test(uninstall) &&
        /ReadRegStr \$mcodeLinkCommand HKCU "Software\\Classes\\mcode\\shell\\open\\command" ""/.test(uninstall) &&
        /\$\{if\} \$mcodeLinkHead == "\$INSTDIR\\"\n\s*DeleteRegKey HKCU "Software\\Classes\\mcode"/.test(uninstall) &&
        (uninstall.match(/DeleteRegKey/g) ?? []).length === 1 &&
        /RMDir \/r "\$LOCALAPPDATA\\\$\{APP_PACKAGE_NAME\}-updater"/.test(uninstall) &&
        !/\$APPDATA|RMDir \/r "\$INSTDIR/.test(uninstall),
      uninstall,
    )
    const main = await fs.readFile(path.join(root, "src/main/index.ts"), "utf8")
    const scheme = /export const LINK_SCHEME = "([^"]+)"/.exec(await fs.readFile(path.join(root, "src/shared/session-link.ts"), "utf8"))?.[1]
    check("the key it removes is the one the app registers", scheme === "mcode" && /app\.setAsDefaultProtocolClient\(LINK_SCHEME\)/.test(main), scheme)
    check("the updater cache it removes is the one electron-updater uses (package name + -updater)", (pkg as unknown as { name: string }).name === "mcode" && main.includes("`${pkg.name}-updater`"))
  }
}
