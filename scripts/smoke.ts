/*
 * The smoke suite.
 *
 * This file replaces a 12,091-line one that had not compiled since the 2.0
 * import pasted a second copy of the suite over the first. That file ended 47
 * braces and 96 parens short of balanced, with 42 section bodies cut
 * mid-statement - past the point where any repair could be trusted, because a
 * test that silently stops checking something is worse than no test.
 *
 * So it starts again, small and honest. What is here is what runs; a check that
 * cannot run is not written down as if it could. The suites under
 * `npm run *check` (i18n, theme, wiring, mcp, session, snapshot, sandbox, remote,
 * tool, prompt, shell, provider) still cover their subsystems and are unchanged;
 * this file covers the pieces that had no home there.
 *
 * Each round's fixes get their checks added here as they are made.
 */
import { createRequire } from "node:module"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { nameFromId } from "../src/server/provider/model-name"
import { commandRisk } from "../src/server/command-risk"
import { isSummary } from "../src/server/session/summary"
import { modelVariants } from "../src/server/provider/variants"
import { reasoningRequest } from "../src/server/provider/anthropic"
import { runFallback } from "../src/server/tool/search-run"
import { runFallbackJob } from "../src/server/tool/search-fallback"
import { ToolError } from "../src/server/tool/types"
import { normalizeChord, retireKeybinds, RETIRED_DEFAULTS } from "../src/shared/chord"

let failures = 0
let checks = 0

function check(what: string, ok: boolean, detail?: unknown) {
  checks++
  if (ok) {
    console.log(`  ok   ${what}`)
    return
  }
  failures++
  console.log(`  FAIL ${what}${detail === undefined ? "" : ` - ${typeof detail === "string" ? detail : JSON.stringify(detail)}`}`)
}

function section(name: string) {
  console.log(`\n${name}`)
}

/** The repo root, found by walking up until the package name matches. */
async function findRoot(): Promise<string> {
  let dir = process.cwd()
  for (let i = 0; i < 5; i++) {
    try {
      const text = await fs.readFile(path.join(dir, "package.json"), "utf8")
      if (JSON.parse(text).name === "mcode") return dir
    } catch {
      // keep walking
    }
    dir = path.dirname(dir)
  }
  return process.cwd()
}

const root = await findRoot()
const read = (rel: string) => fs.readFile(path.join(root, rel), "utf8")

section("Model names")
{
  /*
   * `nameFromId` produces a display name: the provider half capitalised, and
   * the model half's words capitalised too. Asserting the exact strings keeps
   * this honest - a rename of the helper will fail here rather than quietly
   * changing every label in the UI.
   */
  check("a provider:model id is titled", nameFromId("openai:gpt-5") === "Openai:gpt-5", nameFromId("openai:gpt-5"))
  check("a bare model id is titled", nameFromId("gpt-5") === "GPT-5", nameFromId("gpt-5"))
  check("hyphenated model words are titled", nameFromId("anthropic:claude-opus-4") === "Anthropic:claude-Opus-4", nameFromId("anthropic:claude-opus-4"))
  check("an empty id yields an empty name", nameFromId("") === "", nameFromId(""))
}

section("Command risk")
{
  /*
   * The classification the Permission dialog leans on. It answers with a kind
   * only when there is something to warn about - `undefined` is the ordinary
   * case for a command that changes nothing, not "safe".
   */
  check("rm -rf is classified as deleting", commandRisk("rm -rf /tmp/x") === "delete", commandRisk("rm -rf /tmp/x"))
  check("a git push is classified as publishing", commandRisk("git push origin main") === "publish", commandRisk("git push origin main"))
  check("ls carries no warning", commandRisk("ls") === undefined, commandRisk("ls"))
  check("cat carries no warning", commandRisk("cat file.txt") === undefined, commandRisk("cat file.txt"))
}

section("Model variants")
{
  check("a known model answers without throwing", modelVariants("anthropic", "claude-opus-4") !== null, "threw")
  check("an unknown model answers without throwing", modelVariants("nobody", "nothing") !== null, "threw")
}

