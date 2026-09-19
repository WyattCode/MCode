/**
 * Round 14 (lane P): the video cards' network, and packaging, install and
 * update. Kept apart from smoke.ts the way the earlier rounds are; smoke.ts
 * calls `roundFourteenPackagingChecks` with its own check and section.
 *
 * P14-1 runs under Electron itself (smoke-round14-net-electron.ts), against a
 * local https server with a throwaway certificate; the rest drive the plain
 * functions or read the sources and build configuration.
 */
import { execFileSync, spawn } from "node:child_process"
import fs from "node:fs/promises"
import { createServer } from "node:net"
import os from "node:os"
import path from "node:path"
import { createRequire } from "node:module"
import type { Check } from "./smoke-round5"
import * as runtimesScript from "./runtimes.mjs"
import { NsisUpdater } from "electron-updater"
import { createUpdater, resyncInstallerBase, type AutoUpdaterLike, type FeedInfo } from "../src/main/updater"

type Seen = { host: string; path: string; method: string; referer?: string; agent?: string; cookie?: string }
type Answer = { status: number; type: string | null; bytes: number }
type NetResult = {
  error?: string
  hop?: { answer: Answer; seen: Seen[] }
  relative?: { answer: Answer; seen: Seen[] }
  away?: { answer: Answer; seen: Seen[] }
  endless?: { answer: Answer; ms: number }
  slow?: { answer: Answer; ms: number }
  landing?: { target?: { id: Record<string, unknown> }; seen: Seen[] }
  cookies?: unknown[]
  preAborted?: string
}

const COVER_HOSTS = new Set(["i0.hdslb.com", "i1.hdslb.com", "evil.example", "b23.tv"])

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer()
    probe.on("error", reject)
    probe.listen(0, "127.0.0.1", () => {
      const port = (probe.address() as { port: number }).port
      probe.close(() => resolve(port))
    })
  })
}

/** A body in `source` from `opening` to its matching brace, or "" when it is not there. */
function body(source: string, opening: string): string {
  const start = source.indexOf(opening)
  if (start < 0) return ""
  const open = source.indexOf("{", start + opening.length - 1)
  let depth = 0
  for (let i = open; i >= 0 && i < source.length; i++) {
    if (source[i] === "{") depth++
    else if (source[i] === "}" && --depth === 0) return source.slice(open, i + 1)
  }
  return ""
}

const idle = { setTimeout: () => 0, setInterval: () => 0, clearTimeout: () => {}, clearInterval: () => {} }

/** A real NsisUpdater with a stand-in app; the quit handler it registers and the installs it starts are caught. */
function standInUpdater(cache: string) {
  const quits: ((code: number) => void)[] = []
  const real = new NsisUpdater(null as never, {
    version: "0.2.5",
    name: "mcode",
    isPackaged: true,
    appUpdateConfigPath: "unused.yml",
    userDataPath: cache,
    baseCachePath: cache,
    whenReady: () => Promise.resolve(),
    quit: () => {},
    relaunch: () => {},
    onQuit: (handler: (code: number) => void) => quits.push(handler),
  } as never)
  real.logger = null
  const installs: unknown[][] = []
  Object.assign(real, { install: (...args: unknown[]) => (installs.push(args), true) })
  return { real, quits, installs, library: real as unknown as AutoUpdaterLike }
}

/** Runs the P14-1 helper under Electron and returns what it saw. */
async function underElectron(root: string): Promise<NetResult> {
  const work = await fs.mkdtemp(path.join(os.tmpdir(), "mcode-r14-net-"))
  try {
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", path.join(work, "key.pem"), "-out", path.join(work, "cert.pem"), "-days", "1", "-subj", "/CN=i0.hdslb.com"], {
      stdio: "ignore",
      // Git Bash would otherwise rewrite "/CN=..." into a Windows path.
      env: { ...process.env, MSYS_NO_PATHCONV: "1", MSYS2_ARG_CONV_EXCL: "*" },
    })
    const bundle = path.join(root, "out", "smoke-round14-net.cjs")
    execFileSync(
      process.execPath,
      [
        path.join(root, "node_modules", "esbuild", "bin", "esbuild"),
        "scripts/smoke-round14-net-electron.ts",
        "--bundle",
        "--platform=node",
        "--format=cjs",
        "--target=node22",
        "--alias:@shared=./src/shared",
        "--packages=external",
        `--outfile=${bundle}`,
        "--log-level=error",
      ],
      { cwd: root, stdio: "ignore" },
    )
    const verdict = path.join(work, "net.json")
    const electron = createRequire(import.meta.url)("electron") as unknown as string
    const child = spawn(electron, [bundle, String(await freePort()), work, verdict, `--user-data-dir=${path.join(work, "profile")}`], { stdio: "ignore", windowsHide: true })
    await new Promise<void>((resolve) => child.on("close", () => resolve()))
    const text = await fs.readFile(verdict, "utf8").catch(() => "")
    return text ? (JSON.parse(text) as NetResult) : { error: "the helper wrote nothing" }
  } finally {
    await fs.rm(work, { recursive: true, force: true }).catch(() => undefined)
  }
}

