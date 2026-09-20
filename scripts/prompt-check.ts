/**
 * The prompt plane: putting a reverted message back, and the per-model and
 * per-session state the composer and the panel read.
 *
 * Two kinds of assertion, for two ways this can break. The first half runs the
 * pure functions the window uses - the mention/attachment split, the level a
 * model runs at, the tab-strip map - because each is a rule copied from the
 * reference and a wrong answer there is silent: the message comes back looking
 * right and sends the same file twice, or the model pill names a level the
 * provider drops. The second half reads the components, because those functions
 * are only worth anything while something still calls them, and a seam between
 * a helper and the one component that uses it is exactly what a type checker
 * has nothing to say about.
 */
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import type { UserMessage } from "../src/shared/protocol"
import { draftFromMessage, draftLine } from "../src/renderer/src/lib/draft"
import { clampEffort, cycleVariant, isLatest, withoutLatest } from "../src/renderer/src/lib/model"
import { createPinia, setActivePinia } from "pinia"
import { useRightPanel } from "../src/renderer/src/stores/right-panel"
import { locateOffset } from "../src/renderer/src/lib/find"
import { PLAN_SECTION, agentPrompt } from "../src/server/session/prompts"

let passed = 0
const problems: string[] = []

function check(what: string, got: unknown, want: unknown) {
  const a = JSON.stringify(got)
  const b = JSON.stringify(want)
  if (a === b) {
    passed += 1
    console.log(`  ok   ${what}`)
    return
  }
  problems.push(`${what}\n         wanted ${b}\n         got    ${a}`)
  console.log(`  FAIL ${what}`)
}

function message(text: string, paths: string[]): UserMessage {
  return {
    id: "m1",
    sessionID: "s1",
    role: "user",
    text,
    attachments: paths.map((file) => ({ path: file, mime: "text/plain", data: "x" })),
    time: { created: 0 },
  }
}

// ------------------------------------------- putting a message back in the box
/*
 * The split is the whole reason this is not a one-line change. This app flattens
 * an @mention into `message.attachments` when the message is sent and reads the
 * file again on the next send, so a restored message that keeps the mention in
 * its text AND its file in the chip list sends that file twice.
 */
console.log("\nRestoring a rolled back message")
{
  const restored = draftFromMessage(message("look at @src/a.ts please", ["src/a.ts", "shot.png"]))
  check("the text comes back whole", restored.text, "look at @src/a.ts please")
  check("a mentioned file is not also a chip", restored.attachments.map((f) => f.path), ["shot.png"])
  check("and it is a live mention again", [...restored.mentioned], ["src/a.ts"])

  const plain = draftFromMessage(message("no mentions here", ["shot.png"]))
  check("a picked file stays a chip", plain.attachments.map((f) => f.path), ["shot.png"])
  check("with nothing mentioned", [...plain.mentioned], [])
}

console.log("\nThe one line a rolled back message shows")
{
  check("paragraphs collapse to one line", draftLine(message("hello\n\n  world", [])), "hello world")
  check(
    "an attachment is named the reference's way",
    draftLine(message("look", ["C:/tmp/shot.png"])),
    "look[image:shot.png]",
  )
  check(
    "a mentioned file is not listed twice",
    draftLine(message("read @src/a.ts", ["src/a.ts"])),
    "read @src/a.ts",
  )
  check("nothing at all is an empty line", draftLine(message("   ", [])), "")
  /*
   * The reference's last branch, which the dock now supplies the word for: a
   * message that flattens to nothing still gets a row rather than a blank one.
   */
  check("unless the caller has a word for it", draftLine(message("   ", []), "attachment"), "[attachment]")
}

// ------------------------------------------------- which steps a model accepts
/*
 * MiMo clamps the level a model runs at: the one set, if this model takes it;
 * else medium; else the model's first. The menu has no "follow the default"
 * row any more, so a model with levels always names one. The keyboard's cycle
 * still walks the model's own list and falls off the end rather than wrapping.
 */