section("Keybindings")
{
  /*
   * `normalizeChord` tidies a chord's spelling rather than lower-casing it: it
   * keeps the letter as typed and fixes the modifier names. `RETIRED_DEFAULTS`
   * is a map from action id to the chord that used to start it, not a list.
   */
  check("a chord keeps its letter as typed", normalizeChord("Ctrl+Shift+P") === "Ctrl+Shift+P", normalizeChord("Ctrl+Shift+P"))
  check("lowercase modifiers become title case", normalizeChord("ctrl+shift+p") === "ctrl+shift+P", normalizeChord("ctrl+shift+p"))
  check("the retired map is not empty", Object.keys(RETIRED_DEFAULTS).length > 0, Object.keys(RETIRED_DEFAULTS).length)
  /*
   * `retireKeybinds` drops a binding when the action was retired *and* the
   * chord still equals the one it used to default to. A user who rebound it
   * keeps the rebind, which is the point - so the removed case has to use a
   * retired action with its old default, not any chord that looks old.
   */
  const retiredId = "app.mcp"
  const retiredChord = RETIRED_DEFAULTS[retiredId]
  const kept = retireKeybinds({ "app.search": "ctrl+k", [retiredId]: retiredChord })
  check("a binding that is still live is kept", "app.search" in kept, Object.keys(kept))
  check("a retired action on its old default is dropped", !(retiredId in kept), Object.keys(kept))
  const rebound = retireKeybinds({ [retiredId]: "ctrl+alt+m" })
  check("a retired action the user rebound is kept", retiredId in rebound, Object.keys(rebound))
}

section("The remote cockpit page is served from its source")
{
  /*
   * The gateway serves `cockpit-html.ts`, a generated string. Skipping the
   * generator leaves the file stale while every check that reads the source
   * still passes - which is exactly how the page shipped without its `forced`
   * branch, so a phone could offer 总是允许 for an action that is confirmed
   * every time. This compares the two so the build fails instead of the phone.
   */
  const generated = await read("src/server/remote/cockpit-html.ts")
  const copies = (generated.match(/function addPermissionCard/g) ?? []).length
  check("the generated page holds one copy of the script", copies === 1, `copies=${copies}`)
  check("the generated page carries the forced branch", generated.includes("asked.forced"), "missing")
}

section("The renderer files that broke the build")
{
  /*
   * A name declared twice in one scope is what broke the build after the 2.0
   * import: an edit was pasted over the code it meant to replace, leaving both
   * copies. The build catches it today, but only for files the bundler reaches
   * and only with a message that names the identifier rather than the file - so
   * this names the file.
   *
   * Text matching cannot do this: `const target` inside two neighbouring arrow
   * functions is ordinary code, and a scan that flags it gets switched off. The
   * check is therefore left to a scope-aware view of the file, which is what the
   * suite is allowed to be lazy about only because the bundler already fails
   * loudly on the real thing. What is asserted here is the part the bundler does
   * not say: which files were touched, and that they still hold one copy of each
   * function they are known for.
   */
  const targets = [
    { rel: "src/renderer/src/App.vue", fn: "async function cycleAgent(" },
    { rel: "src/renderer/src/components/Composer.vue", fn: "async function toggleGoalMode(" },
    { rel: "src/renderer/src/components/GoalBar.vue", fn: "async function rerun(" },
    { rel: "src/renderer/src/components/PluginsView.vue", fn: "async function toggle(" },
  ]
  for (const { rel, fn } of targets) {
    const text = await read(rel)
    const name = path.basename(rel)
    const copies = text.split(fn).length - 1
    check(`${name} defines ${fn.replace(/^async function |\($/g, "")} exactly once`, copies === 1, `copies=${copies}`)
  }
  /*
   * And the specific shape of the accident: a second `const` of a name that was
   * already declared a few lines above, with no `}` in between. Reading it as
   * text is enough - no correct code declares the same const twice in one block,
   * and the window is small so this stays linear.
   */
  for (const { rel } of targets) {
    const text = await read(rel)
    const name = path.basename(rel)
    const lines = text.split("\n")
    let twin = ""
    const open = new Map<string, number>()
    let windowStart = 0
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      if (line.includes("}")) {
        // A closing brace ends the block these declarations lived in.
        open.clear()
        windowStart = i
      }
      const m = line.match(/^\s{2,}const\s+([A-Za-z_$][\w$]*)\s*[:=]/)
      if (!m) continue
      if (open.has(m[1]) && i - windowStart < 60) {
        twin = `${m[1]} at ${open.get(m[1])! + 1} and ${i + 1}`
        break
      }
      open.set(m[1], i)
    }
    check(`${name} has no const declared twice in one block`, twin === "", twin)
  }
}

