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
}
