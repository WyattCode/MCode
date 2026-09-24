/**
 * Round 27: what using the app with a real model turned up.
 *
 * The first round driven by an actual conversation rather than by reading. A
 * model was pointed at the app over the LAN and asked to do real work, and the
 * two things below came out of watching it.
 *
 * smoke.ts calls `roundTwentySevenChecks` with its own check and section.
 * `root` is the checkout to read, the working directory unless given.
 */
import fs from "node:fs/promises"
import path from "node:path"
import type { Check } from "./smoke-round5"

/** Code without its comments, so a check reads what runs. */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/<!--[\s\S]*?-->/g, "").replace(/^\s*\/\/.*$/gm, "")
}

export async function roundTwentySevenChecks(check: Check, section: (name: string) => void, root = process.cwd()): Promise<void> {
  const read = (relative: string) => fs.readFile(path.join(root, relative), "utf8")

  // --------------------------------------------------------------- R27-1
  section("Round 27 (1): the notices follow the card arriving, not only the pane resizing")
  {
    /*
     * The order the user hit: a conversation opened at start-up raises its
     * notice, and the info card renders a moment later. The card is drawn over
     * the work area's end rather than beside it, so `main` does not resize -
     * the size observer never fires, and the notice stayed where it had been
     * placed, half the card's width right of what could be seen. Measured with
     * the card arriving after the notice: 855 where 700 was right, and 700 once
     * the observer below was added.
     */
    const column = code(await read("src/renderer/src/components/Toasts.vue"))
    check("the column watches what is added to and removed from the pane", /arriving = new MutationObserver\(measure\)/.test(column) && /arriving\.observe\(main, \{ childList: true \}\)/.test(column))
    check("a child list, not a subtree: the card is the pane's own child and a subtree would fire on every streamed word", !/subtree: true/.test(column), column.slice(column.indexOf("arriving.observe"), column.indexOf("arriving.observe") + 80))
    check("and it is disconnected with the rest", /arriving\?\.disconnect\(\)/.test(column))
    // The size observer stays: the side column and the panels still move the pane without touching the card.
    check("the size observer it stands beside is still there", /watching = new ResizeObserver\(measure\)/.test(column) && /watching\.observe\(main\)/.test(column))
  }

  // --------------------------------------------------------------- R27-2
  section("Round 27 (2): the delete question, as a real conversation reaches it")
  {
    /*
     * Watched end to end with a model actually working: it inspected the
     * folder, read a file, made a backup, and only then asked to delete. The
     * first three raised the ordinary card - four buttons, "always" among them
     * - and the delete raised a different one: titled as a delete, carrying the
     * "this cannot be undone, every one is asked separately" line, with no
     * "always" button at all. What follows pins the difference that makes it,
     * since the difference is the whole guarantee.
     */
    const dialog = await read("src/renderer/src/components/PermissionDialog.vue")
    check("a forced request says why it is being asked every time", /v-if="request\.forced" class="forced" data-perm-forced/.test(dialog))
    check("and offers no way to remember the answer", /v-if="!request\.forced"[\s\S]{0,400}?data-perm-always/.test(dialog) || /data-perm-always[\s\S]{0,200}?v-if="!request\.forced"/.test(dialog), dialog.slice(dialog.indexOf("data-perm-always") - 300, dialog.indexOf("data-perm-always") + 60))
    const permission = code(await read("src/server/permission.ts"))
    check("a forced request is never answered by a stored rule", /if \(action === "allow" && !forced\) return/.test(permission))
    check("nor by the level, nor by full access", /!forced/.test(permission) && /readOnlyCommand/.test(permission))
  }
}
