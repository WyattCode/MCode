/**
 * Round 25: the second code review's findings, one check per fix.
 *
 * Six read-only lanes went over the backend, the tools and the agent loop, the
 * renderer's state, the stylesheets, the main process and the check suite
 * itself. What they found fell into four shapes:
 *
 *  - "I could not read this" answered as "there is nothing here", now in the
 *    places round 23 did not reach: an undo that deleted the file it was meant
 *    to restore, scheduled tasks that vanished and were then written over.
 *  - A guard that reads the first word of a command, and a command whose first
 *    word is not its program: `bash -c "rm -rf src"`, `env rm`, `xargs rm`.
 *  - A theme rule and a state rule at *equal* specificity, where the theme rule
 *    wins on source order alone - the variant round 23's sweep could not see,
 *    because it was looking for one rule outranking another.
 *  - Checks that cannot fail, including three of round 24's own.
 *
 * Each check below fails on the code round 24 left behind. The runtime halves
 * are here rather than in a probe because none of them needs a window.
 *
 * smoke.ts calls `roundTwentyFiveChecks` with its own check and section.
 * `root` is the checkout to read, the working directory unless given.
 */
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { Check } from "./smoke-round5"
import { readBytesWaiting } from "../src/server/storage"
import { scanCommand } from "../src/server/tool/bash-scan"
import { commandRisk } from "../src/server/command-risk"
import { readCronFile } from "../src/server/cron/tasks"

/** Code without its comments, so a check reads what runs. */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/<!--[\s\S]*?-->/g, "").replace(/^\s*\/\/.*$/gm, "")
}