console.log("\nReasoning steps, per model")
{
  check("a level this model takes is kept", clampEffort(["low", "high"], "high"), "high")
  check(
    "one it lacks snaps to medium, or without medium to the first",
    [clampEffort(["low", "medium", "high"], "xhigh"), clampEffort(["low", "high"], "xhigh")],
    ["medium", "low"],
  )
  check("and a model without levels runs at none", clampEffort([], "low"), undefined)

  check("cycling a model with no steps does nothing", cycleVariant([], "low"), undefined)
  check("from unset, the first step", cycleVariant(["low", "medium", "high"], undefined), "low")
  check("then the next", cycleVariant(["low", "medium", "high"], "low"), "medium")
  check("off the end wraps to the first, the level being app-wide", cycleVariant(["low", "medium", "high"], "high"), "low")
  check("a step this model lacks starts again", cycleVariant(["low", "medium", "high"], "xhigh"), "low")
}

console.log("\nThe Latest tag")
{
  check("the word is taken out of the name", withoutLatest("Claude Sonnet 5 (latest)"), "Claude Sonnet 5")
  check("and reported as a tag", isLatest("Claude Sonnet 5 (latest)"), true)
  check("an ordinary name is untouched", withoutLatest("Claude Haiku 4.5"), "Claude Haiku 4.5")
  check("and carries no tag", isLatest("Claude Haiku 4.5"), false)
}

// ------------------------------------------------------- the right panel's tabs
console.log("\nThe right panel's tabs, as MiMo keeps them")
{
  setActivePinia(createPinia())
  const rp = useRightPanel()
  const gone: string[] = []
  rp.setDisposer((tab) => gone.push(tab.id))

  rp.setScope("s1")
  const review = rp.openTool("review")
  check("a tool opens the panel on its own tab", [rp.open, rp.active], [true, review.id])
  const second = rp.openTool("review")
  check("asking again adds another, numbered", [rp.tabs.length, second.ord], [2, 2])
  const files = rp.openTool("files")
  check("the files tab is kept single", rp.openTool("files").id, files.id)

  rp.activate(second.id)
  rp.close([second.id])
  check("closing the tab on show selects its right-hand neighbour", rp.active, files.id)
  rp.close([files.id])
  check("or, at the end of the row, the one to its left", rp.active, review.id)
  rp.close([review.id])
  check("closing the last tab shuts the panel", [rp.open, rp.tabs.length], [false, 0])
  check("and every closed tab was let go of", gone.length, 3)

  const terminal = rp.openTool("terminal")
  rp.setScope("s2")
  check("another conversation starts with no tabs and the panel shut", [rp.tabs.length, rp.open], [0, false])
  rp.setScope("s1")
  check("coming back hands the conversation its tabs", [rp.tabs.map((tab) => tab.id), rp.open], [[terminal.id], true])

  rp.setScope(undefined)
  rp.openTool("browser")
  const before = gone.length
  rp.setScope("s1")
  check("tabs opened on the home screen go when a conversation is entered", gone.length, before + 1)

  rp.toggleFullscreen()
  check("the open panel expands", rp.fullscreen, true)
  rp.toggleOpen()
  check("and putting it away lets the expansion go", [rp.open, rp.fullscreen], [false, false])
  rp.toggleFullscreen()
  check("a shut panel does not expand", rp.fullscreen, false)

  rp.openDiff("3 files", "@@ -1 +1 @@", "live-edit")
  check("a diff opens as a tab of its own", rp.activeTab?.type, "diff")
  rp.toggleDiff("3 files", "@@ -1 +1 @@", "live-edit")
  check("asking for the same diff while it is on show puts the panel away", rp.open, false)
  rp.toggleDiff("4 files", "@@ -2 +2 @@", "live-edit")
  check("asking again brings back the same tab, updated", [rp.tabs.filter((tab) => tab.type === "diff").length, rp.activeTab?.name], [1, "4 files"])

  rp.forget("s1")
}

