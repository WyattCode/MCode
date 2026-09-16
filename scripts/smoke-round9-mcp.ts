/**
 * Round 9: the MCP lifecycle, measured against MiMo's desktop and engine.
 *
 * Kept apart from smoke.ts the way the earlier rounds are; smoke.ts calls
 * `roundNineMcpChecks` with its own check and section. Servers are the real
 * fixtures under scripts/fixtures, spoken to over their pipes or over HTTP,
 * so what is checked is what a conversation would get.
 */
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { Check } from "./smoke-round5"
import { Bus } from "../src/server/bus"
import { Config } from "../src/server/config"
import { Storage } from "../src/server/storage"
import { parseJsonc, renderJsonc } from "../src/server/jsonc"
import { CodedError, paramsOf } from "../src/shared/errors"

type Section = (name: string) => void

async function temporary(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix))
}

/** M-4: config.json is JSONC, saved key by key, and never written over once a hand edit broke it. */
async function jsoncConfig(check: Check, section: Section): Promise<void> {
  section("Round 9: config.json takes comments and keeps them (M-4)")
  const dir = await temporary("mcode-r9-jsonc-")
  try {
    const read = parseJsonc('{\n  // a note\n  "a": 1,\n  "b": [1, 2,],\n}\n')
    check("comments and trailing commas parse", JSON.stringify(read.value) === '{"a":1,"b":[1,2]}' && !read.problem, read)
    const broken = parseJsonc('{\n  "a": 1\n  "b": 2\n}')
    check("a broken file says where, counted from 1", broken.problem?.line === 3 && broken.problem.column === 3, broken.problem)
    check("a blank file is no document", parseJsonc("  \n").value === undefined && !parseJsonc("").problem)
    const edited = renderJsonc("config.json", '{\n  // keep me\n  "a": 1, /* and me */\n  "b": { "c": true },\n}\n', { a: 2, b: { c: true }, d: "new" })
    check(
      "a save edits only what changed and keeps the comments",
      edited.includes("// keep me") && edited.includes("/* and me */") && /"a": 2/.test(edited) && /"d": "new"/.test(edited) && JSON.stringify(parseJsonc(edited).value) === '{"a":2,"b":{"c":true},"d":"new"}',
      edited,
    )
    const dropped = renderJsonc("config.json", '{\n  "a": 1,\n  // about b\n  "b": 2\n}\n', { a: 1 })
    check("a key that went is taken out", JSON.stringify(parseJsonc(dropped).value) === '{"a":1}', dropped)

    const storage = new Storage(path.join(dir, "storage"))
    const file = storage.fileOf("config")
    await fs.mkdir(path.dirname(file), { recursive: true })
    const handWritten = '{\n  // my servers\n  "theme": "dark",\n  "mcpServers": {\n    "one": { "type": "local", "command": ["node"], }, // trailing comma\n  },\n}\n'
    await fs.writeFile(file, handWritten)
    const config = new Config(storage, new Bus(), path.join(dir, "credentials.json"))
    await config.load()
    check("a config file with comments loads rather than being set aside", !config.unreadable && config.get().theme === "dark" && Boolean(config.get().mcpServers.one), config.unreadable)
    await config.set({ theme: "light" })
    const after = await fs.readFile(file, "utf8")
    check("a setting saved from the window keeps the file's comments", after.includes("// my servers") && after.includes("// trailing comma") && /"theme": "light"/.test(after), after)

    const bad = after.replace('"theme": "light",', '"theme": "light"')
    await fs.writeFile(file, bad)
    const refused = await config.set({ theme: "dark" }).then(
      () => undefined,
      (error: unknown) => error,
    )
    const params = paramsOf(refused)
    check(
      "a save over a file a hand edit broke is refused, naming the line and column",
      refused instanceof CodedError && refused.code === "error.configUnparseable" && params?.file === "config.json" && typeof params.line === "number" && typeof params.column === "number",
      { refused: String(refused), params },
    )
    check("and the broken file is left exactly as it was", (await fs.readFile(file, "utf8")) === bad)
    check("and the setting in memory is not ahead of the file", config.get().theme === "light", config.get().theme)
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

export async function roundNineMcpChecks(check: Check, section: Section): Promise<void> {
  // A part that throws is a failed check, not a crash that hides every part after it.
  const parts: [string, (check: Check, section: Section) => Promise<void>][] = [["M-4", jsoncConfig]]
  for (const [name, part] of parts) {
    await part(check, section).catch((error: unknown) => check(`round 9 ${name} ran to its end`, false, String(error)))
  }
}
