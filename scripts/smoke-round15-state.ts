/**
 * Round 15, lane R: the renderer's own state and libraries - the app store's
 * async refreshes, the notice stack, the closing dialog's copy, the find bar
 * and the colouring cache (R15-R1 onwards). Kept apart from smoke.ts the way
 * the earlier rounds are; smoke.ts calls `roundFifteenStateChecks` with its
 * own check and section.
 *
 * What runs without a window runs here for real: the notice stack and the
 * colouring cache are the shipped modules, driven the way the app drives them.
 * The three that need a document - the store's request race, the copy a
 * closing dialog leaves behind, the find bar across a switch - are read from
 * the source here and measured for real in the lane's Electron probes
 * (scratchpad r15r/find.cjs and r15r/ghost.cjs), which is said plainly on each
 * check below.
 */
import fs from "node:fs/promises"
import path from "node:path"
import type { Check } from "./smoke-round5"
import { DURATION, dismiss, notice, notify, toasts } from "../src/renderer/src/lib/toast"

const read = (relative: string) => fs.readFile(path.join(process.cwd(), relative), "utf8")

export async function roundFifteenStateChecks(check: Check, section: (name: string) => void): Promise<void> {
  section("Round 15 (R): renderer state and libraries")

  // ---------------------------------------------------------------- R15-R1
  {
    /*
     * Source check: the store cannot be built without a window and a socket,
     * so the race itself is run in the lane's Electron probe - six switches
     * with no gap, which before the guard handed the conversation on screen
     * the other one's 20 undo steps every time. What is read here is that the
     * answer is still checked against the conversation open when it lands.
     */
    const store = await read("src/renderer/src/stores/app.ts")
    const body = store.slice(store.indexOf("async function refreshHistory("))
    const end = body.indexOf("\n  }\n")
    const refresh = body.slice(0, end)
    check(
      "R15-R1: a session.history answer is dropped when the reader has moved on (source; the race is in the lane probe)",
      /currentID\.value !== sessionID/.test(refresh) && refresh.indexOf("currentID.value !== sessionID") < refresh.indexOf("history.value ="),
      refresh.slice(0, 400),
    )
    /* Every other awaited refresh in the store already checks; none may lose it. */
    const guarded = ["async function open(", "async function reread("].every((head) => {
      const at = store.indexOf(head)
      return at > 0 && /currentID\.value !== sessionID/.test(store.slice(at, at + 3000))
    })
    check("R15-R1: open() and reread() still check the same way", guarded)
  }

  // ---------------------------------------------------------------- R15-R2
  {
    /*
     * The shipped notice module, driven as the app drives it. A notice with no
     * duration stands until something takes it away - the reconnect banner is
     * raised once, cannot be closed by hand, and nothing re-raises it - so it
     * must not be pushed out by ordinary notices arriving behind it.
     */
    /* Every notice taken away with its clock, so one case does not colour the next. */
    const clearNotices = () => {
      for (const entry of [...toasts.value]) dismiss(entry.id)
    }
    const titles = () => toasts.value.map((entry) => entry.title)
    clearNotices()
    const RECONNECT = "app-reconnect"
    notice.danger("Reconnecting", { id: RECONNECT, body: "backend still down", duration: 0, closable: false })
    notify("Folder copied")
    notify("Conversation id copied")
    notify("Preference not saved")
    check("R15-R2: the standing reconnect banner survives three ordinary notices", toasts.value.some((entry) => entry.id === RECONNECT), titles())
    check("R15-R2: and the ordinary ones on screen are the newest two, so the stack is still three", toasts.value.length === 3, titles())
    check(
      "R15-R2: the oldest ordinary notice is the one that went, order kept",
      titles().join("|") === "Reconnecting · backend still down|Conversation id copied|Preference not saved",
      titles(),
    )

    /* With nothing standing, MiMo's limit of three is unchanged. */
    clearNotices()
    notify("one")
    notify("two")
    notify("three")
    notify("four")
    check("R15-R2: ordinary notices alone still cap at MiMo's three, oldest first out", titles().join("|") === "two|three|four", titles())

    /*
     * Four standing notices have nothing on a timer to give way, so the oldest
     * goes, which is what a damaged config, damaged credentials and two store
     * problems already did at boot.
     */
    clearNotices()
    notice.warning("config unreadable", { duration: 0 })
    notice.warning("credentials unreadable", { duration: 0 })
    notice.warning("storage problem A", { duration: 0 })
    notice.warning("storage problem B", { duration: 0 })
    check(
      "R15-R2: four standing notices still drop the oldest rather than pile up",
      titles().join("|") === "credentials unreadable|storage problem A|storage problem B",
      titles(),
    )

    /* And a timed one arriving behind two standing ones takes the timed slot. */
    clearNotices()
    notice.warning("expired sign-in", { duration: 0 })
    notice.warning("config unreadable", { duration: 0 })
    notify("Folder copied")
    notify("Conversation id copied")
    check(
      "R15-R2: a timed notice arriving behind two standing ones replaces the timed one, not a standing one",
      titles().join("|") === "expired sign-in|config unreadable|Conversation id copied",
      titles(),
    )
    clearNotices()
    check("R15-R2: the default five seconds is unchanged", DURATION === 5000, DURATION)
    check("R15-R2: and taking them away leaves nothing behind", toasts.value.length === 0, titles())
  }
}
