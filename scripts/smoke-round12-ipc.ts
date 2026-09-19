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
import { label, setLabels } from "../src/main/labels"

export async function roundTwelveIpcChecks(check: Check, section: (name: string) => void): Promise<void> {
  const read = (file: string) => fs.readFile(path.join(process.cwd(), file), "utf8")
  const mainSource = await read("src/main/index.ts")
  const preloadSource = await read("src/preload/index.ts")

  section("Round 12 (D12-1): the dead browserClose bridge is gone")
  {
    check("the preload no longer exposes browserClose", !/\bbrowserClose\b/.test(preloadSource))
    check("main no longer answers mcode:browser-close", !mainSource.includes('"mcode:browser-close"'))
  }

  section("Round 12 (D12-2): the window's label table is checked before main holds it")
  {
    // A throw is counted as a failure here rather than ending the run.
    const take = (raw: unknown): boolean | "threw" => {
      try {
        return setLabels(raw)
      } catch {
        return "threw"
      }
    }
    check("a plain object is taken", take({ "menu.file": "文件", "menu.edit": 5 }) === true)
    check("its string values are kept", label("menu.file", "File") === "文件")
    check("a value that is not a string is dropped, so the English fallback shows", label("menu.edit", "Edit") === "Edit")
    for (const bad of [null, undefined, "zh", 7, ["文件"]]) {
      check(`${JSON.stringify(bad) ?? "undefined"} is refused`, take(bad) === false)
    }
    check("after every refusal the previous table still answers", label("menu.file", "File") === "文件")
    let threw = false
    try {
      label("anything", "fallback")
    } catch {
      threw = true
    }
    check("label() does not throw after a bad message", !threw)
    check("the handler stops at a refused table rather than rebuilding the menu", /"mcode:menu-labels"[^]{0,120}if \(!setLabels\(next\)\) return/.test(mainSource))
    setLabels({})
  }
}
