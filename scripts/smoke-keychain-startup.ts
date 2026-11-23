import "./fenced-home"
import "./safe-listen"
import fs from "node:fs/promises"
import net from "node:net"
import path from "node:path"
import { Bus } from "../src/server/bus"
import { Config } from "../src/server/config"
import { parseCredentials, readCredentialFile, renderCredentials, type SecretBox } from "../src/server/credential-file"
import { startBackend } from "../src/server/index"
import { Storage } from "../src/server/storage"

type Check = (label: string, ok: boolean, detail?: unknown) => void
const keys = { openai: "original-openai", anthropic: "original-anthropic" }
const oauth = { openai: { access: "original-access", refresh: "original-refresh" } }
const lockedProblem = "credentials.json is encrypted and this system's secure storage cannot open it"
const decryptProblem = "credentials.json could not be decrypted here (written by another user or machine?)"

function testBox() {
  let calls = 0
  let available = true
  let fail = false
  const latch = new Int32Array(new SharedArrayBuffer(4))
  const box: SecretBox = {
    available: () => available,
    seal: (value) => Buffer.from(value).toString("base64"),
    open(value) {
      calls++
      // A synchronous open cannot yield to a Promise. Bound an accidental
      // entry into the closed latch so regressions still report assertions.
      if (Atomics.wait(latch, 0, 0, 1200) === "timed-out" || fail) throw new Error("private failure detail")
      return Buffer.from(value, "base64").toString()
    },
  }
  return {
    box,
    calls: () => calls,
    release: () => Atomics.store(latch, 0, 1),
    lockKeyring: () => { available = false },
    unlockKeyring: () => { available = true },
    rejectOpen: () => { fail = true },
  }
}

function listening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect(port, "127.0.0.1")
    const done = (ok: boolean) => {
      socket.destroy()
      resolve(ok)
    }
    socket.setTimeout(1000, () => done(false))
    socket.once("connect", () => done(true))
    socket.once("error", () => done(false))
  })
}

