/**
 * Round 12, lane A: the credential file and the settings documents across
 * damage, upgrades and quit (L12-1 onwards). Kept apart from smoke.ts the way
 * the earlier rounds are; smoke.ts calls `roundTwelveCredentialChecks` with its
 * own check and section.
 *
 * Every profile here is a temporary folder of its own. No key value is ever
 * printed: a check that fails reports shapes and lengths, not secrets.
 */
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { Check } from "./smoke-round5"
import { startBackend } from "../src/server/index"
import { Bus } from "../src/server/bus"
import { CREDENTIALS_SEALED_MIGRATION, Config } from "../src/server/config"
import type { SecretBox } from "../src/server/credential-file"
import { Storage } from "../src/server/storage"
import { handle } from "../src/server/handlers"
import { appDataRefusal } from "../src/server/tool/app-data"
import { codeOf } from "../src/shared/errors"
import type { Request } from "../src/shared/protocol"

const scratch: string[] = []

async function profile(name: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `mcode-r12a-${name}-`))
  scratch.push(dir)
  await fs.mkdir(path.join(dir, "storage"), { recursive: true })
  return dir
}

async function listed(dir: string): Promise<string[]> {
  return fs.readdir(dir).catch(() => [])
}

export async function roundTwelveCredentialChecks(check: Check, section: (name: string) => void): Promise<void> {
  try {
    await checks(check, section)
  } finally {
    for (const dir of scratch.splice(0)) await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined)
  }
}

