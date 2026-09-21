/**
 * Round 20, sections D (settings and shell) and E (right panel) of the code
 * review: each check fails on the code before its fix.
 *
 * What can run here runs against the real code; what lives only in markup or
 * CSS is read from the source, and its behaviour is measured in a real window
 * by the lane's Electron probes. smoke.ts calls `roundTwentyDeChecks` with its
 * own check and section.
 */
import fs from "node:fs/promises"
import path from "node:path"
import type { Check } from "./smoke-round5"

const read = (relative: string) => fs.readFile(path.join(process.cwd(), relative), "utf8")

export async function roundTwentyDeChecks(check: Check, section: (name: string) => void): Promise<void> {
  section("Round 20: D-1 the goal bar is one per conversation")
  {
    const composer = await read("src/renderer/src/components/Composer.vue")
    const bar = /<GoalBar\b[^>]*\/>/.exec(composer)?.[0] ?? ""
    check("D-1: the bar is keyed by the conversation, so a rewrite in progress never lands on another", /:key="sessionID"/.test(bar), bar)
  }
}
