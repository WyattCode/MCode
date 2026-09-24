/**
 * Round 20, lane C: the conversation view's review findings (C-1 to C-8 and a
 * question taller than the view).
 *
 * The park's rules are plain functions (lib/scroll-follow) and run here; the
 * wiring into MessageStream, the store and the parts is read from the source.
 * Where a question comes to rest in a window was measured in the lane's
 * Electron probe against a slow local stream, before and after.
 */
import fs from "node:fs/promises"
import path from "node:path"
import type { Check } from "./smoke-round5"
import * as follow from "../src/renderer/src/lib/scroll-follow"

const read = (relative: string) => fs.readFile(path.join(process.cwd(), relative), "utf8")

/** A function's body in a source file, from its declaration to the next top-level one. */
function body(source: string, head: string): string {
  const at = source.indexOf(head)
  if (at === -1) return ""
  const next = source.slice(at + head.length).search(/\n(?:async )?function |\nconst |\nlet |\nwatch\(|\nonMounted\(|\n\/\*/)
  return next === -1 ? source.slice(at) : source.slice(at, at + head.length + next)
}

/** Code without its comments, so a check reads what runs. */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")
}

export async function roundTwentyLaneCChecks(check: Check, section: (name: string) => void): Promise<void> {
  const stream = await read("src/renderer/src/components/MessageStream.vue")
  const script = stream.slice(0, stream.indexOf("<template>"))

  // ------------------------------------------------------------------ R20-C-1
  section("Round 20 (C-1): a park's slide does not cost the question its floor")
  {
    const scroll = code(body(script, "function onScroll("))
    const release = scroll.split("\n").find((line) => line.includes("releaseFloor()")) ?? ""
    check("the scroll handler leaves the floor alone while the slide runs", /!endSlide\s*&&/.test(release), release.trim())
  }

  // ------------------------------------------------------------------ R20-C-3
  section("Round 20 (C-3): a park moves the view even while a hold is on")
  {
    const park = code(body(script, "function park("))
    check("park scrolls itself rather than through pin(), which a hold vetoes", /toBottom\(\)/.test(park) && !/\bpin\(\)/.test(park), park.slice(-400))
    check("and turns following off after it", /following\.value = false/.test(park) && park.indexOf("following.value = false") > park.indexOf("toBottom()"))
  }

  // ------------------------------------------------------------------ R20-C-tall
  section("Round 20 (C, tall question): a question taller than the view parks with its top in sight")
  {
    const parkTop = (follow as Record<string, unknown>).parkTop as ((rowTop: number, target: number, client: number, end: number) => number | undefined) | undefined
    check("scroll-follow says where a tall question rests", typeof parkTop === "function")
    if (parkTop) {
      check("an 800px question in a 600px view rests with its top at the 12px target", parkTop(1000, 12, 600, 1840) === 988)
      check("a short one still rests at the end, the floor making the room", parkTop(1000, 100, 600, 1080) === undefined)
      check("one that just fits rests at the end too", parkTop(1000, 12, 600, 1588) === undefined)
      check("never above the top of the conversation", parkTop(5, 12, 600, 1800) === 0)
    }
    const park = code(body(script, "function park("))
    check("park rests a tall question there instead of pinning it to the end", /parkTop\(/.test(park) && /settle\(rest\)/.test(park), park.slice(0, 300))
    // R21-P1: the hold is now every park's, not only a tall one's, and only the reader's own scroll gives it up.
    check("and holds it there while what is above settles", /parkRest = \{ row, target \}/.test(park) && /keepRest\(\)/.test(code(script.slice(script.indexOf("sizer = new ResizeObserver")))))
    const scroll = code(body(script, "function onScroll("))
    check("until the reader scrolls", /if \(readerMoved\(echo, up, arrived\)\) parkRest = undefined/.test(scroll))
  }

  // ------------------------------------------------------------------ R20-C-4
  section("Round 20 (C-4): a new conversation's first question enters and parks")
  {
    const plain = code(script)
    const mount = plain.match(/const mountPark = ([^\n]+)/)?.[1] ?? ""
    check("the view takes a pending park as it mounts, for the main conversation only", /consumePark\(shownID\.value\)/.test(mount) && /!props\.side/.test(mount) && /!props\.latest/.test(mount) && /!props\.subagent/.test(mount), mount)
    check("and parks that question once mounted", /onMounted\(\(\) => \{\s*if \(mountPark\) park\(mountPark\)/.test(plain))
    const seeded = plain.match(/let entering: EnterMark \| undefined = ([^\n]+)/)?.[1] ?? ""
    check("the enter mark starts at that question, so it takes msg-in", /from: mountAt/.test(seeded), seeded)
    const mark = follow.enterMark({ id: "s", length: 0, from: 0 }, "s", 1)
    check("a mark seeded at the first message animates it", mark.from === 0 && follow.enterMark(undefined, "s", 1).from === Number.MAX_SAFE_INTEGER)
  }

  // ------------------------------------------------------------------ R20-C-5
  section("Round 20 (C-5): the goal-reached note does not move down to a later reply")
  {
    const template = stream.slice(stream.indexOf("<template>"))
    const note = template.match(/<span v-if="([^"]*)"[^>]*data-goal-achieved/)?.[1] ?? ""
    check("the note is not simply on the latest turn", !/lastTurnID/.test(note) && /goalTurnID/.test(note), note)
    const which = code(body(script, "const goalTurnID = computed("))
    check("it is the last turn only when that turn began before the goal was met", /goal\?\.done\?\.at/.test(which) && /began <= at/.test(which) && /turns\.value\.at\(-1\)/.test(which), which)
  }

  // ------------------------------------------------------------------ R20-C-6
  section("Round 20 (C-6): the question form's typed-answer row stays opaque when focused in dark")
  {
    const form = await read("src/renderer/src/components/parts/QuestionForm.vue")
    const style = form.slice(form.indexOf("<style"))
    const rules = [...style.matchAll(/([^{}]*\.q-custom:has\(textarea:focus\)[^{}]*)\{([^}]*)\}/g)].map((match) => ({ selector: match[1].trim(), rule: match[2].trim() }))
    const dark = rules.filter((entry) => /dark|light/.test(entry.selector))
    check("both dark rules (the theme attribute and the system scheme) are found", dark.length === 2, rules)
    check("neither lays a translucent tint over the options scrolling under the sticky row", dark.every((entry) => !/#[0-9a-f]{6}[0-9a-f]{2}\s*;/i.test(entry.rule) && /var\(--surface-menu\)/.test(entry.rule)), dark)
  }

  const store = await read("src/renderer/src/stores/app.ts")

  // ------------------------------------------------------------------ R20-C-2
  section("Round 20 (C-2): the home screen's goal switch leaves the last-opened conversation alone")
  {
    const set = code(body(store, "  async function setGoalMode("))
    const setEnd = set.indexOf("\n  }\n")
    const setBody = setEnd === -1 ? set : set.slice(0, setEnd)
    check("setGoalMode writes only to the conversation it is given", /if \(to\)/.test(setBody) && /sessionID: to\b/.test(setBody) && !/currentID/.test(setBody), setBody)
    const toggle = code(body(store, "  async function toggleGoalMode("))
    check("the home toggle hands it no conversation", /const target = home \? undefined : currentID\.value/.test(toggle) && /setGoalMode\(next, target\)/.test(toggle))
    const composer = await read("src/renderer/src/components/Composer.vue")
    check("the home composer's session is none", /const sessionID = computed\(\(\) => \(props\.fresh \? undefined/.test(composer) && /app\.setGoalMode\(!goalMode\.value, sessionID\.value\)/.test(composer))
  }

  // ------------------------------------------------------------------ R20-C-7
  section("Round 20 (C-7): stopping one conversation hushes only its own narration")
  {
    const abort = code(body(store, "  async function abort("))
    const abortBody = abort.slice(0, abort.indexOf("\n  }\n"))
    check("abort hushes the stopped conversation's line, not every line", /hushSpeechOf\(target\)/.test(abortBody) && !/hushSpeech\(\)/.test(abortBody), abortBody.slice(0, 300))
    const voice = code(await read("src/renderer/src/lib/voice.ts"))
    const of = body(voice, "export function hushSpeechOf(")
    check("the voice knows whose line it is reading", /speaking = sessionID/.test(body(voice, "export function speak(")) && /if \(speaking === sessionID\) hushSpeech\(\)/.test(of), of)
    check("and the spoken part names its conversation", /speak\(line, language\.value, source\.session\(\)\)/.test(await read("src/renderer/src/lib/speak-part.ts")))
  }
}
