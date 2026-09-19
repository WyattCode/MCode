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
import { Config } from "../src/server/config"
import { Storage } from "../src/server/storage"

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
}