export async function roundFourteenPackagingChecks(check: Check, section: (name: string) => void): Promise<void> {
  const root = process.cwd()
  const read = (file: string) => fs.readFile(path.join(root, file), "utf8")

  // ------------------------------------------------------------------ P14-1
  section("Round 14 (P14-1): video cards reach the web through Chromium, as MiMo's do")
  {
    const embed = await read("src/main/media-embed.ts")
    const code = embed.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "")
    check("no lookup and no cover uses Node's fetch any more", !/(^|[^.\w])fetch\(/.test(code) && (code.match(/chromiumFetch\(/g) ?? []).length >= 4, code.match(/[\w.]*fetch\(/gi))
    check("the cover proxy is handed Chromium's fetch", /serveCover\(request\.url, request\.method, chromiumFetch\)/.test(embed))

    const net = await underElectron(root)
    const hosts = (seen: Seen[] | undefined) => (seen ?? []).filter((entry) => COVER_HOSTS.has(entry.host))
    check("the Electron helper ran", !net.error && Boolean(net.hop), net.error)
    const hop = hosts(net.hop?.seen)
    check(
      "a cover is fetched by Chromium with its platform's referer and MiMo's agent, and a redirect to another cover host is followed hop by hop",
      net.hop?.answer.status === 200 && net.hop.answer.type === "image/png" && net.hop.answer.bytes === 16 &&
        hop.map((entry) => `${entry.host}${entry.path}`).join(" ") === "i0.hdslb.com/hop.png i1.hdslb.com/ok.png" &&
        hop.every((entry) => entry.referer === "https://www.bilibili.com/" && /Chrome\/126\.0 Safari/.test(entry.agent ?? "")),
      net.hop,
    )
    check("a relative redirect is resolved against the hop it came from", net.relative?.answer.status === 200 && hosts(net.relative.seen).map((entry) => entry.path).join(" ") === "/relative.png /ok.png", net.relative)
    check("a redirect off the host list is refused and never requested", net.away?.answer.status === 502 && !hosts(net.away.seen).some((entry) => entry.host === "evil.example") && hosts(net.away.seen).length === 1, net.away)
    check("a picture that never ends is cut off at the cap", net.endless?.answer.status === 502 && (net.endless.ms ?? 99_999) < 10_000, net.endless)
    check("a cover that does not answer in time is refused", net.slow?.answer.status === 502 && (net.slow.ms ?? 0) >= 400 && net.slow.ms < 5_000, net.slow)
    check(
      "a b23.tv short link is read hop by hop to the video it stands for",
      net.landing?.target?.id?.bvid === "BV1xx411c7mD" && hosts(net.landing.seen).length === 1 && hosts(net.landing.seen)[0]?.method === "HEAD",
      net.landing,
    )
    const everything = [net.hop, net.relative, net.away, net.landing].flatMap((part) => hosts(part?.seen))
    check("no cookie is sent, and none a server sets is kept", everything.length > 0 && everything.every((entry) => !entry.cookie) && Array.isArray(net.cookies) && net.cookies.length === 0, net.cookies)
    check("an aborted request fails as an abort", net.preAborted === "AbortError", net.preAborted)
  }

  // ------------------------------------------------------------------ P14-2
  section("Round 14 (P14-2): an OS shutdown never starts a downloaded update's installer")
  {
    const main = await read("src/main/index.ts")
    const { quits, installs, library } = standInUpdater(os.tmpdir())
    const updater = createUpdater({ currentVersion: "0.2.5", feedURL: () => "", autoUpdater: library, emit: () => {}, log: () => {}, scheduler: idle })
    // What electron-updater does once a download completes.
    ;(library as unknown as { addQuitHandler(): void }).addQuitHandler()
    quits.forEach((quit) => quit(0))
    check("an ordinary quit with an update waiting runs electron-updater's installer (the control)", quits.length === 1 && installs.length === 1, { quits: quits.length, installs })
    updater.holdInstallOnQuit()
    quits.forEach((quit) => quit(0))
    check("once the OS is ending the session, the same quit starts nothing", library.autoInstallOnAppQuit === false && installs.length === 1, installs)
    const note = body(main, "function noteOsQuit(): void {")
    check("noteOsQuit holds the install, before the quit it announces", /liveUpdater\?\.holdInstallOnQuit\(\)/.test(note), note)
    check(
      "the updater is reachable there as soon as it exists, and one created after the OS spoke holds at once",
      /liveUpdater = created\s+if \(osQuitting\) created\.holdInstallOnQuit\(\)/.test(main),
    )
    check("every OS-quit path goes through noteOsQuit", (main.match(/noteOsQuit\(\)/g) ?? []).length >= 4)
  }

  // ------------------------------------------------------------------ P14-4
  section("Round 14 (P14-4): electron-updater's minimumSystemVersion check still runs before MCode's rules")
  {
    const { real, library } = standInUpdater(os.tmpdir())
    const logged: string[] = []
    createUpdater({ currentVersion: "0.2.5", feedURL: () => "", autoUpdater: library, emit: () => {}, log: (line) => logged.push(line), scheduler: idle })
    const sha512 = "A".repeat(86) + "=="
    const available = (info: Record<string, unknown>) => (real as unknown as { isUpdateAvailable(info: unknown): Promise<boolean> }).isUpdateAvailable(info)
    const system = os.release()
    check("a newer, verified version for this system is still an update", await available({ version: "0.3.0", files: [{ url: "MCode-0.3.0-x64.exe", sha512 }], minimumSystemVersion: "1.0.0" }), system)
    check(
      "one whose feed asks for a newer system than this one is not",
      !(await available({ version: "0.3.0", files: [{ url: "MCode-0.3.0-x64.exe", sha512 }], minimumSystemVersion: "99.0.0" })) && logged.some((line) => line.includes("99.0.0")),
      logged,
    )
    check("and MCode's own rules still follow it (no sha512, no update)", !(await available({ version: "0.3.0", files: [{ url: "MCode-0.3.0-x64.exe" }], minimumSystemVersion: "1.0.0" })))
  }

  // ------------------------------------------------------------------ P14-5
  section("Round 14 (P14-5): a finished download becomes the next differential base (MiMo's installer.exe re-sync)")
  {
    const cache = await fs.mkdtemp(path.join(os.tmpdir(), "mcode-r14-updater-"))
    try {
      const pending = path.join(cache, "pending")
      await fs.mkdir(pending, { recursive: true })
      const downloaded = path.join(pending, "MCode-0.3.0-x64.exe")
      await fs.writeFile(downloaded, "new installer")
      await fs.writeFile(path.join(cache, "installer.exe"), "old installer")
      const sha512 = "A".repeat(86) + "=="
      const info: FeedInfo = { version: "0.3.0", files: [{ url: "MCode-0.3.0-x64.exe", sha512 }] }
      const library: AutoUpdaterLike = {
        autoDownload: false,
        autoInstallOnAppQuit: false,
        allowDowngrade: false,
        allowPrerelease: true,
        disableWebInstaller: false,
        requestHeaders: null,
        isUpdateSupported: () => true,
        setFeedURL: () => {},
        checkForUpdates: async () => ({ isUpdateAvailable: true, updateInfo: info, downloadPromise: Promise.resolve([downloaded]) }),
        quitAndInstall: () => {},
      }
      const updater = createUpdater({ currentVersion: "0.2.5", feedURL: () => "https://updates.example.com/", autoUpdater: library, emit: () => {}, log: () => {}, scheduler: idle })
      const result = await updater.checkNow()
      const base = await fs.readFile(path.join(cache, "installer.exe"), "utf8").catch(() => "")
      const left = await fs.readdir(cache)
      check(
        "once the download is verified, the cache's installer.exe is the new installer, swapped in whole",
        result.outcome === "ready" && base === "new installer" && !left.some((name) => name.endsWith(".tmp")),
        { result: result.outcome, base, left },
      )
      check("and the downloaded installer itself stays pending for the install", (await fs.readFile(downloaded, "utf8").catch(() => "")) === "new installer")
      const logged: string[] = []
      const elsewhere = path.join(cache, "MCode-0.3.1-x64.exe")
      await fs.writeFile(elsewhere, "stray")
      check(
        "only an .exe in a pending folder is taken, and a missing file costs nothing but a log line",
        !(await resyncInstallerBase(elsewhere, () => {})) && !(await resyncInstallerBase(path.join(pending, "MCode-0.3.0.zip"), () => {})) &&
          !(await resyncInstallerBase(path.join(pending, "gone.exe"), (line) => logged.push(line))) && logged.length === 1 &&
          (await fs.readFile(path.join(cache, "installer.exe"), "utf8")) === "new installer",
        logged,
      )
    } finally {
      await fs.rm(cache, { recursive: true, force: true }).catch(() => undefined)
    }
  }

  // ------------------------------------------------------------------ P14-6
  section("Round 14 (P14-6): no automatic updates on macOS (M10-8 declined)")
  {
    const main = await read("src/main/index.ts")
    const builder = await read("electron-builder.yml")
    check("the updater is gated on the platform", /const autoUpdates = process\.platform !== "darwin"/.test(main))
    check(
      "on macOS electron-updater is never even loaded, so nothing is scheduled or downloaded",
      /\(autoUpdates \? import\("electron-updater"\) : Promise\.reject\(/.test(main) && (main.match(/import\("electron-updater"\)/g) ?? []).length === 1,
    )
    check("a check asked for there says no feed is configured, not that something broke", /if \(!updater && !autoUpdates\) return \{ \.\.\.idleUpdate, outcome: "no-feed" \}/.test(main))
    const mac = /\nmac:\n([\s\S]*?)\n\S/.exec(builder)?.[1] ?? ""
    check("and the mac build no longer makes the zip only an updater would use", /target:\s*\n\s*- dmg/.test(mac) && !/^\s*- zip\s*$/m.test(mac), mac.slice(0, 300))
  }

  // ------------------------------------------------------------------ P14-8
  section("Round 14 (P14-8): npm's install-script allowlist names the Electron actually used")
  {
    const pkg = JSON.parse(await read("package.json")) as { devDependencies: Record<string, string>; allowScripts?: Record<string, boolean> }
    const pinned = pkg.devDependencies.electron
    const entries = Object.keys(pkg.allowScripts ?? {}).filter((key) => key === "electron" || key.startsWith("electron@"))
    check(
      "the one electron entry is the pinned version, so its install script (the binary download) may run",
      /^\d+\.\d+\.\d+$/.test(pinned) && entries.length === 1 && entries[0] === `electron@${pinned}` && pkg.allowScripts?.[entries[0]] === true,
      { pinned, entries },
    )
  }

  // ------------------------------------------------------------------ P14-7
  section("Round 14 (P14-7): app.asar leaves out node_modules' source maps, TypeScript and docs, and nothing the app runs")
  {
    /*
     * A dry run through electron-builder's own node_modules matcher (what a
     * package build filters every dependency file with), over the runtime
     * dependencies and theirs, without packaging anything.
     */
    const load = createRequire(import.meta.url)
    const yaml = load("js-yaml") as { load(text: string): { files: unknown } }
    const { getNodeModuleFileMatcher } = load("app-builder-lib/out/fileMatcher") as {
      getNodeModuleFileMatcher(appDir: string, destination: string, expand: (text: string) => string, options: object, info: object): { isEmpty(): boolean; createFilter(): (file: string, stat: object) => boolean }
    }
    const config = yaml.load(await read("electron-builder.yml"))
    const matcher = getNodeModuleFileMatcher(root, "app", (text) => text, {}, { config, debugLogger: { isEnabled: false } })
    // With no exclusions electron-builder filters nothing (NodeModuleCopyHelper), and neither does this.
    const filter = matcher.isEmpty() ? () => true : matcher.createFilter()
    const pkg = JSON.parse(await read("package.json")) as { dependencies: Record<string, string> }
    // The runtime closure: each dependency's own dependencies, resolved beside it or at the top.
    const dirs = new Map<string, string>()
    const visit = async (name: string, from: string) => {
      for (let at = from; ; ) {
        const candidate = path.join(at, "node_modules", name)
        const manifest = await fs.readFile(path.join(candidate, "package.json"), "utf8").catch(() => "")
        if (manifest) {
          if (dirs.has(candidate)) return
          dirs.set(candidate, path.relative(root, candidate).replace(/\\/g, "/"))
          const deps = JSON.parse(manifest) as { dependencies?: Record<string, string>; optionalDependencies?: Record<string, string> }
          for (const dep of Object.keys({ ...deps.dependencies, ...deps.optionalDependencies })) await visit(dep, candidate)
          return
        }
        if (at === root) return
        // Up to the package (or the project) that holds this one's node_modules.
        do at = path.dirname(at)
        while (at !== root && (path.basename(at) === "node_modules" || path.basename(at).startsWith("@")))
      }
    }
    for (const name of Object.keys(pkg.dependencies)) await visit(name, root)
    const kept: string[] = []
    const dropped: string[] = []
    const walk = async (dir: string, destination: string, top: string) => {
      for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        const file = path.join(dir, entry.name)
        if (entry.isDirectory()) {
          if (entry.name !== "node_modules") await walk(file, destination, top)
          continue
        }
        const rel = path.join(destination, path.relative(top, file)).replace(/\\/g, "/")
        const stat = Object.assign(await fs.lstat(file), { moduleFullFilePath: rel })
        ;(filter(file, stat) ? kept : dropped).push(rel)
      }
    }
    for (const [dir, destination] of dirs) await walk(dir, destination, dir)
    check("the runtime dependencies were found", dirs.size >= 15 && kept.length > 500, { dirs: dirs.size, kept: kept.length })
    check(
      "every source map, TypeScript source and declaration is left out",
      dropped.some((rel) => rel.endsWith(".map")) && dropped.some((rel) => rel.endsWith(".d.ts")) && !kept.some((rel) => /\.(map|ts|mts|cts)$/.test(rel)),
      kept.filter((rel) => /\.(map|ts|mts|cts)$/.test(rel)).slice(0, 10),
    )
    check("nothing else is: every dropped file is a map, TypeScript or markdown", dropped.every((rel) => /\.(map|ts|mts|cts|md)$/.test(rel)), dropped.filter((rel) => !/\.(map|ts|mts|cts|md)$/.test(rel)).slice(0, 10))
    check(
      "no script, JSON, native module or licence is touched",
      !dropped.some((rel) => /\.(c|m)?js$|\.json$|\.node$|\.exe$|\.dll$/.test(rel) || /licen[cs]e/i.test(path.basename(rel))) && kept.some((rel) => /^node_modules\/sax\/LICENSE\.md$/.test(rel)),
      dropped.filter((rel) => /licen[cs]e/i.test(rel)),
    )
    const entryPoints: string[] = []
    for (const [dir, destination] of dirs) {
      const manifest = JSON.parse(await fs.readFile(path.join(dir, "package.json"), "utf8")) as { main?: string; exports?: unknown }
      const collect = (value: unknown, key?: string): void => {
        if (typeof value === "string") {
          if (key !== "types" && key !== "typings" && value.startsWith(".")) entryPoints.push(path.posix.join(destination, value))
        } else if (value && typeof value === "object") for (const [inner, next] of Object.entries(value)) collect(next, inner)
      }
      if (manifest.main) entryPoints.push(path.posix.join(destination, manifest.main))
      collect(manifest.exports)
    }
    const wanted = entryPoints.filter((entry) => !entry.includes("*"))
    check("every entry point a dependency declares still ships", wanted.length > 20 && wanted.every((entry) => !dropped.includes(entry)), wanted.filter((entry) => dropped.includes(entry)))
  }

  // ------------------------------------------------------------------ P14-3
  section("Round 14 (P14-3): the bundled Python ships without its packages' test suites, as MiMo's does")
  {
    const script = await read("scripts/runtimes.mjs")
    const site = await fs.mkdtemp(path.join(os.tmpdir(), "mcode-r14-site-"))
    try {
      const put = async (rel: string, text = "") => {
        await fs.mkdir(path.dirname(path.join(site, rel)), { recursive: true })
        await fs.writeFile(path.join(site, rel), text)
      }
      await put("numpy/__init__.py", "from . import testing\n")
      await put("numpy/tests/test_a.py")
      await put("numpy/lib/tests/data/x.npy")
      await put("numpy/testing/__init__.py")
      await put("numpy/testing/tests/test_b.py")
      await put("pandas/_testing/__init__.py")
      await put("pandas/tests/test_c.py")
      await put("pkg/test/test_d.py")
      // Imported by the package's own code, absolutely or from beside it: kept.
      await put("pkg/helpers/tests/__init__.py")
      await put("pkg/uses.py", "from pkg.helpers.tests import fixture\n")
      await put("pkg/near/tests/__init__.py")
      await put("pkg/near/__init__.py", "from .tests import thing\n")
      // A top-level package of that name, and anything that is not a package folder: kept.
      await put("tests/__init__.py")
      await put("pkg-1.0.dist-info/tests/x")
      const found = (runtimesScript.testFolders(site) as string[]).map((folder) => path.relative(site, folder).replace(/\\/g, "/")).sort()
      check(
        "every tests/test folder inside a package goes, and nothing else",
        JSON.stringify(found) === JSON.stringify(["numpy/lib/tests", "numpy/testing/tests", "numpy/tests", "pandas/tests", "pkg/test"]),
        found,
      )
      check("numpy.testing and pandas._testing, which the libraries import, stay", !found.some((folder) => /(^|\/)_?testing$/.test(folder)))
      check("a tests folder the package's own code imports stays", !found.includes("pkg/helpers/tests") && !found.includes("pkg/near/tests"))
    } finally {
      await fs.rm(site, { recursive: true, force: true }).catch(() => undefined)
    }
    const build = body(script, "async function build(")
    const pruneAt = build.indexOf("testFolders(sitePackages)")
    const probeAt = build.indexOf("import openpyxl")
    check("the build removes them right after the install, and only then proves the libraries import", pruneAt > build.indexOf('pipInstall("packages"') && pruneAt < probeAt && /import openpyxl[^"`]*\bnumpy\.testing, pandas\.testing\b/.test(build))
    check("a tree built before this is rebuilt (the layout number moved on)", Number(/^const LAYOUT = (\d+)$/m.exec(script)?.[1]) >= 4)
  }

  section("Round 14 (P14-9): every module the built main process loads at run time ships with the app")
  {
    /*
     * The bundle keeps some requires external: the runtime dependencies, and a
     * bundled library's own lazy require (turndown's `@mixmark-io/domino`).
     * electron-builder copies only package.json's dependencies and what they
     * depend on, so an external that a dev dependency brought in resolved from
     * the repo's node_modules in every test and was missing from the installed
     * app, whose main module then never finished loading: no window at all.
     */
    const pkg = JSON.parse(await fs.readFile("package.json", "utf8")) as { dependencies?: Record<string, string> }
    const shipped = new Set<string>()
    const walk = async (name: string): Promise<void> => {
      if (shipped.has(name)) return
      shipped.add(name)
      const manifest = await fs.readFile(path.join("node_modules", name, "package.json"), "utf8").then((text) => JSON.parse(text) as { dependencies?: Record<string, string>; optionalDependencies?: Record<string, string> }, () => undefined)
      for (const dep of Object.keys({ ...manifest?.dependencies, ...manifest?.optionalDependencies })) await walk(dep)
    }
    for (const dep of Object.keys(pkg.dependencies ?? {})) await walk(dep)
    const packageOf = (spec: string) => (spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0]!)
    const builtins = new Set(createRequire(import.meta.url)("node:module").builtinModules as string[])
    const external = (code: string) => {
      const specs = new Set<string>()
      for (const match of code.matchAll(/\b(?:require\d*\(|from\s+|import\()\s*"([^".][^"]*)"/g)) specs.add(match[1]!)
      const named = /^(?:@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*(?:\/[\w./-]+)?$/i
      return [...specs].filter((spec) => named.test(spec) && !spec.startsWith("node:") && spec !== "electron" && !builtins.has(packageOf(spec)))
    }
    const main = await fs.readdir("out/main", { recursive: true }).then((names) => names.filter((name) => String(name).endsWith(".js")).map(String))
    const missing: string[] = []
    for (const file of main) for (const spec of external(await fs.readFile(path.join("out/main", file), "utf8"))) if (!shipped.has(packageOf(spec))) missing.push(`${file}: ${spec}`)
    check("the built main process requires nothing outside package.json's dependencies and theirs", main.length > 0 && missing.length === 0, missing)
    check("turndown's parser is one of them", shipped.has("@mixmark-io/domino"))
    check("the check sees the bundle's own lazy requires", external('var d = require2("@mixmark-io/domino"); import x from "ws"').join() === "@mixmark-io/domino,ws")
  }

}
