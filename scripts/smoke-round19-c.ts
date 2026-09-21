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
    check("5px from the end does not re-attach", follow.nextFollowing(false, false, 5, 2, true) === false)
    check("2px from the end does, reached by moving down", follow.nextFollowing(false, false, 2, 2, true) === true)
    check("an upward move wins even at the end", follow.nextFollowing(true, true, 0, 2, true) === false)
    check("a move that only matches the content's growth is not the reader arriving", follow.growthEcho(at(1400), at(1500, 2100)) && !follow.movedDown(at(1400), at(1500, 2100)))
    check("nor is the browser pulling the view back as a floor shrinks, or an event with nothing moved", !follow.movedDown(at(418, 1239), at(404.6, 1226)) && !follow.movedDown(at(418), at(418)))
    check("landing on the end that way leaves following off", follow.nextFollowing(false, false, 0, 2, false) === false)
    check("the jump button still waits for 64px", !follow.jumpShown(at(1336)) && follow.jumpShown(at(1335)) && !follow.jumpShown(at(0, 400, 600)))
    const scroll = body(script, "function onScroll(")
    check("the scroll handler uses these rules, not a 64px stick", /nextFollowing\(/.test(scroll) && /scrolledUp\(/.test(scroll) && /reattachWithin\(/.test(scroll) && !/stickState|atEnd/.test(script), scroll.slice(0, 200))
    check("the old 64px stick is gone from turn-end", !/STICK|stickState/.test(await read("src/renderer/src/components/parts/turn-end.ts")))
    check("scroll anchoring is off while following and on otherwise", /element\.style\.overflowAnchor = on \? "none" : "auto"/.test(script))
    const jumpRule = stream.slice(stream.indexOf("\n.jump {"), stream.indexOf("}", stream.indexOf("\n.jump {")))
    check("the jump button takes no room, so its coming and going does not move the end", /height: 34px;/.test(jumpRule) && /margin-top: -34px;/.test(jumpRule))
  }

  // ------------------------------------------------------------------ R19-CV-1
  section("Round 19 (CV-1): a sent question parks near the top and the reply streams below it")
  {
    check("a short question rests a sixth of the way down", follow.parkTarget(900, 40) === 150)
    check("a tall one rests higher, so the reply still starts in view, but never above 12px", follow.parkTarget(600, 380) === 20 && follow.parkTarget(600, 500) === 12)
    check("the room the column lacks is made up exactly", follow.parkRoom(1500, 150, 900, 1800) === 450 && follow.parkRoom(500, 150, 900, 1800) === 0)
    check("room is rounded up, never down", follow.parkRoom(1500.2, 150, 900, 1800) === 451)
    follow.requestPark("ses_a", 1000)
    check("a park asked for is used once", follow.consumePark("ses_a", 2000) && !follow.consumePark("ses_a", 2100))
    follow.requestPark("ses_a", 1000)
    check("one not used within 3s lapses", !follow.consumePark("ses_a", 4001))
    follow.requestPark("ses_a", 1000)
    follow.clearPark("ses_a")
    check("a refused send takes its park back", !follow.consumePark("ses_a", 1001))
    check("another conversation's park is not this one's", (follow.requestPark("ses_b", 1000), !follow.consumePark("ses_a", 1001)) && follow.consumePark("ses_b", 1001))

    const composer = await read("src/renderer/src/components/Composer.vue")
    check(
      "the composer asks for a park just before sending, only for a turn it starts in the main thread",
      /const parkIn = !props\.side && filled && !subtask && app\.currentID && !app\.busy \? app\.currentID : undefined\s+if \(parkIn\) requestPark\(parkIn\)\s+\/\/[^\n]*\n\s+const accepted =/.test(composer),
    )
    check("and takes it back when the send is refused", /if \(!accepted && parkIn\) clearPark\(parkIn\)/.test(composer))
    check(
      "the scroll handler re-attaches only when the reader moved down onto the end",
      /const arrived = movedDown\(seen, now\)/.test(script) && /nextFollowing\(following\.value, up, distance, reattachWithin\(ratio\), arrived\)/.test(script),
    )
    check("the jump button waits out the slide, whose offset is not distance to the end", /if \(!element \|\| endSlide\) return/.test(body(script, "function measureJump(")))
    const park = body(script, "function park(")
    check(
      "the park measures the new question's row against the view, to the column's end",
      /parkTarget\(view\.clientHeight, box\.height\)/.test(park) && /const end = column\.getBoundingClientRect\(\)\.bottom - viewTop/.test(park) && /parkRoom\(box\.top - viewTop, [^\n]*, view\.clientHeight, end\)/.test(park),
      park.slice(0, 200),
    )
    check("puts the missing room on the question's own turn as a min-height floor", /turn\.style\.minHeight = `\$\{Math\.ceil\(turn\.getBoundingClientRect\(\)\.height \+ room\)\}px`\s+floored = turn/.test(park))
    const handOver = script.slice(script.indexOf("watch(\n  lastTurnID,"), script.indexOf("function slideIn("))
    check(
      "a turn that stops being the last hands its floor to the column, ending where it ended",
      /holder\.hasAttribute\("data-turn-last"\)\) return/.test(handOver) && /holder\.style\.minHeight = ""\s+column\.style\.minHeight = `\$\{Math\.ceil\(end\)\}px`\s+floored = column/.test(handOver),
    )
    check("pins to the end and then stops following", /following\.value = true\s+pin\(\)\s+following\.value = false/.test(park))
    check("and slides the column up over 200ms, not under reduced motion", /if \(room > 0 && !reducedMotion\(\)\) slideIn\(column, room\)/.test(park) && /transform 0\.2s cubic-bezier\(0\.2, 0\.7, 0\.2, 1\)/.test(body(script, "function slideIn(")))
    check("a park is used when the new question appears, in the main thread only", /if \(!id \|\| id === was \|\| !here \|\| props\.side \|\| props\.latest \|\| props\.subagent\) return\s+if \(consumePark\(here\)\) park\(id\)/.test(script))
    check("the floor goes with a conversation switch and a width change", /clearFloor\(\)\s+parkedIn = undefined/.test(script) && /clientWidth !== floorWidth\) clearFloor\(\)/.test(script))
    check("and once the reader has left it behind: scrolling up, or the turn ending", /if \(up \|\| distance > JUMP_DISTANCE\) releaseFloor\(\)/.test(script) && /if \(busy\) return\s+await nextTick\(\)\s+releaseFloor\(\)/.test(script))
    check("a release never moves the view", /if \(view\.scrollTop < top\) \{\s+holder\.style\.minHeight = floor/.test(body(script, "function releaseFloor(")))
    check("a waiting card does not pull a parked question away", /if \(!card \|\| card === was \|\| parked\(\)\) return/.test(script))
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
