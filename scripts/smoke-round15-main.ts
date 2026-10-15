/**
 * Round 15 (lane M): the bugs the second read-only pass found in the main
 * process - the browser panel's dead tabs and its listeners, the office file
 * watches an in-app reload used to leak.
 *
 * M15-1 to M15-4 are measured rather than read: smoke-round15-main-electron.ts
 * drives the real browser.ts and office.ts under Electron, with a throwaway
 * user-data folder, and this reads what it saw. M15-5 went with the tray's
 * profile switch it guarded (R18-U2).
 */
import { execFileSync, spawn } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createRequire } from "node:module"
import type { Check } from "./smoke-round5"
import { esbuildCommand } from "./esbuild-command"

type Tried = { ok: boolean; value?: unknown; error?: string }
type MainResult = {
  timedOut?: boolean
  uncaught?: string[]
  dead?: {
    closedTab?: string
    panelState: Tried
    tabs: number | null
    hasClosedTab: boolean
    act: Tried
    newTab: Tried
    navigate: Tried
    select: Tried
    bounds: Tried
    clear: Tried
    lastPublished: string[] | null
  }
  reload?: { tabsBefore: number; childrenBefore: number; hasPanel: boolean; children: number; pagesBefore: number; pagesAfter: number }
  listeners?: { start: number; closed: number; navigationStart: number; navigation: number; warned: number; hasPanel: boolean }
  watch?: { watching: unknown; before: string[]; after: string[]; renderer: boolean }
  error?: string
}

/** Runs the lane's helper under Electron and returns what it saw. */
async function underElectron(root: string): Promise<MainResult> {
  const work = await fs.mkdtemp(path.join(os.tmpdir(), "mcode-r15m-run-"))
  try {
    // ESM, as the app's own main is: office.ts reaches code that reads import.meta.url.
    const bundle = path.join(root, "out", "smoke-round15-main.mjs")
    const esbuild = esbuildCommand(root)
    execFileSync(
      esbuild.file,
      [
        ...esbuild.prefix,
        "scripts/smoke-round15-main-electron.ts",
        "--bundle",
        "--platform=node",
        "--format=esm",
        "--target=node22",
        "--alias:@shared=./src/shared",
        "--packages=external",
        `--outfile=${bundle}`,
        "--log-level=error",
      ],
      { cwd: root, stdio: "ignore" },
    )
    const verdict = path.join(work, "main.json")
    const electron = createRequire(import.meta.url)("electron") as unknown as string
    const child = spawn(electron, [bundle, `--user-data-dir=${path.join(work, "profile")}`, verdict], { stdio: "ignore", windowsHide: true, env: ((e) => { delete e.ELECTRON_RUN_AS_NODE; return e })({ ...process.env }) })
    await new Promise<void>((resolve) => child.on("close", () => resolve()))
    const text = await fs.readFile(verdict, "utf8").catch(() => "")
    return text ? (JSON.parse(text) as MainResult) : { error: "the helper wrote nothing" }
  } finally {
    await fs.rm(work, { recursive: true, force: true }).catch(() => undefined)
  }
}

export async function roundFifteenMainChecks(check: Check, section: (name: string) => void): Promise<void> {
  const root = process.cwd()
  const read = (file: string) => fs.readFile(path.join(root, file), "utf8")
  const seen = await underElectron(root)

  section("Round 15 (M15-1): a page in the browser panel that closes itself leaves the panel working")
  {
    check("the Electron helper ran", !seen.error && !seen.timedOut && Boolean(seen.dead), seen.error ?? (seen.timedOut ? "timed out" : undefined))
    const dead = seen.dead
    check("asking the panel for its state after a page closed itself answers instead of throwing", dead?.panelState.ok === true, dead?.panelState)
    check("the page that closed itself is no longer a tab of the panel", dead?.hasClosedTab === false && dead?.tabs === 2, { tabs: dead?.tabs, closed: dead?.closedTab })
    check("the window is told, so its tab row loses the tab with the page", Array.isArray(dead?.lastPublished) && !dead.lastPublished.includes(dead.closedTab ?? ""), dead?.lastPublished)
    check(
      "reload, new tab, navigate, select and bounds all still work",
      dead?.act.ok === true && dead.newTab.ok === true && dead.navigate.ok === true && dead.select.ok === true && dead.bounds.ok === true && dead.clear.ok === true,
      dead,
    )
    check("nothing in main was left uncaught", (seen.uncaught ?? []).length === 0, seen.uncaught)
  }

  section("Round 15 (M15-2): the interface loading again takes the panel's page with it")
  {
    const reload = seen.reload
    check("the panel was drawing a page before the reload", (reload?.childrenBefore ?? 0) >= 1 && (reload?.tabsBefore ?? 0) >= 2, reload)
    check("after an in-app reload no panel is left for the window", reload?.hasPanel === false, reload)
    check("and no page of it is still drawn over the interface", reload?.children === 0, reload)
    check("every page the panel held was closed, not only the first", (reload?.pagesBefore ?? 0) >= 2 && reload?.pagesAfter === 0, reload)
    // The same twelve opens as M15-4, counted for the listener this item adds.
    const listeners = seen.listeners
    check("and twelve panels left the window with one did-navigate listener, not twelve", listeners !== undefined && listeners.navigation === listeners.navigationStart + 1, listeners)
  }

  section("Round 15 (M15-3): an in-app reload lets go of the office file watches")
  {
    const watch = seen.watch
    check("the watch was taken, and a change reached the page that asked (the control)", watch?.watching === true && (watch?.before ?? []).length >= 1, watch)
    check("the same web contents carries the new page, so a leaked watch would still reach it", watch?.renderer === false, watch)
    check("after the reload a change reaches nobody: the watch went with the page that asked", (watch?.after ?? ["leaked"]).length === 0, watch)
  }

  section("Round 15 (M15-4): opening the browser panel again does not pile listeners on the window")
  {
    const listeners = seen.listeners
    check("twelve panels came and went without the panel outliving its last tab", listeners?.hasPanel === false, listeners)
    check("the window gained one closed listener for all of them", listeners !== undefined && listeners.closed === listeners.start + 1, listeners)
  }
}