export async function roundTwentyFiveChecks(check: Check, section: (name: string) => void, root = process.cwd()): Promise<void> {
  const read = (relative: string) => fs.readFile(path.join(root, relative), "utf8")

  // --------------------------------------------------------------- R25-1
  section("Round 25 (1): a file that could not be read is never recorded as a file that was not there")
  {
    const folder = await fs.mkdtemp(path.join(os.tmpdir(), "mcode-r25-"))
    const absent = path.join(folder, "never-written.txt")
    check("a path that genuinely does not exist reads as undefined", (await readBytesWaiting(absent)) === undefined)
    const present = path.join(folder, "held.txt")
    await fs.writeFile(present, "kept")
    check("and a path that does reads as its bytes", (await readBytesWaiting(present))?.toString() === "kept")
    /*
     * The third answer throws rather than reading as either. A directory stands
     * in for the lock here: EISDIR is not ENOENT, which is the whole
     * distinction, and unlike a lock it behaves the same on every machine.
     */
    let threw: string | undefined
    await readBytesWaiting(folder).catch((cause: NodeJS.ErrnoException) => (threw = cause.code))
    check("anything else throws, so no caller can mistake it for an absence", threw !== undefined && threw !== "ENOENT", threw)

    const snapshot = code(await read("src/server/session/snapshot.ts"))
    check("the snapshot reader takes those three answers apart", /bytes = await readBytesWaiting\(target\)/.test(snapshot) && /return \{ path: target, unreadable:/.test(snapshot))
    check("and no longer answers every failure with null, which a restore turns into a deletion", !/fs\.readFile\(target\)\.catch\(\(\) => null\)/.test(snapshot))

    const runner = code(await read("src/server/session/runner.ts"))
    check("a turn holding one of those is filed as a turn that cannot be taken back", /file\.unreadable !== undefined\)\s*\n\s*if \(lost\) blocked = /.test(runner), runner.slice(runner.indexOf("const lost"), runner.indexOf("const lost") + 200))
    check("and a restore that meets one stops instead of writing", /if \(swap\.unreadable !== undefined\) throw new Error/.test(runner))
  }

  // --------------------------------------------------------------- R25-2
  section("Round 25 (2): the scheduled tasks are not written over because a file would not open")
  {
    const folder = await fs.mkdtemp(path.join(os.tmpdir(), "mcode-r25-cron-"))
    const project = path.join(folder, "project")
    await fs.mkdir(path.join(project, ".mcode"), { recursive: true })
    check("a project that has never scheduled anything reads as no tasks, and is not blocked", JSON.stringify(await readCronFile(project)) === JSON.stringify({ tasks: [] }))
    /*
     * A folder where the file should be: the read fails with EISDIR, which is
     * not "there is no such file". Before this, that answered `{tasks: []}`
     * with no `blocked`, and the next change wrote one task over all of them.
     */
    await fs.mkdir(path.join(project, ".mcode", "scheduled_tasks.json"))
    const blocked = await readCronFile(project)
    check("a file that will not open blocks the write rather than reading as empty", blocked.tasks.length === 0 && typeof blocked.blocked === "string" && /could not be read/.test(blocked.blocked), blocked)

    const scheduler = code(await read("src/server/cron/scheduler.ts"))
    check("a failed stat leaves the cached tasks alone instead of emptying them", /if \(unreadable\) return cached/.test(scheduler))
    check("and a blocked read does not replace the cache with nothing", /if \(read\.blocked\) return cached/.test(scheduler))

    const automation = code(await read("src/server/automation/service.ts"))
    check("the automations answer the same way", /unreadable = `The scheduled tasks in/.test(automation) && /this\.blocked = unreadable/.test(automation))

    const snapshot = code(await read("src/server/session/snapshot.ts"))
    check("the project's write ledger is not written over after a failed read either", /unreadableLedgers/.test(snapshot) && /if \(this\.unreadableLedgers\.delete\(this\.ledgerFile\(directory\)\)\) return/.test(snapshot))
    check("and the sweep keeps a store whose ledger it could not read, rather than deleting it", /spokenFor\.add\(digest\)\s*\n\s*continue/.test(snapshot))

    const store = code(await read("src/server/session/store.ts"))
    check("deleting a range of messages works from what is on disk, not from what could be read", /async messageIDs\(sessionID: string\): Promise<string\[\]>/.test(store))
    const runner = code(await read("src/server/session/runner.ts"))
    check("both callers use it", (runner.match(/this\.store\.messageIDs\(/g) ?? []).length === 2, runner.match(/this\.store\.messageIDs\(/g))
  }

  // --------------------------------------------------------------- R25-3
  section("Round 25 (3): a guard that reads the first word, and a command whose first word is not its program")
  {
    const here = process.cwd()
    const scan = (command: string) => scanCommand(command, here, here, false)

    const wrapped = await scan('bash -c "rm -rf src"')
    check("a delete inside an interpreter's own argument is found", wrapped.deletes.length > 0, wrapped.deletes)
    /*
     * And the "always" offered for it is the outer line exactly. Reading the
     * inner command must not hand out its prefix: one "always" for
     * `bash -c "npm test"` saving `npm *` would let a later bare `npm publish`
     * through unasked.
     */
    const inner = await scan('bash -c "npm test"')
    check("but what an always would keep is still only the line as it was written", inner.always.length === 1 && inner.always[0] === 'bash -c "npm test"', inner.always)

    for (const [command, why] of [
      ["env rm -rf src", "an environment wrapper"],
      ["ls | xargs rm -rf .", "xargs"],
      ["timeout 5 rm -rf src", "a timeout"],
    ] as const) {
      const found = await scan(command)
      check(`a delete behind ${why} is found`, found.deletes.length > 0, found.deletes)
      check(`and ${why} carries the risk that asks at the auto level`, commandRisk(command) === "delete", commandRisk(command))
    }
    check("the same for an interpreter, which the risk split now sees through quotes", commandRisk('bash -c "rm -rf src"') === "delete")
    check("an ordinary line is unchanged", commandRisk("npm run build") === undefined && commandRisk("git status") === undefined)

    /*
     * `cut` and `column` were on the read-only allowlist and not on the list of
     * commands whose arguments are files, so they were the one pair that read
     * a file with nothing asked and nothing checked - the saved sign-ins
     * included, where `cat` of the same path is refused.
     */
    const cut = await scan("cut -c1-9999 " + path.join(here, "secrets.json"))
    check("cut names the file it reads, so the app-data guard sees it", cut.files.some((file) => file.endsWith("secrets.json")), cut.files)
    const column = await scan("column -t " + path.join(here, "secrets.json"))
    check("and so does column", column.files.some((file) => file.endsWith("secrets.json")), column.files)

    // A flag's value is not a file, and a pattern is not a file.
    const counted = await scan("head -c 9999 notes.txt")
    check("a flag's count is not offered as a path to approve", !counted.files.some((file) => file.endsWith("9999")), counted.files)
    const pattern = await scan('grep "/etc/passwd" notes.txt')
    check("nor is what grep was told to look for", !pattern.dirs.some((dir) => /etc$/.test(dir)) && pattern.files.some((file) => file.endsWith("notes.txt")), { dirs: pattern.dirs, files: pattern.files })

    // An interpreter's "always" keeps what it was told to run, whatever the arity table says.
    const pytest = await scan("python -m pytest -q")
    check("one always for python -m pytest does not save every python -m", pytest.always.length === 1 && pytest.always[0] === "python -m pytest *", pytest.always)
    const deno = await scan("deno run build.ts")
    check("and deno run keeps its script", deno.always[0] === "deno run build.ts *", deno.always)
  }

  // --------------------------------------------------------------- R25-4
  section("Round 25 (4): the rest of the agent loop and the main process")
  {
    const runner = code(await read("src/server/session/runner.ts"))
    check("a step past the limit ends the turn, for a provider that ignores being told no tools", /if \(limit !== undefined && step > limit\) break/.test(runner))

    const reader = code(await read("src/server/tool/read.ts"))
    check("a directory listing no longer opts out of the shared output cap", !/truncated: more/.test(reader), reader.slice(reader.indexOf("<type>directory</type>"), reader.indexOf("<type>directory</type>") + 400))

    const actor = await read("src/server/tool/subagent.ts")
    check("the explore subagent is not described as needing no permission", !/it cannot change anything, it needs no permission/.test(actor) && /it is not a sandbox/.test(actor))

    const main = code(await read("src/main/index.ts"))
    check("a file handed to the desktop is checked for being a program first", /if \(await isProgram\(target, stat\)\) return EXECUTABLE_REFUSAL/.test(main))
    const paths = code(await read("src/main/paths.ts"))
    check("and the two channels that open a file share that one refusal", /export async function isProgram/.test(paths) && /export const EXECUTABLE_REFUSAL/.test(paths))
    check("a dialog claim is released even when the call throws on the way in", !/\)\.finally\(\(\) => releaseDialog\(claim\)\)/.test(paths) && !/\)\.finally\(\(\) => releaseDialog\(claim\)\)/.test(main))

    const guard = code(await read("src/main/office-guard.ts"))
    check("the four office channels that fell through to no check at all are judged with the rest", /case "mcode:file-size":/.test(guard) && /case "mcode:watch-file":/.test(guard) && /case "mcode:unwatch-file":/.test(guard) && /case "mcode:reveal-path":/.test(guard))

    const titlebar = code(await read("src/main/titlebar.ts"))
    check("the caption band follows the zoom downwards too, not only up", /Math\.max\(MIN_TITLEBAR_HEIGHT, Math\.round\(TITLEBAR_HEIGHT \* zoom\)\)/.test(titlebar))
    check("the save dialog's name keeps its hyphens and drops its control characters", /\[<>:"\|\?\*\\x00-\\x1f\]/.test(paths), paths.slice(paths.indexOf("path.basename(suggested)"), paths.indexOf("path.basename(suggested)") + 90))
  }

  // --------------------------------------------------------------- R25-5
  section("Round 25 (5): a theme rule and a state rule at equal specificity")
  {
    /*
     * Round 23 found nine rules where a theme override *outranked* a state
     * rule. This is the other half: the two are the same specificity, so the
     * theme rule wins because it comes later. A specificity check cannot see
     * it; what makes it safe is repeating the state inside both dark contexts.
     */
    for (const [file, selector, state] of [
      ["parts/MediaCoverflow.vue", ".media-coverflow-step", ":hover:not(:disabled)"],
      ["parts/SubagentActivity.vue", ".subagent-pill", ":not(:disabled):hover"],
      ["RightPanel.vue", ".rp-add", ":hover"],
    ] as const) {
      const style = await read(`src/renderer/src/components/${file}`)
      const attribute = style.includes(`:root[data-theme="dark"] ${selector}${state} {`)
      const media = style.includes(`:root:not([data-theme="light"]) ${selector}${state} {`)
      check(`${selector}${state} is repeated in both dark contexts, or the theme rule silently wins`, attribute && media, { attribute, media })
    }

    const browser = await read("src/renderer/src/components/right/RpBrowser.vue")
    check("the browser launcher's server name has a dark ink of its own", /:root\[data-theme="dark"\] \.rb-thumb-name \{/.test(browser) && /:root:not\(\[data-theme="light"\]\) \.rb-thumb-name \{/.test(browser))
    const models = await read("src/renderer/src/components/ModelsPage.vue")
    check("the chosen chip keeps its ink in dark as well as its rule", /:root\[data-theme="dark"\] \.tab\.on,\s*\n:root\[data-theme="dark"\] \.preset\.on \{\s*\n\s*color: var\(--text-strong\);/.test(models))

    const app = await read("src/renderer/src/App.vue")
    check("the find bar moves for a card that takes room, not for one that floats", /\.main\.info-open ~ \[data-find-bar\] \{\s*\n\s*margin-inline-end: v-bind\(infoInset\);/.test(app), app.slice(app.indexOf("[data-find-bar]") - 200, app.indexOf("[data-find-bar]") + 80))

    const settings = await read("src/renderer/src/components/SettingsDialog.vue")
    check("the usage table's columns widen with the interface text they hold", /\.day-name \{[^}]*width: calc\(64px \* var\(--ui-font-scale, 1\)\)/.test(settings) && /width: calc\(56px \* var\(--ui-font-scale, 1\)\)/.test(settings))
  }

  // --------------------------------------------------------------- R25-6
  section("Round 25 (6): the check suite reads nothing of the person's own")
  {
    const fenced = code(await read("scripts/fenced-home.ts"))
    check("home is moved for this process only, so the checks' child processes are unchanged", /os\.homedir = \(\) => fenced/.test(fenced) && !/process\.env\.USERPROFILE =/.test(fenced))
    check("it is this process's real answer now", path.resolve(os.homedir()) !== path.resolve(process.env.USERPROFILE ?? process.env.HOME ?? "/"), os.homedir())
    check("and nothing of the person's own is under it", (await fs.readdir(os.homedir())).length === 0, await fs.readdir(os.homedir()))

    for (const entry of ["smoke.ts", "session-check.ts", "prompt-check.ts", "tool-check.ts", "shell-check.ts"]) {
      const source = await read(`scripts/${entry}`)
      const first = source.match(/^import .*$/m)?.[0]
      check(`${entry} fences home before anything else it imports`, first === 'import "./fenced-home"', first)
    }

    const round5 = await read("scripts/smoke-round5.ts")
    check("no check asks a stranger's server for anything", /fetchInstruction: async \(url: string\) =>/.test(round5) && !/instructionFiles: \["docs\/\*\.md", "https:\/\/example\.com\/rules\.md"\] \}\)/.test(round5))

    const wiring = code(await read("scripts/wiring-check.ts"))
    check("the renderer's network APIs are scanned for, rather than the scan being skipped whenever a local source is allowed", !/if \(!\/\\bhttps\?:\/\.test\(connect\)\) \{/.test(wiring) && /which is the open web/.test(await read("scripts/wiring-check.ts")))

    const theme = code(await read("scripts/theme-check.ts"))
    check("the physical-direction rule covers the right-hand panel too", /\["parts", "right"\]/.test(theme))

    const i18n = code(await read("scripts/i18n-check.ts"))
    check("a tool whose name has an underscore is checked for wording like any other", /name: "\(\[a-z_\]\+\)"/.test(i18n))

    const windows = code(await read("scripts/smoke-round9-windows.ts"))
    check("the fresh-clone branch no longer holds a check that can only fail", !/Array\.isArray\(licences\)/.test(windows))
  }
}
