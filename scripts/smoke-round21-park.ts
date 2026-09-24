/**
 * Round 21 (P1): a sent question stays where it was parked.
 *
 * Round 20 left the park as a single measurement: the view was put at the end
 * (or at the question's top) once, and whatever the layout did afterwards it
 * kept. It does plenty. The turn above loses its footer as the reply starts and
 * grows it back; the question's own turn is measured before the one above has
 * settled; the browser's scroll anchoring holds a node inside the turn being
 * written and moves the view by as much as it grows. In the lane's probe the
 * question came to rest 6px below its target and 14px further up as soon as
 * anything above it changed height, and a park whose own scroll event did not
 * happen to look like the content's growth started following again at once,
 * taking the question off the screen altogether.
 *
 * So the park is now held: where it rests is remembered and put back on every
 * layout change, until the reader moves the view - and the turn being written
 * is taken out of the browser's anchoring, as MiMo 26.920 does in the same rule
 * that keeps that row drawn (`#thread>.row:last-child{content-visibility:visible;overflow-anchor:none}`).
 *
 * The rules that can be are plain functions (lib/scroll-follow) and run here;
 * the wiring is read from the source. Where a question rests in a window, and
 * that it stays there when what is above it changes height, was measured in the
 * lane's Electron probe against a slow local stream, before and after.
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

export async function roundTwentyOneParkChecks(check: Check, section: (name: string) => void): Promise<void> {
  const stream = await read("src/renderer/src/components/MessageStream.vue")
  const script = stream.slice(0, stream.indexOf("<template>"))
  const style = stream.slice(stream.lastIndexOf("<style"))

  // ------------------------------------------------------------------ R21-P1-1
  section("Round 21 (P1-1): a scroll the view made itself is not the reader")
  {
    const readerMoved = (follow as Record<string, unknown>).readerMoved as ((echo: boolean, up: boolean, arrived: boolean) => boolean) | undefined
    check("scroll-follow says which scroll events let a parked question go", typeof readerMoved === "function")
    if (readerMoved) {
      check("the reader scrolling up, or down onto the end, lets it go", readerMoved(false, true, false) && readerMoved(false, false, true))
      check("this component's own scroll, echoed back, does not", !readerMoved(true, true, true))
      check("nor does an event that moved nothing", !readerMoved(false, false, false))
    }

    const scroll = body(script, "function onScroll(")
    check("the echo is read once and used throughout the handler", /const echo = pinEcho\(now\.top\)/.test(scroll) && !/pinEcho\(now\.top\)/.test(scroll.replace("const echo = pinEcho(now.top)", "")))
    check(
      "a park putting its question back is not the reader arriving at the end, which would follow again and take it away",
      /const arrived = movedDown\(seen, now\) && !echo/.test(scroll),
      scroll,
    )
    check("and the rest is let go by readerMoved, not by any scroll at all", /if \(readerMoved\(echo, up, arrived\)\) parkRest = undefined/.test(scroll))
    check("a zoom or a resize gives it up too: the park was measured at the old size", /seenWidth = width\s+upRun = 0\s+parkRest = undefined/.test(scroll))
  }

  // ------------------------------------------------------------------ R21-P1-2
  section("Round 21 (P1-2): every parked question is held at its target, not only a tall one")
  {
    const park = body(script, "function park(")
    check(
      "the park remembers where the question rests, whether it rests at the end or by its top",
      /if \(rest === undefined\) toBottom\(\)\s+else settle\(rest\)/.test(park) && /\n  parkRest = \{ row, target \}/.test(park),
      park.slice(-400),
    )
    const keep = body(script, "function keepRest(")
    check("the hold measures the row's own transform out of the way", /const lift = new DOMMatrixReadOnly\(getComputedStyle\(parkRest\.row\)\.transform\)\.m42/.test(keep))
    check("and puts the view back when the row has moved half a pixel", /if \(Math\.abs\(off\) >= 0\.5\) settle\(view\.scrollTop \+ off\)/.test(keep))
    check("it sits out following, a turn taken away, and a park's 200ms slide", /if \(!parkRest \|\| !view \|\| following\.value \|\| endSlide\) return/.test(keep) && /if \(!parkRest\.row\.isConnected\)/.test(keep))
    check("every layout change asks it: the column's own observer", /sizer = new ResizeObserver\(\(\) => \{[\s\S]*?keepRest\(\)/.test(script))
    check("and the slide, once its offset is gone", /endSlide = undefined\s+\/\/[^\n]*\n\s+keepRest\(\)/.test(body(script, "function slideIn(")))
    check("a conversation switch, or a width change, gives the rest up with the floor", /function clearFloor\(\)[\s\S]*?parkRest = undefined/.test(script))
  }

  // ------------------------------------------------------------------ R21-P1-3
  section("Round 21 (P1-3): the turn being written is not the browser's scroll anchor")
  {
    check(
      "MiMo's rule for the last row carries overflow-anchor: none, so a growing reply cannot move the view",
      /\.inner > \.turn\[data-turn-last\] \{\s+content-visibility: visible;\s+overflow-anchor: none;\s+\}/.test(style),
      style.slice(style.indexOf(".inner > .turn[data-turn-last]"), style.indexOf(".inner > .turn[data-turn-last]") + 160),
    )
    check("the scroller itself still follows MiMo's applyOverflowAnchor: off while following, on while reading", /element\.style\.overflowAnchor = on \? "none" : "auto"/.test(script))
  }
}
