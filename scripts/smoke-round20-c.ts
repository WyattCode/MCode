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
}
