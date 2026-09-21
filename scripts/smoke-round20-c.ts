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
}