export async function keychainStartupChecks(check: Check): Promise<void> {
  const root = path.resolve("tmp-local")
  await fs.mkdir(root, { recursive: true })
  const fixture = await fs.mkdtemp(path.join(root, "keychain-startup-"))
  const codec = testBox()
  codec.release()
  const sealed = renderCredentials({ keys, oauth }, codec.box)
  const inline = parseCredentials(sealed, codec.box)
  async function profile(name: string, box: SecretBox) {
    const dir = path.join(fixture, name)
    await fs.mkdir(dir)
    const file = path.join(dir, "credentials.json")
    await fs.writeFile(file, sealed)
    const config = new Config(new Storage(path.join(dir, "storage")), new Bus(), file, box)
    // The desktop host defers the first keychain access; these checks are about that host.
    config.deferCredentialUnseal = true
    return { dir, file, config }
  }
  const finish = (config: Config) => config.finishCredentialUnseal?.() ?? Promise.resolve()
  try {
    const unopened = testBox()
    const delayed = await profile("delayed", unopened.box)
    const read = await readCredentialFile(delayed.file, unopened.box, { deferUnseal: true })
    check("deferred read exposes two key entries and one login without opening", unopened.calls() === 0 && read.state === "sealed" &&
      Object.keys(read.raw.keys ?? {}).length === 2 && Object.keys(read.raw.oauth ?? {}).length === 1)

    const held = testBox()
    const saving = await profile("saving", held.box)
    await saving.config.load()
    check("config loads and answers while open is latched", held.calls() === 0 && Object.keys(saving.config.get()).length > 0 &&
      !saving.config.credentialsUnreadable && saving.config.tokens("openai") === undefined)

    const save = saving.config.setApiKey("mistral", "new-key").then(() => true, () => false)
    const beforeUnlock = await Promise.race([save, new Promise<"waiting">((resolve) => setTimeout(resolve, 100, "waiting"))])
    check("provider save waits with file bytes unchanged", beforeUnlock === "waiting" && held.calls() === 0 &&
      await fs.readFile(saving.file, "utf8").catch(() => "") === sealed)
    held.release()
    await Promise.all([finish(saving.config), finish(saving.config)])
    const saveOK = await save
    const final = parseCredentials(await fs.readFile(saving.file, "utf8").catch(() => ""), codec.box)
    check("provider save preserves every existing key and login", saveOK && final.state === "read" &&
      JSON.stringify(final.credentials) === JSON.stringify({ keys: { ...keys, mistral: "new-key" }, oauth }))
    check("unseal is idempotent and matches inline keys and login byte for byte", inline.state === "read" && held.calls() === 3 &&
      JSON.stringify([saving.config.apiKey("openai"), saving.config.apiKey("anthropic"), saving.config.tokens("openai")]) ===
      JSON.stringify([inline.credentials.keys.openai, inline.credentials.keys.anthropic, inline.credentials.oauth.openai]))

    const linux = testBox()
    linux.lockKeyring()
    const locked = await profile("locked", linux.box)
    await locked.config.load()
    await finish(locked.config)
    const blocked = await locked.config.setApiKey("mistral", "blocked-key").then(() => false, () => true)
    check("locked keyring keeps original file and blocks writes", blocked && linux.calls() === 0 &&
      JSON.stringify(locked.config.credentialsUnreadable) === JSON.stringify({ problem: lockedProblem }) &&
      await fs.readFile(locked.file, "utf8").catch(() => "") === sealed &&
      !(await fs.readdir(locked.dir)).some((name) => name.startsWith("credentials.json.corrupt-")))
    linux.unlockKeyring()
    linux.release()
    const retried = await locked.config.recheckCredentials()
    check("keyring recheck opens again and restores credentials", linux.calls() === 3 && !retried.credentialsUnreadable &&
      locked.config.apiKey("anthropic") === keys.anthropic && JSON.stringify(locked.config.tokens("openai")) === JSON.stringify(oauth.openai))

    const failing = testBox()
    failing.release()
    failing.rejectOpen()
    const broken = await profile("broken", failing.box)
    await broken.config.load()
    await finish(broken.config)
    const evidence = broken.config.credentialsUnreadable?.evidence
    check("throwing open quarantines with the existing redacted error", failing.calls() === 1 &&
      broken.config.credentialsUnreadable?.problem === decryptProblem && Boolean(evidence) &&
      await fs.readFile(evidence ?? "", "utf8").catch(() => "") === sealed &&
      await fs.stat(broken.file).then(() => false, (error: NodeJS.ErrnoException) => error.code === "ENOENT"))

    const stalled = testBox()
    const boot = await profile("backend", stalled.box)
    // The sandbox can reject native file watchers asynchronously (EMFILE).
    // This check exercises the real backend lifecycle and TCP listener.
    const watch = Config.prototype.watch
    const probe = net.createServer()
    const tcp = await new Promise<boolean>((resolve, reject) => {
      probe.once("error", (error: NodeJS.ErrnoException) => {
        if (error.code === "EPERM" || error.code === "EACCES") resolve(false)
        else reject(error)
      })
      probe.listen(0, "127.0.0.1", () => probe.close(() => resolve(true)))
    })
    const listenForWindow = net.Server.prototype.listen
    let listeningServer: net.Server | undefined
    if (!tcp) {
      Config.prototype.watch = () => {}
      console.warn("[keychain smoke] loopback denied; substituting the TCP bind")
      const address = net.Server.prototype.address
      net.Server.prototype.listen = function (this: net.Server, ...args: unknown[]) {
        if (args[0] !== 0 || args[1] !== "127.0.0.1") {
          return listenForWindow.apply(this, args as Parameters<typeof listenForWindow>)
        }
        listeningServer = this
        this.address = () => ({ address: "127.0.0.1", family: "IPv4", port: 49152 })
        this.close = (callback?: (error?: Error) => void) => {
          this.address = address
          queueMicrotask(() => { callback?.() })
          return this
        }
        queueMicrotask(() => this.emit("listening"))
        return this
      } as typeof listenForWindow
    }
    const starting = startBackend(boot.dir, { secrets: stalled.box, deferCredentialUnseal: true })
    let timeout: ReturnType<typeof setTimeout> | undefined
    const deadline = performance.now() + 1100
    try {
      const backend = await Promise.race([starting, new Promise<undefined>((resolve) => { timeout = setTimeout(resolve, 1100) })])
      check("backend resolves and listens before a latched open", backend !== undefined && performance.now() < deadline &&
        stalled.calls() === 0 && (tcp ? await listening(backend.port) : listeningServer?.address() !== null &&
          listeningServer?.address() !== undefined && backend.port === 49152))
    } finally {
      clearTimeout(timeout)
      stalled.release()
      try {
        await (await starting).close()
      } finally {
        net.Server.prototype.listen = listenForWindow
        Config.prototype.watch = watch
      }
    }

    const server = await fs.readFile("src/server/index.ts", "utf8")
    const load = server.indexOf("await config.load()")
    const listen = server.indexOf("await listenForWindow", load)
    /*
     * The hazard is a keychain wait sitting directly in the startBackend body
     * before the socket opens — that is what put the authorization prompt in front
     * of the window. Text position alone is not the invariant: the same call
     * inside a `void (async () => ...)` boot task cannot hold up the socket, and a
     * wait the deferring host skips (`if (!options.deferCredentialUnseal) await
     * ...`) is the eager host's long-standing behaviour, which the credential
     * battery relies on. So: two-space indent (startBackend's own body), unguarded.
     */
    const blockingWait = /^ {2}await (?:config\.(?:migrateCredentials|finishCredentialUnseal|credentialsReady)|credentials\.unlock)\(/m
    check("backend source never awaits unlock before listen", load >= 0 && listen > load && !blockingWait.test(server.slice(load, listen)))
  } finally {
    await fs.rm(fixture, { recursive: true, force: true })
  }
}

if (process.argv[1]?.split("/").pop() === "smoke-keychain-startup.ts") {
  let failed = 0
  await keychainStartupChecks((label, ok, detail) => {
    if (!ok) failed++
    console.log(ok ? "PASS" : "FAIL", label, detail ?? "")
  })
  process.exitCode = failed ? 1 : 0
}