async function checks(check: Check, section: (name: string) => void): Promise<void> {
  section("Round 12 (L12-1): a damaged models.json does not stop the backend")
  {
    const dir = await profile("models")
    await fs.writeFile(path.join(dir, "storage", "models.json"), '{"openai": [{"id": "gpt-5", "na')
    const backend = await startBackend(dir).catch((error: unknown) => error)
    const started = !(backend instanceof Error) && typeof (backend as { port?: unknown }).port === "number"
    check("the backend starts over a truncated models.json", started, backend instanceof Error ? backend.message : undefined)
    const kept = await listed(path.join(dir, "storage"))
    check("the damaged file is kept aside, not written over", kept.some((name) => name.startsWith("models.json.corrupt-")) && !kept.includes("models.json"), kept)
    if (started) {
      const { runtime } = backend as Awaited<ReturnType<typeof startBackend>>
      await runtime.config.setDiscovered("openai", [{ id: "gpt-5", name: "GPT-5" }])
      const again = JSON.parse(await fs.readFile(path.join(dir, "storage", "models.json"), "utf8")) as Record<string, unknown>
      check("and discovery writes a fresh list afterwards", Array.isArray(again.openai), Object.keys(again))
      await (backend as Awaited<ReturnType<typeof startBackend>>).close()
    }
  }

  section("Round 12 (L12-4): a newer build's config.json without our migrations does not stop the backend")
  {
    const dir = await profile("newer")
    const file = path.join(dir, "storage", "config.json")
    const text = JSON.stringify({ schemaVersion: 99, theme: "dark", futureField: { kept: true } }, null, 2)
    await fs.writeFile(file, text)
    const backend = await startBackend(dir).catch((error: unknown) => error)
    const started = !(backend instanceof Error) && typeof (backend as { port?: unknown }).port === "number"
    check("the backend starts over schemaVersion 99 with no migrations recorded", started, backend instanceof Error ? backend.message : undefined)
    if (started) {
      const { runtime } = backend as Awaited<ReturnType<typeof startBackend>>
      check("the document is read as far as it goes", runtime.config.fromNewerVersion && runtime.config.get().theme === "dark")
      await (backend as Awaited<ReturnType<typeof startBackend>>).close()
    }
    check("and it is left exactly as it was", (await fs.readFile(file, "utf8")) === text)
  }

  section("Round 12 (L12-5): a value this build does not know is replaced in memory, never on disk")
  {
    const dir = await profile("sanitize")
    const storage = new Storage(path.join(dir, "storage"))
    const credentials = path.join(dir, "credentials.json")
    // A first load writes the document with every load-time migration recorded.
    await new Config(storage, new Bus(), credentials).load()
    const file = storage.fileOf("config")
    const text = (await fs.readFile(file, "utf8")).replace('"theme": "system"', '"theme": "neon-future"')
    check("the seeded document names a theme from a later build", text.includes('"theme": "neon-future"'))
    await fs.writeFile(file, text)
    const config = new Config(storage, new Bus(), credentials)
    await config.load()
    check("the app runs on the default theme", config.get().theme === "system", config.get().theme)
    check("and the file is byte for byte what it was", (await fs.readFile(file, "utf8")) === text)

    await config.set({ uiFontSize: 16 })
    const afterOther = await fs.readFile(file, "utf8")
    check("a save of another setting keeps the stored theme", afterOther.includes('"theme": "neon-future"') && afterOther.includes('"uiFontSize": 16'))
    await config.set({ theme: "system" })
    check("choosing a theme writes the choice, even the default", (await fs.readFile(file, "utf8")).includes('"theme": "system"'))

    // A migration that has to write still leaves an unknown value alone.
    const unmigrated = JSON.parse(text) as Record<string, unknown>
    delete unmigrated.migrations
    await fs.writeFile(file, JSON.stringify(unmigrated, null, 2))
    const migrated = new Config(storage, new Bus(), credentials)
    await migrated.load()
    const written = JSON.parse(await fs.readFile(file, "utf8")) as Record<string, unknown>
    check("a load that migrates writes the migrations but not the checked theme", Array.isArray(written.migrations) && written.theme === "neon-future" && migrated.get().theme === "system", written.theme)
  }

  section("Round 12 (L12-6): quit waits for the writes still queued")
  {
    const dir = await profile("drain")
    const storage = new Storage(path.join(dir, "storage"))
    for (let i = 0; i < 5; i++) void storage.write(`queued/${i}`, { i })
    await storage.drain()
    const written = await listed(path.join(dir, "storage", "queued"))
    check("drain settles every queued write", written.length === 5, written)

    const backend = await startBackend(dir)
    const { runtime } = backend
    /*
     * Each save is held back well past what close() takes on its own, so only
     * a close that waits for them finds them on disk.
     */
    const slow = runtime.storage as unknown as {
      writeNow: (key: string, value: unknown, durable: boolean) => Promise<void>
      writeText: (key: string, render: (current: string | undefined) => string) => Promise<void>
    }
    const writeNow = slow.writeNow.bind(slow)
    slow.writeNow = async (key, value, durable) => {
      await new Promise((resolve) => setTimeout(resolve, 1500))
      return writeNow(key, value, durable)
    }
    const writeText = slow.writeText.bind(slow)
    slow.writeText = async (key, render) => {
      await new Promise((resolve) => setTimeout(resolve, 1500))
      return writeText(key, render)
    }
    void runtime.storage.write("late", { saved: true })
    void runtime.config.set({ uiFontSize: 17 }).catch(() => undefined)
    const started = Date.now()
    await backend.close()
    const late = await fs.readFile(path.join(dir, "storage", "late.json"), "utf8").catch(() => "")
    check("a document queued just before quit is on disk when close() returns", late.includes('"saved": true'), { late: late.length, ms: Date.now() - started })
    const settings = await fs.readFile(path.join(dir, "storage", "config.json"), "utf8").catch(() => "")
    check("and so is a setting changed just before quit", settings.includes('"uiFontSize": 17'))
    check("inside the five-second bound on close", Date.now() - started < 5000, Date.now() - started)
  }

  section("Round 12 (L12-2): an unreadable credentials.json is kept, never written over")
  {
    const dir = await profile("credentials")
    const file = path.join(dir, "credentials.json")
    // Test values only; nothing here is a real key.
    const damaged = '{"keys": {"openai": "test-openai-value", "anthropic": "test-anthropic-val'
    await fs.writeFile(file, damaged)
    const backend = await startBackend(dir).catch((error: unknown) => error)
    const started = !(backend instanceof Error)
    check("the backend starts over a truncated credentials.json", started, backend instanceof Error ? backend.message : undefined)
    if (started) {
      const { runtime } = backend as Awaited<ReturnType<typeof startBackend>>
      const kept = (await listed(dir)).filter((name) => name.startsWith("credentials.json.corrupt-"))
      check("the damaged file is moved aside under its own name", kept.length === 1 && !(await listed(dir)).includes("credentials.json"), await listed(dir))
      check("with its bytes intact", kept.length === 1 && (await fs.readFile(path.join(dir, kept[0]!), "utf8")) === damaged)
      const got = (await handle(runtime, { type: "config.get" } as Request)) as { credentialsUnreadable?: { problem: string; evidence?: string } }
      check("config.get tells the window, with where the file went", Boolean(got.credentialsUnreadable) && got.credentialsUnreadable?.evidence === path.join(dir, kept[0] ?? "-"), got.credentialsUnreadable?.evidence)
      check("and its reason never quotes the file", !JSON.stringify(got.credentialsUnreadable).includes("test-"))
      check("the model's tools may not read the kept copy", (await appDataRefusal(path.join(dir, kept[0] ?? "x"), "read")) === "secret")
      check("no key was loaded from it", runtime.config.apiKey("openai") === undefined || runtime.config.environmentKey("openai") !== undefined)
      await runtime.config.setApiKey("openai", "test-new-value")
      const fresh = JSON.parse(await fs.readFile(file, "utf8")) as { keys?: Record<string, string> }
      check("a key saved afterwards starts a fresh file beside the kept one", Object.keys(fresh.keys ?? {}).join() === "openai" && (await fs.readFile(path.join(dir, kept[0]!), "utf8")) === damaged)

      // A file that could not be moved aside: saving credentials is refused, the file untouched.
      const blocked = runtime.config as unknown as { credentialsBlocked: boolean }
      blocked.credentialsBlocked = true
      const before = await fs.readFile(file, "utf8")
      const refusal = await runtime.config.setApiKey("anthropic", "test-other-value").then(() => undefined, (error: unknown) => error)
      check("while the file cannot be moved, a key save is refused with its own code", codeOf(refusal) === "error.credentialsInvalid", codeOf(refusal))
      const tokens = await runtime.config.setTokens("openai", { access: "test-token" }).then(() => undefined, (error: unknown) => error)
      check("and so is a sign-in", codeOf(tokens) === "error.credentialsInvalid")
      check("and the file is left as it was", (await fs.readFile(file, "utf8")) === before && runtime.config.tokens("openai") === undefined)
      await (backend as Awaited<ReturnType<typeof startBackend>>).close()
    }

    const legacy = await profile("legacy")
    await fs.writeFile(path.join(legacy, "credentials.json"), JSON.stringify({ openai: "test-legacy-value" }))
    const old = new Config(new Storage(path.join(legacy, "storage")), new Bus(), path.join(legacy, "credentials.json"))
    await old.load()
    check("the old bare key map still reads", old.apiKey("openai") === "test-legacy-value" && !old.credentialsUnreadable)
    const none = await profile("none")
    const fresh = new Config(new Storage(path.join(none, "storage")), new Bus(), path.join(none, "credentials.json"))
    await fresh.load()
    check("no file at all is a first run, not a damaged one", !fresh.credentialsUnreadable)
  }

  section("Round 12 (L12-3): keys and sign-ins are encrypted with the system's secure storage")
  {
    // Everything the backend logs in this section, so a key that reached a log line fails a check.
    const logged: string[] = []
    const originals = { info: console.info, warn: console.warn, error: console.error }
    for (const level of ["info", "warn", "error"] as const) {
      console[level] = (...args: unknown[]) => {
        logged.push(args.map(String).join(" "))
      }
    }
    try {
      await sealingChecks(check, logged)
    } finally {
      Object.assign(console, originals)
    }
    check("no key or token value appears in anything logged", !logged.some((line) => SECRETS.some((secret) => line.includes(secret))), logged.length)
  }
}

