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
import { NsisUpdater } from "electron-updater"
import { createUpdater, type AutoUpdaterLike } from "../src/main/updater"

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
}