// --------------------------------------------------------------- the seams
/*
 * Every one of these is a call across a file boundary that nothing else
 * enforces. The composer's two new methods are reached through a template ref,
 * the two revert buttons reach them through an injected function, and the
 * effort label's guard is one attribute - all of them survive a type check with
 * the behaviour gone.
 */
console.log("\nWhat the components still do")
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..")
const read = (relative: string) => fs.readFileSync(path.join(root, relative), "utf8")
const components = "src/renderer/src/components"

const composer = read(`${components}/Composer.vue`)
const expose = composer.slice(composer.indexOf("defineExpose({"), composer.indexOf("defineExpose({") + 200)
for (const method of ["set", "reset"]) {
  check(`the composer exposes ${method}()`, new RegExp(`[{,] ?${method}[,}]`).test(expose), true)
}
check(
  "the prompt setter replaces the attachments rather than adding to them",
  /function set\(next: Draft\) \{[^}]*attachments\.value = next\.attachments/.test(composer),
  true,
)
/*
 * MiMo has no effort pill of its own: the level is named on the model pill, and
 * chosen from a submenu beside each model. Both halves are load-bearing - the
 * name is the clamped level, so a model without levels shows none and a side
 * chat asks for none; and each row offers exactly its model's levels, with no
 * 默认 row since the composer branch removed it.
 */