// Test values only; nothing here is a real key.
const KEY = "test-openai-value-0001"
const OTHER = "test-anthropic-value-0002"
const TOKEN = "test-access-token-0003"
const SECRETS = [KEY, OTHER, TOKEN]
const PLAIN = JSON.stringify({ keys: { openai: KEY, anthropic: OTHER }, oauth: { openai: { access: TOKEN, refresh: "test-refresh-0004" } } }, null, 2)

/**
 * A stand-in for safeStorage: reversible, bound to one "machine", and
 * unable to open what another one sealed - which is what DPAPI does for a
 * profile copied to another Windows user or computer.
 */
function testBox(machine: string, options: { available?: boolean; openable?: boolean } = {}): SecretBox & { sealed: number; options: { available?: boolean; openable?: boolean } } {
  const box = {
    sealed: 0,
    options,
    available: () => options.available ?? true,
    seal(plain: string) {
      box.sealed++
      return Buffer.from(`${machine}:${Buffer.from(plain, "utf8").toString("hex")}`, "utf8").toString("base64")
    },
    open(sealed: string) {
      const text = Buffer.from(sealed, "base64").toString("utf8")
      if (options.openable === false || !text.startsWith(`${machine}:`)) throw new Error("sealed elsewhere")
      return Buffer.from(text.slice(machine.length + 1), "hex").toString("utf8")
    },
  }
  return box
}

