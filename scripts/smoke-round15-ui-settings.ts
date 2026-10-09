/**
 * Round 15, lane U2: the settings dialog's rows at the window's own minimum,
 * and two declarations that were being read over by a later rule.
 *
 * The four readings come from Chromium: smoke-round15-ui-settings-layout.ts
 * lifts `SettingsDialog.vue`'s stylesheet, lays the two rows out in a card as
 * wide as the one measured at 720px, and sends back geometry and computed
 * values. So "the label is drawn over the buttons", "Entfernen is cut off by
 * the card" and "this path is 11.5px" are measured here, not spelt.
 *
 * The markup laid out there stands in for the template, so each check is paired
 * with a reading of the template it copies: a row that stops nesting that way
 * fails here rather than quietly measuring something else.
 *
 * Nothing reads the user's profile, calls a model or reaches the network.
 */
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { execFileSync, spawn } from "node:child_process"
import { createRequire } from "node:module"
import type { Check } from "./smoke-round5"
import { esbuildCommand } from "./esbuild-command"

interface Layout {
  error?: string
  cardWidth?: number
  provider?: { tagOverButtons: number; nameOverButtons: number; buttonsPastCard: number; cardClipsX: number; rowHeight: number }
  mcp?: { titleOverControl: number; controlPastCard: number; cardClipsX: number; titleHeight: number; titleLines: number }
  shortButtons?: { titleOverControl: number; controlPastCard: number; cardClipsX: number; titleLines: number }
  padding?: { emptyCard: string; wtEmpty: string }
  fontSize?: { configPath: string; subPath: string; lineSub: string }
}

/** Runs the layout helper under Electron and returns what it measured. */
async function measure(root: string): Promise<Layout> {
  const work = await fs.mkdtemp(path.join(os.tmpdir(), "mcode-r15u2-"))
  try {
    const bundle = path.join(root, "out", "smoke-round15-ui-settings-layout.cjs")
    const esbuild = esbuildCommand(root)
    execFileSync(
      esbuild.file,
      [
        ...esbuild.prefix,
        "scripts/smoke-round15-ui-settings-layout.ts",
        "--bundle",
        "--platform=node",
        "--format=cjs",
        "--target=node22",
        "--packages=external",
        `--outfile=${bundle}`,
        "--log-level=error",
      ],
      { cwd: root, stdio: "ignore" },
    )
    const verdict = path.join(work, "layout.json")
    const electron = createRequire(import.meta.url)("electron") as unknown as string
    const child = spawn(electron, [bundle, path.join(root, "src/renderer/src/components/SettingsDialog.vue"), verdict, `--user-data-dir=${path.join(work, "profile")}`], {
      stdio: "ignore",
      windowsHide: true,
    })
    await new Promise<void>((resolve) => child.on("close", () => resolve()))
    const text = await fs.readFile(verdict, "utf8").catch(() => "")
    return text ? (JSON.parse(text) as Layout) : { error: "the helper wrote nothing" }
  } finally {
    await fs.rm(work, { recursive: true, force: true }).catch(() => undefined)
  }
}

export async function roundFifteenSettingsUiChecks(check: Check, section: (name: string) => void): Promise<void> {
  const root = process.cwd()
  const dialog = await fs.readFile(path.join(root, "src/renderer/src/components/SettingsDialog.vue"), "utf8")
  const template = dialog.slice(0, dialog.indexOf("<style scoped>"))
  /**
   * Every rule written against that exact selector, run together: the MiMo
   * blocks at the foot of the file write a second `.line` and `.line-text`,
   * and a declaration can be in either of them.
   */
  const rule = (selector: string) => {
    let out = ""
    for (let at = dialog.indexOf(`\n${selector} {`); at !== -1; at = dialog.indexOf(`\n${selector} {`, at + 1)) out += dialog.slice(at, dialog.indexOf("}", at))
    return out
  }
  const layout = await measure(root)

  // ----------------------------------------------------------------- R15-U21
  section("Round 15 (R15-U21): the models and MCP rows stay inside their card at the 720px minimum")
  {
    check("the layout helper ran", !layout.error && Boolean(layout.mcp), layout.error)
    const m = layout.mcp
    // The template the helper's markup copies: a name and its tag in one flex
    // box, the buttons in another, both inside the row the card clips.
    check(
      "an MCP row is still a .line with .line-text / .line-title beside .mcp-ctrl",
      /<div class="line" :data-mcp-row="row.name">[\s\S]{0,200}?<div class="line-text">[\s\S]{0,120}?<div class="line-title">[\s\S]{0,900}?<div class="mcp-ctrl">/.test(template),
    )

    /*
     * The provider rows are gone from here.
     *
     * Four measurements used to run over a fixture built from .prow / .ptext /
     * .pname / .pdesc / .pmark, and the models page's redesign (R18-M5) took
     * every one of those classes with it - the note eight lines down says so.
     * The probe injects only SettingsDialog's own stylesheet, so those divs
     * stacked unstyled, every overlap was structurally 0 and no change to the
     * product could have made them red (R25-F5). `cardWidth === 330` measured
     * the probe's own `#page { width: 330px }`. The MCP rows below use live
     * classes and stay.
     */
    check("the MCP server's name is not drawn over its switch and buttons", m?.titleOverControl === 0, m?.titleOverControl)
    check("nor do those run past the card", (m?.controlPastCard ?? 1) <= 0 && m?.cardClipsX === 0, { past: m?.controlPastCard, clipped: m?.cardClipsX })
    check("a long server name sets in two lines at most, instead of breaking into a column", (m?.titleLines ?? 9) <= 2, { lines: m?.titleLines, height: m?.titleHeight })
    const s = layout.shortButtons
    check(
      "and the same row with a Chinese window's short buttons stays whole too, rather than keeping them beside a name set one syllable to the line",
      s?.titleOverControl === 0 && (s?.controlPastCard ?? 1) <= 0 && s?.cardClipsX === 0 && (s?.titleLines ?? 9) <= 2,
      s,
    )

    // What makes the above possible: the rows may wrap, and the control groups
    // are held to the end by a margin rather than by whatever grew beside them.
    // R18-M5: the provider rows went with the models page's redesign; the MCP rows remain.
    check("rows wrap rather than overflow", /flex-wrap:\s*wrap/.test(rule(".line")))
    check("and both control groups keep to the end of the row once they have", /margin-inline-start:\s*auto/.test(rule(".ctl-pair")) && /margin-inline-start:\s*auto/.test(rule(".mcp-ctrl")))
    check("the text column asks for a readable width before a control may sit beside it", /min-width:\s*min\(/.test(rule(".line-text")))
  }

  // ----------------------------------------------------------------- R15-U22
  section("Round 15 (R15-U22): the config path keeps its 11.5px, and the empty worktree card the rows' 16")
  {
    // R18-M5: the models page lost its config path (26.920 keeps it on the config page alone), and with it these measurements.
    const pad = layout.padding
    // R21-F2: MiMo's sr is 16 on every side, so the card that holds a sentence is too.
    check("and that is the rows' 16 on every side", pad?.wtEmpty === "16px", pad?.wtEmpty)
  }
}
