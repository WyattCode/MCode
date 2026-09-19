/**
 * Round 12, lane D: the main process's IPC contract and its small-file writes
 * (D12-1 onwards). Kept apart from smoke.ts the way the earlier rounds are;
 * smoke.ts calls `roundTwelveIpcChecks` with its own check and section.
 *
 * The handlers themselves need Electron, so what they decide is kept in plain
 * functions and held here; where the check is that a handler uses one of them
 * at all, the source is read.
 */
import fs from "node:fs/promises"
import path from "node:path"
import type { Check } from "./smoke-round5"

export async function roundTwelveIpcChecks(check: Check, section: (name: string) => void): Promise<void> {
  const read = (file: string) => fs.readFile(path.join(process.cwd(), file), "utf8")
  const mainSource = await read("src/main/index.ts")
  const preloadSource = await read("src/preload/index.ts")

  section("Round 12 (D12-1): the dead browserClose bridge is gone")
  {
    check("the preload no longer exposes browserClose", !/\bbrowserClose\b/.test(preloadSource))
    check("main no longer answers mcode:browser-close", !mainSource.includes('"mcode:browser-close"'))
  }
}
