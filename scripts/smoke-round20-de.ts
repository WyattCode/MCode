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

  section("Round 20: D-8 the settings list keeps its inset at the start in a right-to-left language")
  {
    const dialog = await read("src/renderer/src/components/SettingsDialog.vue")
    const rule = /\n\.nav-scroll \{([^}]*)\}/.exec(dialog)?.[1] ?? ""
    check("D-8: the list's inset is on the logical start", /padding-inline:\s*11px 0;/.test(rule) && /padding-block:\s*0 12px;/.test(rule), rule)
    check("D-8: no physical left inset is left behind", !/padding(-left)?:[^;]*11px/.test(rule.replace(/padding-inline:[^;]*;/, "")), rule)
  }

  section("Round 20: D-9 the edited-files card reviews a notebook edit's recorded diff")
  {
    const lib = (await import("../src/renderer/src/lib/edited-files")) as Record<string, unknown>
    const recorded = lib.recordedPatch as ((parts: readonly unknown[]) => string) | undefined
    check("D-9: the card's fallback patch is a function smoke can hold", typeof recorded === "function")
    if (recorded) {
      const diff = (file: string) => `--- a/${file}\n+++ b/${file}\n@@ -1 +1 @@\n-a\n+b\n`
      const tool = (name: string, file: string, status = "completed") => ({ type: "tool", name, status, id: file, metadata: { diff: diff(file) } })
      const patch = recorded([tool("edit", "a.ts"), tool("notebook_edit", "n.ipynb"), tool("write", "w.ts"), tool("bash", "x.sh"), tool("notebook_edit", "bad.ipynb", "error")])
      check("D-9: a notebook edit's diff is reviewed with the edits and writes", patch.includes("n.ipynb") && patch.includes("a.ts") && patch.includes("w.ts"), patch)
      check("D-9: a shell call or a failed call adds nothing", !patch.includes("x.sh") && !patch.includes("bad.ipynb"), patch)
    }
    const card = await read("src/renderer/src/components/EditedFilesCard.vue")
    check("D-9: the card uses it, with no list of its own", /patch = recordedPatch\(props\.parts\)/.test(card) && !/\["edit", "write"\]/.test(card))
  }

  section("Round 20: D-3 the folded column's preview stays while a menu or card opened from it is up")
  {
    const side = await read("src/renderer/src/components/Sidebar.vue")
    const layers = /const PREVIEW_LAYERS = '([^']*)'/.exec(side)?.[1] ?? ""
    check("D-3: a menu, its scrim and an information card count as the preview's", ['.scrim', '[role="menu"]', ".app-tip.interactive"].every((part) => layers.includes(part)), layers)
    const press = /function onPreviewPress\([^)]*\) \{([\s\S]*?)\n\}/.exec(side)?.[1] ?? ""
    check("D-3: a press on one of them is not a press elsewhere", /inPreview\(target\)/.test(press), press)
    const key = /function onPreviewKey\([^)]*\) \{([\s\S]*?)\n\}/.exec(side)?.[1] ?? ""
    check("D-3: an Escape a menu took closes the menu alone", /!event\.defaultPrevented/.test(key), key)
    check("D-3: where the pointer is decides the hold, across the whole document", /addEventListener\("pointerover", onPreviewOver, true\)/.test(side) && /addEventListener\("pointerout", onPreviewOut, true\)/.test(side))
    check("D-3: the shell's own leave no longer lets the preview go under an open menu", !/@pointerleave="holdPreview\(false\)"/.test(side))
  }

  section("Round 20: D-7 the models page's title is the settings title")
  {
    const page = await read("src/renderer/src/components/ModelsPage.vue")
    const title = /\nh2 \{([^}]*)\}/.exec(page)?.[1] ?? ""
    check(
      "D-7: 24px, regular weight, 38.4 high, as every other settings page's title",
      /font-size:\s*calc\(24px \* var\(--ui-font-scale, 1\)\)/.test(title) && /font-weight:\s*400/.test(title) && /line-height:\s*calc\(38\.4px \* var\(--ui-font-scale, 1\)\)/.test(title),
      title,
    )
    const note = /\n\.note \{([^}]*)\}/.exec(page)?.[1] ?? ""
    check("D-7: the intro no longer pulls itself up under a 32px margin", !/margin:\s*-/.test(note) && /margin:\s*2px 0 4px/.test(note), note)
  }

  section("Round 20: the connect dialog puts the keys where its autofocus asked, every time it opens")
  {
    const dialog = await read("src/renderer/src/components/ConnectDialog.vue")
    const form = await read("src/renderer/src/components/CustomProviderForm.vue")
    check("autofocus: no attribute Chromium honours once per document is relied on", !/\sautofocus[\s/>]/.test(dialog.replace(/<CustomProviderForm[^>]*>/, "")) && !/:autofocus=/.test(form))
    check("autofocus: the list's search is focused whenever the list is shown", /if \(now === "browse"\) void nextTick\(\(\) => searchEl\.value\?\.focus\(\)\)/.test(dialog) && /<input ref="searchEl"/.test(dialog))
    check("autofocus: the custom form focuses its id field itself when asked", /if \(props\.autofocus\) providerIdEl\.value\?\.focus\(\)/.test(form) && /ref="providerIdEl"/.test(form))
  }

  section("Round 20: E-1 a page with /Rotate has its text and links turned onto it")
  {
    const view = await read("src/renderer/src/components/right/PdfView.vue")
    // pdf.js 5.4.296's own rules (web/pdf_viewer.css), which react-pdf ships and MiMo's pdfEngine.css carries.
    const turns: [string, string][] = [
      ["90", "rotate(90deg) translateY(-100%)"],
      ["180", "rotate(180deg) translate(-100%, -100%)"],
      ["270", "rotate(270deg) translateX(-100%)"],
    ]
    for (const [angle, transform] of turns) {
      const rule = new RegExp(`\\n\\.pdf-view \\[data-main-rotation="${angle}"\\] \\{\\s*transform: ([^;]*);`).exec(view)?.[1]
      check(`E-1: a layer marked ${angle} is turned by ${transform}`, rule === transform, rule)
    }
  }

  section("Round 20: E-6 a page's /UserUnit reaches the layers' scale")
  {
    const view = await read("src/renderer/src/components/right/PdfView.vue")
    check("E-6: the drawing sets the page's user unit beside its scale", /layer\.style\.setProperty\("--user-unit", String\(viewport\.userUnit\)\)/.test(view))
    const layers = /\n\.pdf-layers \{([^}]*)\}/.exec(view)?.[1] ?? ""
    check("E-6: no fixed 1 left behind in the stylesheet", !/--user-unit:\s*1/.test(layers), layers)
  }

  section("Round 20: E-5 the PDF view's frames stop at the scroll area")
  {
    const view = await read("src/renderer/src/components/right/PdfView.vue")
    const overlay = /<div class="pdf-overlay"[\s\S]*?\n {4}<\/div>\n/.exec(view)?.[0] ?? ""
    check("E-5: the found passage, the waiting frames and the working light are all inside the cut", /data-locate-rect/.test(overlay) && /class="pdf-marks"/.test(overlay) && /<AnnotationFx/.test(overlay), overlay.slice(0, 200))
    const rule = /\n\.pdf-overlay \{([^}]*)\}/.exec(view)?.[1] ?? ""
    check("E-5: the cut is a clip", /overflow:\s*hidden/.test(rule) && /pointer-events:\s*none/.test(rule), rule)
    check("E-5: sized to the scroll area without its scrollbars", /markerSize\.value = \{ w: scroller\.value\.clientWidth, h: scroller\.value\.clientHeight \}/.test(view) && /:style="\{ width: `\$\{markerSize\.w\}px`, height: `\$\{markerSize\.h\}px` \}"/.test(view))
  }
}
