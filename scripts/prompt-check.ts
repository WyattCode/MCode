/**
 * The prompt plane: putting a reverted message back, and the per-model and
 * per-session state the composer and the panel read.
 *
 * Two kinds of assertion, for two ways this can break. The first half runs the
 * pure functions the window uses - the mention/attachment split, the variant
 * resolution, the tab-strip map - because each is a rule copied from the
 * reference and a wrong answer there is silent: the message comes back looking
 * right and sends the same file twice, or the effort pill offers a level the
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
import { cycleVariant, isLatest, resolveVariant, withoutLatest } from "../src/renderer/src/lib/model"
import { closeTab, openTab, readStrip, stripKey, stripKeys, writeStrip } from "../src/renderer/src/lib/session-tabs"
import { locateOffset } from "../src/renderer/src/lib/find"

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
 * `resolveModelVariant` reads the stored step and does not erase it; the cycle
 * walks the model's own list and falls off the end into "follow the default"
 * rather than wrapping.
 */
console.log("\nReasoning steps, per model")
{
  check("a step this model takes resolves to itself", resolveVariant(["low", "high"], "high"), "high")
  check("one it does not take resolves to nothing", resolveVariant(["low", "high"], "xhigh"), undefined)
  check("and no steps at all resolves to nothing", resolveVariant([], "low"), undefined)

  check("cycling a model with no steps does nothing", cycleVariant([], "low"), undefined)
  check("from unset, the first step", cycleVariant(["low", "medium", "high"], undefined), "low")
  check("then the next", cycleVariant(["low", "medium", "high"], "low"), "medium")
  check("off the end returns to the default", cycleVariant(["low", "medium", "high"], "high"), undefined)
  check("a step this model lacks starts again", cycleVariant(["low", "medium", "high"], "xhigh"), "low")
}

console.log("\nThe Latest tag")
{
  check("the word is taken out of the name", withoutLatest("Claude Sonnet 5 (latest)"), "Claude Sonnet 5")
  check("and reported as a tag", isLatest("Claude Sonnet 5 (latest)"), true)
  check("an ordinary name is untouched", withoutLatest("Claude Haiku 4.5"), "Claude Haiku 4.5")
  check("and carries no tag", isLatest("Claude Haiku 4.5"), false)
}

// ------------------------------------------------------- the panel's tab strip
console.log("\nThe right-hand panel, remembered per session")
{
  check("no session has no key", stripKey(undefined, "s1"), undefined)
  check("and no directory has none either", stripKey("D:/proj", undefined), undefined)
  const one = stripKey("D:/proj", "s1")
  const two = stripKey("D:/other", "s1")
  check("the same session in two projects is two keys", one !== two, true)
  check("a non-ASCII path does not throw", typeof stripKey("D:/项目", "s1"), "string")

  check(
    "an opened tab goes to the front",
    openTab({ all: ["other"] }, "context"),
    { all: ["context", "other"], active: "context" },
  )
  check(
    "opening it twice does not repeat it",
    openTab({ all: ["context", "other"], active: "other" }, "context"),
    { all: ["context", "other"], active: "context" },
  )
  check(
    "closing the only tab falls back to the review",
    closeTab({ all: ["context"], active: "context" }, "context"),
    { all: [], active: "review" },
  )
  check(
    "closing one with a neighbour to its left lands there",
    closeTab({ all: ["context", "other"], active: "other" }, "other"),
    { all: ["context"], active: "context" },
  )

  writeStrip(one, { all: ["context"], active: "context" })
  writeStrip(two, { all: [], active: "review" })
  check("what one session opened is there", [readStrip(one).all, readStrip(one).active], [["context"], "context"])
  check("and the session next door is not affected", readStrip(two).all, [])
  check("an unknown session reads as empty", readStrip("nothing/at-all").all, [])
}

console.log("\nThe map cannot grow without bound")
{
  /*
   * The reference caps it at 50 keys and evicts by last touch, pinning the
   * session that is open. The pause is because the stamp is a millisecond
   * clock: without it every key in this loop is written in the same tick and
   * "the oldest goes" has nothing to sort on.
   */
  const before = stripKeys().length
  const oldest = stripKey("D:/aged", "s0")!
  writeStrip(oldest, { all: ["context"], active: "context" })
  await new Promise((done) => setTimeout(done, 4))
  for (let index = 0; index < 60; index += 1) {
    writeStrip(stripKey("D:/bulk", `s${index}`)!, { all: [], active: "review" })
  }
  check("the map stops at fifty keys", stripKeys().length, 50)
  check("and the oldest entry is the one that went", readStrip(oldest).all, [])
  check("while the session just written is kept", readStrip(stripKey("D:/bulk", "s59")!).active, "review")
  check("which is fewer than were written", before + 61 > 50, true)
}

// --------------------------------------------------------------- the seams
/*
 * Every one of these is a call across a file boundary that nothing else
 * enforces. The composer's two new methods are reached through a template ref,
 * the two revert buttons reach them through an injected function, and the
 * effort pill's guard is one attribute - all four survive a type check with the
 * behaviour gone.
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
 * Two halves, both of them load-bearing: a model with no steps to choose
 * between gets no pill, and neither does the home screen - the setting belongs
 * to a session, and there is no session behind that box until a message is
 * sent. MiMo's home box carries no such control either.
 */
check(
  "the effort pill is drawn only for a model with steps, and only with a session",
  /<div v-if="variants\.length && sessionID" class="pill-wrap">/.test(composer),
  true,
)
check(
  "and its menu offers exactly those steps",
  /EFFORT_CHOICES = computed<\(Effort \| undefined\)\[\]>\(\(\) => \[undefined, \.\.\.variants\.value\]\)/.test(composer),
  true,
)

const stream = read(`${components}/MessageStream.vue`)
check(
  "reverting from the transcript puts the message back in the box",
  /await app\.revert\(sessionID, turn\.id\)[\s\S]{0,200}restoreDraft\(message\)/.test(stream),
  true,
)

const dock = read(`${components}/RevertDock.vue`)
check(
  "restoring from the dock follows the boundary",
  /const next = app\.rolledBack\[at \+ 1\][\s\S]{0,200}restoreDraft\(next\)/.test(dock),
  true,
)
check("and the dock names attachments the reference's way", dock.includes("draftLine("), true)
/*
 * `draftLine` is free of the string table on purpose, so the dock is the only
 * place the empty-message word can come from. Dropping the argument leaves a
 * blank row that compiles and that no locale check can see, since the key would
 * still be defined in all eighteen tables.
 */
check(
  "and hands it the word for a message that flattens to nothing",
  /draftLine\(message, t\("common\.attachment"\)\)/.test(dock),
  true,
)

const app = read("src/renderer/src/App.vue")
check("App.vue is what hands the composer down", app.includes("provideRestoreDraft("), true)
check(
  "the panel's tabs are read per session",
  /const strip = computed\(\(\) => readStrip\(tabsKey\.value\)\)/.test(app),
  true,
)
check(
  "and nothing resets them on a session change",
  /watch\(\s*\(\) => app\.current\?\.id,\s*\(\) => \{\s*contextTab\.value = false/.test(app),
  false,
)


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

if (problems.length) {
  console.error(`\nFAILED with ${problems.length} problem(s):`)
  for (const problem of problems) console.error("  " + problem)
  process.exit(1)
}
console.log(`\n${passed} passed, 0 failed`)
console.log("A reverted message comes back whole, the steps offered are the model's own, and the strip is per session.")
