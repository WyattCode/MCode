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

  section("Round 20: D-2 Enter in the models field adds what was typed unless a suggestion was moved to")
  {
    const lib = (await import("../src/renderer/src/lib/custom-model")) as Record<string, unknown>
    const enter = lib.comboEnterValue as ((highlight: number, choices: readonly string[], typed: string) => string) | undefined
    check("D-2: the rule is a pure function smoke can hold", typeof enter === "function")
    if (enter) {
      check("D-2: nothing moved to, a typed gpt-4 stays gpt-4 though gpt-4o heads the list", enter(-1, ["gpt-4o", "gpt-4-turbo"], "gpt-4") === "gpt-4")
      check("D-2: moved to the second suggestion, that is what goes in", enter(1, ["gpt-4o", "gpt-4-turbo"], "gpt-4") === "gpt-4-turbo")
    }
    const form = await read("src/renderer/src/components/CustomProviderForm.vue")
    check("D-2: the list opens and changes with nothing highlighted", /const highlight = ref\(-1\)/.test(form) && /\(\) => \(highlight\.value = -1\)\)/.test(form))
    check("D-2: Enter goes through the rule", /addModel\(comboEnterValue\(/.test(form))
  }
}
