/**
 * Round 19, lane C: how the conversation scrolls while a reply streams, found
 * by comparing against MiMo 26.920's ThreadView and scrollStick.
 *
 * The rules are plain functions (lib/scroll-follow) and run here; the wiring
 * into MessageStream and the composer is read from the source. What they do in
 * a window - where a sent question parks, that the reply does not drag the view,
 * the jump button, a drag-select left alone - was measured in the lane's
 * Electron probe against a slow local stream.
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

export async function roundNineteenLaneCChecks(check: Check, section: (name: string) => void): Promise<void> {
  const stream = await read("src/renderer/src/components/MessageStream.vue")
  const script = stream.slice(0, stream.indexOf("<template>"))

  // ------------------------------------------------------------------ R19-CV-2
  section("Round 19 (CV-2): following stops on any upward scroll past 8px and resumes only at the end")
  {
    const at = (top: number, height = 2000, client = 600): follow.Geometry => ({ top, height, client })
    check("10px up from the very end stops following", follow.scrolledUp(at(1400), at(1390)))
    check("8px up does not, on its own", !follow.scrolledUp(at(1400), at(1392)))
    check("but small steps add up past 8px", follow.upwardRun(follow.upwardRun(0, at(1400), at(1395)), at(1395), at(1390)) === 10)
    check("and a step down starts the count again", follow.upwardRun(7, at(1390), at(1391)) === 0)
    check("a scrollTop drop because the content shrank is not the reader", !follow.scrolledUp(at(1400), at(1300, 1900)))
    check("re-attach within 2px at 1x and 2x, 3px at 0.75x", follow.reattachWithin(1) === 2 && follow.reattachWithin(2) === 2 && follow.reattachWithin(0.75) === 3)
    check("5px from the end does not re-attach", follow.nextFollowing(false, false, 5, 2, false) === false)
    check("2px from the end does", follow.nextFollowing(false, false, 2, 2, false) === true)
    check("an upward move wins even at the end", follow.nextFollowing(true, true, 0, 2, false) === false)
    check("a move that only matches the content's growth does not re-attach", follow.growthEcho(at(1400), at(1500, 2100)) && follow.nextFollowing(false, false, 0, 2, true) === false)
    check("the jump button still waits for 64px", !follow.jumpShown(at(1336)) && follow.jumpShown(at(1335)) && !follow.jumpShown(at(0, 400, 600)))
    const scroll = body(script, "function onScroll(")
    check("the scroll handler uses these rules, not a 64px stick", /nextFollowing\(/.test(scroll) && /scrolledUp\(/.test(scroll) && /reattachWithin\(/.test(scroll) && !/stickState|atEnd/.test(script), scroll.slice(0, 200))
    check("the old 64px stick is gone from turn-end", !/STICK|stickState/.test(await read("src/renderer/src/components/parts/turn-end.ts")))
    check("scroll anchoring is off while following and on otherwise", /element\.style\.overflowAnchor = on \? "none" : "auto"/.test(script))
  }

  // ------------------------------------------------------------------ R19-CV-3
  section("Round 19 (CV-3): holds while the reader is busy in the conversation, and MiMo's re-pins")
  {
    const idle = { selecting: false, sinceSelect: 1e9, sinceMedia: 1e9, editing: false, sinceEdit: 1e9, sinceWheelUp: 1e9 }
    check("nothing holds an idle conversation", follow.heldBy(idle) === undefined)
    check("a drag-select holds once past its first 600ms", follow.heldBy({ ...idle, selecting: true, sinceSelect: 601 }) === "select")
    check("but not within them", follow.heldBy({ ...idle, selecting: true, sinceSelect: 200 }) === undefined)
    check("a wheel turned up in the last 150ms holds", follow.heldBy({ ...idle, sinceWheelUp: 100 }) === "wheel" && follow.heldBy({ ...idle, sinceWheelUp: 150 }) === undefined)
    check("the edit box holds while open and for 300ms after", follow.heldBy({ ...idle, editing: true }) === "edit" && follow.heldBy({ ...idle, sinceEdit: 250 }) === "edit")
    check("a video starting or stopping holds for 600ms", follow.heldBy({ ...idle, sinceMedia: 500 }) === "media")
    const pin = body(script, "function pin(")
    check("every pin asks the holds first", /if \(!following\.value \|\| held\(\)\) return false/.test(pin), pin)
    check("no watcher or observer scrolls to the end around them", !/if \(following\.value\) toBottom\(\)/.test(script))
    check("the holds read the selection, the edit box, the wheel and media", /selecting: pressed \|\| holdsSelection/.test(script) && /editing: Boolean\(editingAsked\.value\)/.test(script) && /@wheel\.passive="onWheel"/.test(stream) && /@play\.capture="onMedia"/.test(stream))
    check("coming back to the window re-pins when following", /document\.addEventListener\("visibilitychange", onReturn\)/.test(script) && /window\.addEventListener\("focus", onReturn\)/.test(script) && /if \(!document\.hidden\) pin\(\)/.test(script))
    const card = script.slice(script.indexOf("watch(waitingCard"), script.indexOf("const waitingSteers"))
    check("a new permission or question forces following and pins", /following\.value = true/.test(card) && /pin\(\)/.test(card), card.slice(0, 160))
    const steer = script.slice(script.indexOf("watch([shownID, waitingSteers]"))
    check("so does a message sent into the running turn", /count <= wasCount\) return/.test(steer) && /following\.value = true/.test(steer.slice(0, 300)))
  }
}
