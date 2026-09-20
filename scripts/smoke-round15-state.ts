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
import { cachedHighlight, highlight } from "../src/renderer/src/lib/highlight"

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

  // ---------------------------------------------------------------- R15-R3
  {
    /*
     * Source check: cloneNode and element animations need a document, so the
     * Tab is pressed for real in the lane's ghost probe - 60ms after Escape,
     * which before this landed on a button inside the aria-hidden copy and
     * then on <body> when the copy was removed. What is read here is that the
     * copy is marked inert when it is made.
     */
    const modal = await read("src/renderer/src/lib/modal.ts")
    const exit = modal.slice(modal.indexOf("export function playDialogExit("))
    const made = exit.indexOf("insertBefore(ghost")
    check(
      "R15-R3: the copy a closing dialog leaves is inert before it goes into the page (source; the Tab is in the lane probe)",
      /ghost\.setAttribute\("inert", ""\)/.test(exit.slice(0, made)),
      exit.slice(0, 600),
    )
    check("R15-R3: and it is still hidden from screen readers and tagged as a copy", /aria-hidden/.test(exit.slice(0, made)) && /data-modal-exit/.test(exit.slice(0, made)))
    /* The two places that already skipped the copy still do, and the drop ring now joins them. */
    const shell = await read("src/renderer/src/App.vue")
    const drag = shell.slice(shell.indexOf("function trackDrag("), shell.indexOf("function leaveDrag("))
    check("R15-R3: a file dragged over the thread is not held back by that copy either", /data-modal-exit/.test(drag), drag.slice(-400))
  }

  // ---------------------------------------------------------------- R15-R4
  {
    /*
     * Source check: the bar scans real Ranges in a real document, so it is
     * driven for real in the lane's find probe - typing on one conversation
     * and switching to another, which before this left "1/3" and highlights on
     * ranges that had left the page. What is read here is that the switch asks
     * for a fresh scan.
     */
    const shell = await read("src/renderer/src/App.vue")
    const at = shell.indexOf("const find = createFind(")
    const after = shell.slice(at, at + 1200)
    check(
      "R15-R4: the find bar is scanned again when the conversation or the view changes (source; the switch is in the lane probe)",
      /watch\(\[[^\]]*app\.currentID[^\]]*\]/.test(after) && /find\.refresh\(\{ reset: true \}\)/.test(after),
      after.slice(0, 600),
    )
    check("R15-R4: and a bar that is not open is left alone", /if \(!find\.open\.value\) return/.test(after))
  }

  // ---------------------------------------------------------------- R15-R5
  {
    /*
     * The colouring cache for real: four hundred blocks fill it, then the
     * oldest is asked for again and one more block arrives. A cache that drops
     * by last use keeps the one just asked for; one that drops by age of first
     * sight loses it and colours it from scratch next time.
     */
    const of = (i: number) => `const a${i} = ${i}\n`
    for (let i = 0; i < 400; i++) await highlight(of(i), "ts")
    await highlight(of(0), "ts")
    await highlight("const fresh = 1\n", "ts")
    check("R15-R5: a coloured block asked for again is not the next one dropped", cachedHighlight(of(0), "ts") !== undefined)
    check("R15-R5: the one that went is the least recently asked for", cachedHighlight(of(1), "ts") === undefined)
    check("R15-R5: and the newest is in", cachedHighlight("const fresh = 1\n", "ts") !== undefined)
  }
}
