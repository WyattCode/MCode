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
import { BROWSER_ACTS, EDIT_ACTIONS, VIEW_ACTIONS, WINDOW_ACTIONS, actionOf, clipboardText, panelBounds, titlebarMode } from "../src/main/ipc-input"

export async function roundTwelveIpcChecks(check: Check, section: (name: string) => void): Promise<void> {
  const read = (file: string) => fs.readFile(path.join(process.cwd(), file), "utf8")
  const mainSource = await read("src/main/index.ts")
  const preloadSource = await read("src/preload/index.ts")
  /** The body of one `ipcMain.on/handle("<channel>", ...)` registration, up to the next one. */
  const handlerOf = (channel: string) => {
    const start = mainSource.indexOf(`"${channel}"`)
    if (start < 0) return ""
    const next = mainSource.slice(start + channel.length + 2).search(/ipcMain\.(on|handle)\(/)
    return next < 0 ? mainSource.slice(start) : mainSource.slice(start, start + channel.length + 2 + next)
  }

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

  section("Round 12 (D12-3): fire-and-forget channels read their value before using it")
  {
    check("clipboard text passes as it is", clipboardText("héllo") === "héllo" && clipboardText("") === "")
    for (const bad of [undefined, null, 5, { toString: () => "x" }, ["a"]]) {
      check(`clipboard ${JSON.stringify(bad) ?? "undefined"} is dropped`, clipboardText(bad) === undefined)
    }
    const box = { x: 10.5, y: 0, width: 300, height: -1 }
    check("four finite sides pass", JSON.stringify(panelBounds(box)) === JSON.stringify(box))
    check("extra fields on the box are not carried", JSON.stringify(panelBounds({ ...box, extra: 1 })) === JSON.stringify(box))
    const badBoxes: unknown[] = [
      null,
      undefined,
      "box",
      42,
      { x: 1, y: 2, width: 3 },
      { x: Number.NaN, y: 0, width: 1, height: 1 },
      { x: 0, y: Number.POSITIVE_INFINITY, width: 1, height: 1 },
      { x: "1", y: 0, width: 1, height: 1 },
    ]
    for (const bad of badBoxes) check(`a panel box ${String(JSON.stringify(bad))} is dropped`, panelBounds(bad) === undefined)
    check("dark and light are the caption modes", titlebarMode("dark") === "dark" && titlebarMode("light") === "light")
    for (const bad of ["Dark", "system", "", null, 1]) check(`caption mode ${JSON.stringify(bad)} is dropped`, titlebarMode(bad) === undefined)

    check("mcode:clipboard-write writes only what clipboardText passes", /clipboardText\(raw\)[^]*if \(text !== undefined\) clipboard\.writeText\(text\)/.test(handlerOf("mcode:clipboard-write")))
    check("mcode:browser-bounds sets only a box panelBounds passes", /panelBounds\(raw\)[^]*if \(window && bounds\) setBounds/.test(handlerOf("mcode:browser-bounds")))
    check("mcode:browser-open opens only with a box panelBounds passes", /panelBounds\(raw\)[^]*if \(!window \|\| !bounds\) return/.test(handlerOf("mcode:browser-open")))
    check("mcode:titlebar-mode sets only a mode titlebarMode passes", /titlebarMode\(raw\)[^]*if \(mode\) setTitlebarMode/.test(handlerOf("mcode:titlebar-mode")))
  }

  section("Round 12 (D12-4): action channels do the named action or nothing")
  {
    const channels = [
      { channel: "mcode:edit", set: EDIT_ACTIONS, name: "EDIT_ACTIONS", bridge: "edit: (action" },
      { channel: "mcode:view", set: VIEW_ACTIONS, name: "VIEW_ACTIONS", bridge: "view: (action" },
      { channel: "mcode:window", set: WINDOW_ACTIONS, name: "WINDOW_ACTIONS", bridge: "window: (action" },
      { channel: "mcode:browser-act", set: BROWSER_ACTS, name: "BROWSER_ACTS", bridge: "browserAct: (what" },
    ] as const
    for (const { channel, set, name, bridge } of channels) {
      check(`${channel}: every known action passes`, set.every((action) => actionOf(set, action) === action))
      for (const bad of ["", "selectall", "maximise", "toggle", "__proto__", "toString", 1, null, undefined, ["reload"]]) {
        check(`${channel}: ${JSON.stringify(bad) ?? "undefined"} is no action`, actionOf(set, bad) === undefined)
      }
      // The preload's declared union and main's set are the same list.
      const at = preloadSource.indexOf(bridge)
      const union = at < 0 ? [] : [...preloadSource.slice(at, preloadSource.indexOf(")", at)).matchAll(/"([A-Za-z]+)"/g)].map((match) => match[1])
      check(`${channel}: main accepts exactly what the preload declares`, JSON.stringify([...union].sort()) === JSON.stringify([...set].sort()), union)
      const body = handlerOf(channel)
      check(`${channel}: the handler dispatches on actionOf(${name}, ...)`, body.includes(`actionOf(${name}, raw)`))
      check(`${channel}: no else-branch or default runs for an unknown action`, !/\belse\s+(?!if\b)|\bdefault\s*:/.test(body))
    }
  }
}
