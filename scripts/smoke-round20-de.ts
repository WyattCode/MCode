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
    check("D-2: the list opens and changes with nothing highlighted", /const highlight = ref\(-1\)/.test(form) && /\(\) => \(highlight\.value = -1\)[,)]/.test(form))
    check("D-2: Enter goes through the rule", /addModel\(comboEnterValue\(/.test(form))
    check("D-2: an ArrowDown that opens the list is not reset after it moves", /\(\) => \(highlight\.value = -1\), \{ flush: "sync" \}\)/.test(form))
  }

  section("Round 20: D-5 the arrows keep the highlighted suggestion in the list's view")
  {
    const form = await read("src/renderer/src/components/CustomProviderForm.vue")
    const key = /function comboKey\([^)]*\) \{([\s\S]*?)\n\}/.exec(form)?.[1] ?? ""
    const down = /"ArrowDown"\) \{([\s\S]*?)\} else if/.exec(key)?.[1] ?? ""
    const up = /"ArrowUp"\) \{([\s\S]*?)\} else if/.exec(key)?.[1] ?? ""
    const reveal = /function revealHighlight\(\) \{([\s\S]*?)\n\}/.exec(form)?.[1] ?? ""
    check("D-5: both arrows reveal the row they land on", down.includes("revealHighlight()") && up.includes("revealHighlight()"), key)
    check("D-5: the row is scrolled into the list's view, the nearest way", /comboMenuEl\.value\?\.querySelector<HTMLElement>\("\.cp-option\.on"\)\?\.scrollIntoView\(\{ block: "nearest" \}\)/.test(reveal), reveal)
    check("D-5: the list is the element held", /ref="comboMenuEl" class="cp-menu combo"/.test(form))
  }

  section("Round 20: D-4 the custom limit field keeps a number that reaches a preset")
  {
    const form = await read("src/renderer/src/components/CustomProviderForm.vue")
    const field = /<input[^>]*data-model-limit-custom[^>]*\/>/.exec(form)?.[0] ?? ""
    check("D-4: the field shows the limit itself, a preset included", /:value="row\[field\] !== undefined \? String\(row\[field\]\) : ''"/.test(field), field)
    check("D-4: no preset test blanks it while typing", !/LIMIT_PRESETS/.test(field), field)
  }

  section("Round 20: D-6 a saved provider form is clean again")
  {
    const form = await read("src/renderer/src/components/CustomProviderForm.vue")
    const submit = /async function submit\(\)[^{]*\{([\s\S]*?)\n\}/.exec(form)?.[1] ?? ""
    const remove = /async function confirmRemoveModel\(\) \{([\s\S]*?)\n\}/.exec(form)?.[1] ?? ""
    check("D-6: the saved state can move", /const pristine = ref\(JSON\.stringify\(form\.value\)\)/.test(form) && /!== pristine\.value\)/.test(form))
    check(
      "D-6: a save makes the form as saved the clean one",
      /await app\.addCustomProvider\(entry\)\n\s*pristine\.value = JSON\.stringify\(form\.value\)/.test(submit),
      submit,
    )
    check("D-6: a removed model, saved at once, leaves the saved form too", /saved\.models = saved\.models\.filter\(\(entry\) => entry\.key !== row\.key\)/.test(remove) && /pristine\.value = JSON\.stringify\(saved\)/.test(remove), remove)
    check("D-6: only when the removal was saved", /if \(removed\) \{/.test(remove) && /\.then\(\(\) => true, \(\) => false\)/.test(remove), remove)
  }

  section("Round 20: D-10 the connection light is not read out as a raw status")
  {
    const form = await read("src/renderer/src/components/CustomProviderForm.vue")
    const light = /<span class="cp-light"[^>]*\/>/.exec(form)?.[0] ?? ""
    check("D-10: the light is hidden from the accessibility tree", /aria-hidden="true"/.test(light) && !/aria-label/.test(light), light)
  }
}
