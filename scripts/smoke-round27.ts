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
import { execFileSync } from "node:child_process"
import fsSync from "node:fs"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { unifiedDiff } from "../src/server/diff"
import { parseUnifiedDiff, sectionPatch } from "../src/shared/unified-diff"
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

  // --------------------------------------------------------------- R27-3
  section("Round 27 (3): 撤销 puts the file back byte for byte, final newline and all")
  {
    /*
     * Found by watching a real model work. Asked to edit a three-line file, it
     * wrote the new text without a final newline; 撤销 brought the right words
     * back but left a fourth, empty line behind.
     *
     * Splitting on the newline leaves an empty last element for text that ends
     * with one, and that element was being treated as a line: the recorded
     * patch removed four lines and added three, so reversing it wrote the
     * phantom line into the file for real. Git carries the terminator as
     * `\ No newline at end of file` instead, and so does this now.
     *
     * Measured the way it actually happens rather than read: the patch a write
     * would record is handed to real `git apply --reverse`, and the bytes on
     * disk are compared with what they were.
     */
    const CASES: [string, string, string][] = [
      ["the model dropped the final newline", "alpha one\nalpha two\nalpha three\n", "alpha one (edited)\nalpha two (edited)\nalpha three (edited)"],
      ["the model added one", "one\ntwo", "one (e)\ntwo (e)\n"],
      ["only the terminator changed", "one\ntwo\n", "one\ntwo"],
      ["an ordinary edit, both sides keeping it", "one\ntwo\nthree\n", "one (e)\ntwo\nthree\n"],
      ["a file that really does end with a blank line", "one\ntwo\n\n", "one (e)\ntwo\n\n"],
      ["a line appended at the end", "one\ntwo\n", "one\ntwo\nthree\n"],
    ]
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "mcode-r27-eol-"))
    for (const [name, before, after] of CASES) {
      const directory = path.join(root, name.replace(/\W+/g, "-"))
      await fs.mkdir(directory)
      const git = (...args: string[]) => execFileSync("git", args, { cwd: directory, stdio: "pipe" })
      git("init", "-q")
      // Its own answer, so the machine's LF-to-CRLF policy is not what is being measured.
      git("config", "core.autocrlf", "false")
      const file = path.join(directory, "a.txt")
      await fs.writeFile(file, before)
      git("add", "-A")
      git("-c", "user.name=t", "-c", "user.email=t@e.invalid", "commit", "-q", "-m", "s")
      await fs.writeFile(file, after)
      const section = parseUnifiedDiff(unifiedDiff("a.txt", before, after))[0]
      const patch = path.join(directory, "p.patch")
      await fs.writeFile(patch, section ? sectionPatch(section) : "")
      let applied = true
      try {
        git("apply", "--reverse", patch)
      } catch {
        applied = false
      }
      check(`${name}: the patch reverses and the bytes are what they were`, applied && fsSync.readFileSync(file, "utf8") === before, JSON.stringify(fsSync.readFileSync(file, "utf8")))
    }
    await fs.rm(root, { recursive: true, force: true }).catch(() => {})

    /* And the shape itself, since the shape is what git reads. */
    const dropped = unifiedDiff("a.txt", "one\ntwo\n", "one\ntwo (e)")
    check("a side with no final newline is marked, git's way", /\n\\ No newline at end of file$/.test(dropped), JSON.stringify(dropped))
    check("and the counts no longer include the phantom line", /@@ -1,2 \+1,2 @@/.test(dropped), dropped.split("\n")[2])
    const plain = unifiedDiff("a.txt", "one\ntwo\n", "one (e)\ntwo\n")
    check("a file ending normally carries no marker and no blank tail", !plain.includes("No newline") && !/\n $/.test(plain), JSON.stringify(plain))
  }
}