async function migrations(dir: string): Promise<string[]> {
  const doc = JSON.parse(await fs.readFile(path.join(dir, "storage", "config.json"), "utf8").catch(() => "{}")) as { migrations?: string[] }
  return doc.migrations ?? []
}

async function sealingChecks(check: Check, logged: string[]): Promise<void> {
  // An existing plain-text file is sealed at the first launch that can.
  const dir = await profile("seal")
  const file = path.join(dir, "credentials.json")
  await fs.writeFile(file, PLAIN)
  const machine = testBox("machine-a")
  let backend = await startBackend(dir, { secrets: machine })
  let text = await fs.readFile(file, "utf8")
  check("the plain file is replaced by a sealed one", (JSON.parse(text) as { sealed?: string }).sealed === "safeStorage")
  check("which holds none of the values in the clear", !SECRETS.some((secret) => text.includes(secret)))
  check("every value is sealed on its own", machine.sealed === 3, machine.sealed)
  check("the migration is recorded by name", (await migrations(dir)).includes(CREDENTIALS_SEALED_MIGRATION))
  check("and the keys and sign-in still work", backend.runtime.config.apiKey("openai") === KEY && backend.runtime.config.tokens("openai")?.access === TOKEN)
  check("no temp file is left beside it", !(await listed(dir)).some((name) => name.startsWith("credentials.json.")), await listed(dir))
  await backend.runtime.config.setApiKey("mistral", "test-mistral-0005")
  text = await fs.readFile(file, "utf8")
  check("a key saved later is sealed too", !text.includes("test-mistral-0005") && (JSON.parse(text) as { keys: Record<string, string> }).keys.mistral !== undefined)
  await backend.close()

  backend = await startBackend(dir, { secrets: testBox("machine-a") })
  check("the next launch on the same machine opens them", backend.runtime.config.apiKey("anthropic") === OTHER && backend.runtime.config.apiKey("mistral") === "test-mistral-0005" && !backend.runtime.config.credentialsUnreadable)
  await backend.close()

  // Another user or machine: unreadable, kept aside - never empty and written over.
  const sealedText = await fs.readFile(file, "utf8")
  backend = await startBackend(dir, { secrets: testBox("machine-b") })
  const aside = (await listed(dir)).filter((name) => name.startsWith("credentials.json.corrupt-"))
  check("a file sealed elsewhere is unreadable, not empty", Boolean(backend.runtime.config.credentialsUnreadable) && backend.runtime.config.apiKey("anthropic") === undefined)
  check("and is kept aside byte for byte", aside.length === 1 && (await fs.readFile(path.join(dir, aside[0]!), "utf8")) === sealedText)
  await backend.close()

  // Plain node with no box at all reads a sealed file as unreadable too —
  // but must leave the file in place (Linux keyring locked / no box yet).
  const bare = await profile("bare")
  const bareFile = path.join(bare, "credentials.json")
  await fs.writeFile(bareFile, sealedText)
  const noBox = new Config(new Storage(path.join(bare, "storage")), new Bus(), path.join(bare, "credentials.json"))
  await noBox.load()
  check("without secure storage a sealed file is unreadable as well", Boolean(noBox.credentialsUnreadable))
  check("and the sealed file is left in place for a later unlock", (await fs.readFile(bareFile, "utf8")) === sealedText)
  check("with no corrupt aside created", !(await listed(bare)).some((name) => name.startsWith("credentials.json.corrupt-")))

  // Locked keyring (box present, available false): same keep behaviour, then recheck opens it.
  const locked = await profile("keyring-locked")
  const lockedFile = path.join(locked, "credentials.json")
  await fs.writeFile(lockedFile, sealedText)
  const lockedBox = testBox("machine-a", { available: false })
  const lockedBackend = await startBackend(locked, { secrets: lockedBox })
  check("a locked keyring leaves the sealed file where it is", (await fs.readFile(lockedFile, "utf8")) === sealedText)
  check("and reports credentials unreadable", Boolean(lockedBackend.runtime.config.credentialsUnreadable))
  check("with no corrupt aside for a temporary lock", !(await listed(locked)).some((name) => name.startsWith("credentials.json.corrupt-")))
  lockedBox.options.available = true
  const rechecked = await lockedBackend.runtime.config.recheckCredentials()
  check("recheck after unlock clears the unreadable flag", !rechecked.credentialsUnreadable && !lockedBackend.runtime.config.credentialsUnreadable)
  check("and restores the sealed keys", lockedBackend.runtime.config.apiKey("anthropic") === OTHER)
  await lockedBackend.close()

  // A sealing that does not read back leaves the plain file and retries next launch.
  const failing = await profile("failing")
  const failingFile = path.join(failing, "credentials.json")
  await fs.writeFile(failingFile, PLAIN)
  backend = await startBackend(failing, { secrets: testBox("machine-a", { openable: false }) })
  check("a sealed copy that does not open again never replaces the plain file", (await fs.readFile(failingFile, "utf8")) === PLAIN)
  check("the keys still work meanwhile", backend.runtime.config.apiKey("openai") === KEY)
  check("the migration is not recorded, so it is tried again", !(await migrations(failing)).includes(CREDENTIALS_SEALED_MIGRATION))
  check("and no half-written copy is left", !(await listed(failing)).some((name) => name.startsWith("credentials.json.")), await listed(failing))
  check("the failure is logged without the values", logged.some((line) => line.includes("were not encrypted this time")))
  await backend.close()
  backend = await startBackend(failing, { secrets: testBox("machine-a") })
  check("the next launch that can seal does", (JSON.parse(await fs.readFile(failingFile, "utf8")) as { sealed?: string }).sealed === "safeStorage" && backend.runtime.config.apiKey("openai") === KEY)
  await backend.close()

  // No secure storage (Linux without a keyring): plain text, said in the window.
  const linux = await profile("nokeyring")
  const linuxFile = path.join(linux, "credentials.json")
  await fs.writeFile(linuxFile, PLAIN)
  backend = await startBackend(linux, { secrets: testBox("machine-a", { available: false }) })
  const got = (await handle(backend.runtime, { type: "config.get" } as Request)) as { credentialsPlaintext?: boolean }
  check("without secure storage the keys stay in plain text and work", (await fs.readFile(linuxFile, "utf8")) === PLAIN && backend.runtime.config.apiKey("openai") === KEY)
  check("config.get says they are unencrypted", got.credentialsPlaintext === true)
  check("and the migration waits for a launch that can seal", !(await migrations(linux)).includes(CREDENTIALS_SEALED_MIGRATION))
  await backend.close()

  // The checks' own backend (no box) keeps plain text and raises no notice.
  const plainNode = await profile("plainnode")
  await fs.writeFile(path.join(plainNode, "credentials.json"), PLAIN)
  backend = await startBackend(plainNode)
  const quiet = (await handle(backend.runtime, { type: "config.get" } as Request)) as { credentialsPlaintext?: boolean }
  check("a backend given no secure storage reads plain text without a notice", backend.runtime.config.apiKey("openai") === KEY && !quiet.credentialsPlaintext)
  await backend.close()
}
