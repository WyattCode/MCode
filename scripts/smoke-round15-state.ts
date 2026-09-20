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
}