check(
  "the level is named on the model pill outside a side chat, and only once clamped to the model's levels",
  /<span v-if="!smartOn && !side && effortLabel" class="model-effort"/.test(composer) &&
    /const effortLevel = computed<Effort \| undefined>\(\(\) =>\s*clampEffort\(variants\.value,/.test(composer),
  true,
)
check(
  "and a model row's level menu offers exactly that model's levels, none in a side chat",
  /function effortsFor\(model: ModelInfo\): Effort\[\] \{\s*return props\.side \? \[\] : model\.variants\s*\}/.test(composer),
  true,
)

const stream = read(`${components}/MessageStream.vue`)
check(
  "a retry that is not accepted puts the question back in the box",
  /await app\.truncate\(sessionID, turn\.id\)[\s\S]{0,300}restoreDraft\(message\)/.test(stream),
  true,
)

const app = read("src/renderer/src/App.vue")
check("App.vue is what hands the composer down", app.includes("provideRestoreDraft("), true)


/*
 * Find-in-view's offset arithmetic.
 *
 * `scan` walks every text node under the pane, joins them into one string, and
 * maps a match's position back onto a node with `locateOffset`. That mapping
 * had `>=` where it needed `>`, so an offset landing exactly on a node boundary
 * was handed to the node BEFORE it at an offset equal to that node's whole
 * length; `scan` then asked for one past the end and `setEnd` threw
 * `IndexSizeError: The offset 12 is larger than the node's length (11)`. Vue
 * turned that into a fatal render error and the whole window went to the error
 * page - from typing one character into a search box.
 *
 * Nothing here needs a DOM, which is the point: the defect was arithmetic, it
 * crashed only in a browser, and no check in the project could see it.
 */
console.log("\nfind-in-view maps an offset back onto a node")
{
  // Three text nodes, of 5, 6 and 4 characters.
  const ends = [5, 11, 15]
  const lengths = [5, 6, 4]
  const at = (offset: number) => {
    const found = locateOffset(ends, offset)
    return `${found.index}:${found.offset}`
  }

  check("the first character is the first node's first", at(0), "0:0")
  check("an offset inside a node stays in it", at(3), "0:3")
  check("the last character of a node is still that node's", at(4), "0:4")
  check("THE BOUNDARY: the next character belongs to the next node", at(5), "1:0")
  check("the second boundary too", at(11), "2:0")
  check("the very last character", at(14), "2:3")

  /*
   * The crash itself, as arithmetic. `scan` locates a match's LAST character
   * and ends the range one past it, so no offset it hands `setEnd` may exceed
   * the node it named. Under the old comparison this overflowed at every
   * boundary, which is exactly what took the renderer down.
   */
  const overflow: number[] = []
  for (let last = 0; last < 15; last += 1) {
    const found = locateOffset(ends, last)
    if (found.offset + 1 > lengths[found.index]) overflow.push(last)
  }
  check("no match end can ask for an offset past its node", overflow.join(",") || "none", "none")

  // One node is the common case and must not regress.
  check("a single node, first character", `${locateOffset([9], 0).index}:${locateOffset([9], 0).offset}`, "0:0")
  check("a single node, last character", `${locateOffset([9], 8).index}:${locateOffset([9], 8).offset}`, "0:8")
}

/*
 * The agent prompt, section by section.
 *
 * MiMo's desktop app gives every model one prompt: a general part, then a
 * desktop part, then - in plan mode only - a planning section. MCode does the
 * same, and this is what says so. The headings are listed here by hand, in
 * order, rather than read off the prompt, so a section cut out of
 * `session/prompts.ts` or a family split creeping back fails here instead of
 * quietly agreeing with itself.
 */
console.log("\nThe one agent prompt every model reads")
{
  const build = agentPrompt("build")
  const headings = build.split("\n").filter((line) => /^#{1,3} /.test(line))
  check("its sections, in the desktop prompt's order", headings, [
    "# System",
    "# Doing tasks",
    "# Executing actions with care",
    "# Using your tools",
    "# Tone and style",
    "# Text output (not tool calls)",
    "# Session-specific guidance",
    "# MCode desktop",
    "## Reply language",
    "## Tone and formatting",
    "## Visual explanations",
    "## Asking clarifying questions",
    "## Task management",
    "## Doing tasks",
    "## Files you produce",
    "### A file, or an answer?",
    "### present_files",
    "### Images and video",
    "### Web pages",
    "### Office documents and PDF",
    "## Tools on this machine",
    "# Code references",
    "## Web page work",
    "### Slide decks",
  ])
  /* The desktop's general part is about 12KB and its desktop part about 16.5KB; MCode leaves out what it does not have. */
  const split = build.indexOf("\n\n# MCode desktop\n")
  check("the general part is in the length class of the one it answers", split > 8_000 && split < 14_000, true)
  check("and so is the desktop part", build.length - split > 9_000 && build.length - split < 18_000, true)
  check("every agent but plan reads exactly the same text", [agentPrompt("compose"), agentPrompt(undefined), agentPrompt("general")].every((text) => text === build), true)
  const plan = agentPrompt("plan")
  check("plan mode reads the same text with one section after it", plan.startsWith(build + "\n\n# Plan mode\n") && plan === `${build}\n\n${PLAN_SECTION}`, true)
  check("that section is short, as the one it answers is", PLAN_SECTION.length > 400 && PLAN_SECTION.length < 1_500, true)
  check("it asks for a stepwise plan, recorded with task, put to the user with plan_exit", ["plan in steps", "`task` tool", "plan_exit"].filter((part) => !PLAN_SECTION.includes(part)), [])
  check("the prompt names this app and never the reference", plan.startsWith("You are MCode") && !/mimo/i.test(plan), true)
  /*
   * The interactive widget, under "Visual explanations". The three that matter
   * are the fence (nothing renders without it), the sizing rule (a widget laid
   * out against the viewport collapses the card to a sliver) and that it is
   * rendered rather than delivered.
   */
  const widget = build.slice(build.indexOf("## Visual explanations"), build.indexOf("## Asking clarifying questions"))
  check("the widget's fence, sizing rule and place are all stated", ["```sci-widget", "height:100vh", "window.innerHeight", "aspect-ratio", "present_files"].filter((part) => !widget.includes(part)), [])
}

if (problems.length) {
  console.error(`\nFAILED with ${problems.length} problem(s):`)
  for (const problem of problems) console.error("  " + problem)
  process.exit(1)
}
console.log(`\n${passed} passed, 0 failed`)
console.log("A reverted message comes back whole, the steps offered are the model's own, and the strip is per session.")