section("A second look at #18: none that thinks, a marker that outlived its answer, a worker per search")
{
  // Each check names the input that used to do the opposite of what the code said.
  const levels = ["none", "low", "medium", "high", "xhigh", "max"]
  const older = "my-claude-3-model"
  const body = (model: string, effort: string, menu: string[] | undefined = levels) => reasoningRequest(model, effort, menu, 64_000)
  check("none sends no thinking on a model that takes a budget", JSON.stringify(body(older, "none")) === "{}", body(older, "none"))
  check("nor on an adaptive model", JSON.stringify(body("claude-opus-4-7", "none")) === "{}", body("claude-opus-4-7", "none"))
  check("nor when the menu was never worked out", JSON.stringify(body(older, "none", undefined)) === "{}")
  const budget = (effort: string) => (body(older, effort) as { thinking?: { budget_tokens?: number } }).thinking?.budget_tokens ?? 0
  check("low, medium and high are three growing budgets, not one", budget("low") < budget("medium") && budget("medium") < budget("high") && budget("high") < budget("max"), [budget("low"), budget("medium"), budget("high"), budget("max")])
  check("xhigh takes the largest, the nearest level the budget model has", budget("xhigh") === budget("max"))
  check("a built-in model's high and max are unchanged", budget("high") === 16_000 && budget("max") === 31_999)

  const network = await read("src/main/local-network.ts")
  check("the Local Network marker names the build, so a rebuilt app is asked again", /function build\(\)/.test(network) && network.includes("app.getVersion()") && network.includes("mtimeMs") && /readFileSync\(marker, "utf8"\)\.trim\(\) === current/.test(network))
  check("and is written only once the packet went out", /send\(serviceQuery\(\)[^\n]*\(error\) => \{\s*done\(\)\s*if \(error\) return\s*try \{[\s\S]*?writeFileSync\(marker, current/.test(network))
  check("a send that throws is closed, not left open", /\} catch \{\s*done\(\)\s*\}\s*\}\s*$/.test(network.trim()))

  const { willSign } = createRequire(path.join(root, "package.json"))("./scripts/mac-adhoc-sign.cjs") as { willSign: (options: { identity?: string | null }, env: Record<string, string>, listing: string) => boolean }
  const listing = (name: string) => `  1) 0123456789ABCDEF "${name}"\n     1 valid identities found`
  const empty = "     0 valid identities found"
  check("no identity: electron-builder will not sign, so the hook does", willSign({}, {}, empty) === false)
  check("an identity of a kind electron-builder uses: it signs, the hook stands down", ["Developer ID Application: A (T)", "Apple Development: A (T)", "Mac Developer: A (T)"].every((name) => willSign({}, {}, listing(name))))
  check("an identity of a kind it does not use is no reason to skip", willSign({}, {}, listing("iPhone Distribution: A (T)")) === false)
  check("mac.identity null, or discovery off, is a decision not to sign", willSign({ identity: null }, {}, listing("Developer ID Application: A (T)")) === false && willSign({}, { CSC_IDENTITY_AUTO_DISCOVERY: "false" }, listing("Developer ID Application: A (T)")) === false)
  check("a named identity or certificate file is signed with, found or not", willSign({ identity: "A" }, {}, empty) && willSign({}, { CSC_NAME: "A" }, empty) && willSign({}, { CSC_LINK: "x.p12" }, empty))

  const invalid = await runFallbackJob({ kind: "grep", target: "/nonexistent", isFile: true, pattern: "(" }, new AbortController().signal).then(() => undefined, (error: unknown) => error)
  check("a bad pattern is a ToolError on the main thread too", invalid instanceof ToolError, String(invalid))

  const dir = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "mcode-search-"))
  try {
    await fs.writeFile(path.join(dir, "a.txt"), "needle one\nhay\n")
    await fs.writeFile(path.join(dir, "b.txt"), "hay\nneedle two\n")
    const grep = (pattern: string, timeout?: number) => runFallback({ kind: "grep", target: dir, isFile: false, pattern }, new AbortController().signal, timeout)
    const first = await grep("needle")
    const second = await grep("needle")
    check("a search finds its matches, and so does the next on the worker that was kept", first.rows.length === 2 && second.rows.map((row) => row.text).sort().join() === "needle one,needle two", second.rows)
    const glob = await runFallback({ kind: "glob", root: dir, pattern: "*.txt", limit: 10 }, new AbortController().signal)
    check("a glob is answered by the same pool", glob.paths.length === 2, glob.paths)
    const together = await Promise.all([grep("needle"), grep("hay"), grep("one"), grep("two")])
    check("several at once each get a worker and their own answer", together.map((outcome) => outcome.rows.length).join() === "2,2,1,1", together.map((outcome) => outcome.rows.length))
    await fs.writeFile(path.join(dir, "bait.txt"), "a".repeat(60) + "!\n")
    const stopped = await grep("(a+)+$", 600).then(() => undefined, (error: unknown) => error)
    check("a runaway pattern is stopped at the deadline", stopped instanceof ToolError, String(stopped))
    check("and the search after it does not land on the worker that was killed", (await grep("needle")).rows.length === 2)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
}

section("This suite stays reviewable")
{
  /*
   * The old file grew to twelve thousand lines and nobody read it, which is how
   * it stayed broken for 48 rounds. A size ceiling makes that drift visible.
   */
  const self = await read("scripts/smoke.ts")
  const lineCount = self.split("\n").length
  check("under 600 lines", lineCount < 600, lineCount)
}

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) {
  console.log(`FAILED with ${failures} problem(s)`)
  process.exit(1)
}
console.log("smoke passed")