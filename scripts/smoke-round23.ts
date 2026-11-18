/**
 * Round 23: the second code review's findings, one check per fix.
 *
 * Five read-only lanes went over the backend, the renderer, the coding-agent
 * loop, the stylesheets and the check suite itself. What they found was mostly
 * one shape: code that answers "I could not read this" the same way it answers
 * "this is damaged", and rules or conditions that cannot do what their own
 * words say. Each check below fails on the code as round 22 left it.
 *
 * The runtime halves are here rather than in a probe because none of them needs
 * a window: a storage folder in a temp directory, and the real modules.
 *
 * smoke.ts calls `roundTwentyThreeChecks` with its own check and section.
 * `root` is the checkout to read, the working directory unless given.
 */
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { Check } from "./smoke-round5"
import { Storage } from "../src/server/storage"
import { LoopMonitor } from "../src/server/session/loop-health"
import { inputForTool } from "../src/server/provider/tool-schema"
import { ActorTool } from "../src/server/tool/subagent"
import { argumentProblems } from "../src/server/tool/validate"
import type { ToolPart } from "@shared/protocol"

/** Code without its comments, so a check reads what runs. */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/<!--[\s\S]*?-->/g, "").replace(/^\s*\/\/.*$/gm, "")
}

/** A finished search call, as the runner hands one to the loop monitor. */
function searchPart(name: string, output: string, metadata: Record<string, unknown>): ToolPart {
  return { type: "tool", id: `p${Math.random()}`, callID: `c${Math.random()}`, name, status: "completed", input: {}, output, metadata, time: { created: 1, completed: 2 } } as unknown as ToolPart
}

export async function roundTwentyThreeChecks(check: Check, section: (name: string) => void, root = process.cwd()): Promise<void> {
  const read = (relative: string) => fs.readFile(path.join(root, relative), "utf8")

  // --------------------------------------------------------------- R23-1
  section("Round 23 (1): a document that could not be read is never answered as a damaged one")
  {
    const folder = await fs.mkdtemp(path.join(os.tmpdir(), "mcode-r23-"))
    const storage = new Storage(folder)
    await storage.write("kept", { rules: ["one", "two"] })

    const fine = await storage.readOrCorrupt<{ rules: string[] }>("kept")
    check("a document that reads is a value, with neither other answer", fine.value?.rules.length === 2 && fine.corrupt === undefined && fine.unreadable === undefined, fine)

    const missing = await storage.readOrCorrupt("never-written")
    check("one that is not there is no answer at all - a first run, not damage", missing.value === undefined && missing.corrupt === undefined && missing.unreadable === undefined, missing)

    await fs.writeFile(path.join(folder, "broken.json"), "{ not json", "utf8")
    const broken = await storage.readOrCorrupt("broken")
    check("one that will not parse is `corrupt`, which is what may be moved aside", broken.corrupt !== undefined && broken.unreadable === undefined, broken)

    /*
     * The disk refusing is the third answer, and folding it into the second was
     * a way to lose everything: a scanner holding config.json for 100ms made
     * the settings read as damaged, the quarantine failed for the same lock,
     * and the next save wrote defaults over every setting on the machine.
     */
    const locked = path.join(folder, "held.json")
    await fs.writeFile(locked, "{}", "utf8")
    await fs.chmod(locked, 0o000)
    const held = await storage.readOrCorrupt("held")
    // Windows ignores the mode bits, so the read succeeds there; the shape of the answer is what this asserts, on whichever platform can produce it.
    if (held.value === undefined) check("and one the disk refuses is `unreadable`, which may be neither moved nor written over", held.unreadable !== undefined && held.corrupt === undefined, held)
    else check("and one the disk refuses is `unreadable` (not reachable on this platform; the file read)", true)
    await fs.chmod(locked, 0o600).catch(() => undefined)

    const storageSource = code(await read("src/server/storage.ts"))
    check("a read waits out a Windows lock rather than reporting damage at the first EBUSY", /function readWaiting/.test(storageSource) && /TRANSIENT_LOCK\.has\(code\)/.test(storageSource.slice(storageSource.indexOf("function readWaiting"))), true)
    check("and both readers go through it", /async read<T>[\s\S]{0,200}readWaiting\(this\.file\(key\)\)/.test(storageSource) && /async readText[\s\S]{0,120}readWaiting\(this\.file\(key\)\)/.test(storageSource))
    check("quarantine waits out the same lock instead of giving the file up", /setTimeout\(resolve, 10 \* 2 \*\* Math\.min\(attempt, 5\)\)/.test(storageSource.slice(storageSource.indexOf("export async function quarantine"), storageSource.indexOf("export const QUARANTINE_KEEP_DAYS"))))

    for (const [name, file, guard] of [
      ["the remembered approvals", "src/server/permission.ts", /this\.blocked/],
      ["the settings", "src/server/config.ts", /if \(this\.blocked\) return Promise\.resolve\(\)/],
      ["a conversation's undo stack", "src/server/session/store.ts", /historyBlocked/],
    ] as const) {
      const source = code(await read(file))
      check(`${name}: an unreadable document blocks writing rather than starting empty`, /read\.unreadable/.test(source) && guard.test(source), file)
    }
    const permission = code(await read("src/server/permission.ts"))
    check("and a quarantine that could not move the file blocks it too", /aside === undefined\) this\.blocked/.test(permission))
    const store = code(await read("src/server/session/store.ts"))
    check("every history write goes through the guard, none straight to storage", !/storage\.write\(this\.historyKey\(sessionID\), state\)/.test(store.replace(/private async writeHistory[\s\S]*?\n  }/, "")))
    check("a session record that is there but unreadable counts as one, so nothing tombstones it", /const problem = read\.corrupt \?\? read\.unreadable/.test(store) && /problem !== undefined \|\| read\.value !== undefined/.test(store))

    await fs.rm(folder, { recursive: true, force: true })
  }

  // --------------------------------------------------------------- R23-2
  section("Round 23 (2): the temp sweep leaves another live instance's write alone")
  {
    const folder = await fs.mkdtemp(path.join(os.tmpdir(), "mcode-r23-sweep-"))
    const storage = new Storage(folder)
    const inFlight = path.join(folder, `live.json.${process.pid + 1}.7.tmp`)
    const abandoned = path.join(folder, `gone.json.${process.pid + 2}.7.tmp`)
    const stale = path.join(folder, `old.json.${process.pid + 3}.7.tmp`)
    for (const file of [inFlight, abandoned, stale]) await fs.writeFile(file, "x", "utf8")
    /*
     * Two instances on one profile is a supported case here - sql-worker waits
     * out the other's lock for exactly that reason - and "not my pid" took the
     * other one's temp in the moment between its create and its rename, which
     * fails that write with ENOENT. For a message that is a turn lost; for the
     * approvals, a save swallowed by its own catch.
     */
    const alive = (pid: number) => pid === process.pid + 1 || pid === process.pid + 3
    // Two hours back, so this one is past the age at which a running process's temp stops being protected.
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000)
    await fs.utimes(stale, old, old)
    const removed = await storage.sweepTemps({ alive })
    check("a temp whose process is gone is swept", await fs.access(abandoned).then(() => false, () => true))
    check("one whose process is still running is left where it is", await fs.access(inFlight).then(() => true, () => false))
    check("unless it is over an hour old, whoever holds that id by then", await fs.access(stale).then(() => false, () => true))
    check("and the count is what was taken", removed === 2, removed)
    await fs.rm(folder, { recursive: true, force: true })
  }

  // --------------------------------------------------------------- R23-3
  section("Round 23 (3): the coding-agent loop answers the question it was asked")
  {
    const runner = code(await read("src/server/session/runner.ts"))
    check("an automatic compaction marks at the reply that crossed the line, not at the message just sent", /compactNow\(session, signal, "automatic", reply\.id\)/.test(runner))
    check("and compactNow takes that boundary and summarises only up to it", /compactNow\([^)]*boundary\?: string\)/.test(runner) && /seen = seen\.slice\(0, cut \+ 1\)/.test(runner))

    const search = code(await read("src/server/tool/search.ts"))
    check("neither search claims it capped its own output, so the shared byte cap runs over both", !/metadata: \{[^}]*truncated/.test(search), search.match(/metadata: \{[^}]*\}/g))

    const monitor = new LoopMonitor()
    let raised: unknown
    for (let i = 0; i < 8 && !raised; i++) raised = monitor.consume(searchPart(i % 2 ? "grep" : "glob", "No files found", { matches: 0, count: 0 }))
    // "Produced some text" counted a fruitless search as progress, so the streak this detector is named for could never reach four.
    check("eight searches in a row that turn nothing up raise the streak the detector is named for", Boolean(raised), raised)
    const finding = new LoopMonitor()
    let never: unknown
    for (let i = 0; i < 8 && !never; i++) never = finding.consume(searchPart("grep", "Found 3 matches", { matches: 3 }))
    check("and a search that finds something never does", never === undefined, never)

    const wrapped = { operation: { description: "look at the tests", prompt: "read them", subagent_type: "explore" } }
    // The tool's own description says "A call without an action is a run", and the schema refused exactly that.
    check("the actor tool accepts the action-less call its description tells the model to write", argumentProblems(ActorTool.parameters, wrapped).length === 0, argumentProblems(ActorTool.parameters, wrapped))
    check("and the background shape its handler reads as a spawn", argumentProblems(ActorTool.parameters, { operation: { background: true, description: "d", prompt: "p", subagent_type: "explore" } }).length === 0)

    /*
     * Gemini is shown a numeric enum as strings so the request is accepted, and
     * the answer used to be judged against the untransformed schema: no
     * argument satisfied both, so the turn could only loop.
     */
    const numeric = { type: "object", properties: { level: { type: "integer", enum: [1, 2, 3], description: "verbosity" } } }
    const gemini = { provider: "google", model: "gemini-3-pro" }
    const restored = inputForTool(gemini, numeric, { level: "2" })
    check("a Gemini answer to a numeric enum is read back as the number the tool declares", (restored as { level: unknown }).level === 2, restored)
    check("and it then passes the tool's own validation", argumentProblems(numeric, restored as Record<string, unknown>).length === 0)
    check("a value the enum does not hold is left as it came, to be refused", (inputForTool(gemini, numeric, { level: "9" }) as { level: unknown }).level === "9")
    check("and no other family is touched", inputForTool({ provider: "anthropic", model: "claude-opus-5" }, numeric, { level: "2" }) !== undefined && (inputForTool({ provider: "anthropic", model: "claude-opus-5" }, numeric, { level: "2" }) as { level: unknown }).level === "2")

    const artifacts = code(await read("src/server/artifact/store.ts"))
    check("a recheck asked for while a pass is running is remembered, not dropped", /this\.recheckWanted = true/.test(artifacts) && /const checkAll = this\.recheckWanted \|\| this\.bulk/.test(artifacts))

    const safeListen = code(await read("scripts/safe-listen.ts"))
    check("the checks' port patch gives up after a bounded number of moves", /moves\+\+ < 8/.test(safeListen))
  }

  // --------------------------------------------------------------- R23-4
  section("Round 23 (4): a state rule that the dark theme outranked")
  {
    /*
     * All of these were written as `.x:state { colour }` - one class and a
     * pseudo-class - while a later theme pass put the same property on the
     * plain element inside `:root[data-theme="dark"]`, which outranks it. The
     * state stopped existing in the dark, and nowhere in the light, which is
     * why twenty-two rounds of sweeps went past them.
     */
    for (const [file, selectors] of [
      ["src/renderer/src/components/CustomProviderForm.vue", [".cp-in:focus", ".cp-in.bad", ".cp-pick-btn:hover"]],
      ["src/renderer/src/components/ProviderCloneDialog.vue", [".field-in:focus", ".field-in.bad"]],
      ["src/renderer/src/components/SettingsDialog.vue", [".ci-input:focus", ".nav-search:focus", ".keys-search-mode:hover"]],
      ["src/renderer/src/components/EditedFilesCard.vue", [".fc-review:hover"]],
      ["src/renderer/src/components/parts/QuestionForm.vue", [".q-plan:hover"]],
      ["src/renderer/src/components/parts/SvgFileCard.vue", [".md-svg-failed:hover"]],
    ] as const) {
      const style = await read(file)
      for (const selector of selectors) {
        const explicit = style.includes(`:root[data-theme="dark"] ${selector.startsWith(".md-svg") ? ".text " : ""}${selector}`)
        const media = style.includes(`:root:not([data-theme="light"]) ${selector.startsWith(".md-svg") ? ".text " : ""}${selector}`)
        check(`${file.slice(file.lastIndexOf("/") + 1)} ${selector} survives in both dark schemes`, explicit && media, { explicit, media })
      }
    }
    const settings = await read("src/renderer/src/components/SettingsDialog.vue")
    // Faded rather than recoloured: opacity is the one answer a theme rule on the plain element cannot cancel.
    check("a disabled secondary button fades, so no theme rule can draw it as an enabled one", /\.ctl-btn:disabled \{\s*\n\s*opacity: 0\.4;/.test(settings))
    check("and the dead duplicate of .ci-input:focus is gone", settings.split(".ci-input:focus {").length - 1 === 3, settings.split(".ci-input:focus {").length - 1)

    for (const dead of ["link-btn", "key-row", "row-head", "pmark", "pform-row", "slash-title", "slash-hint", "cp-help", "dialog-titles", "dialog-sub"]) {
      const files = ["src/renderer/src/components/SettingsDialog.vue", "src/renderer/src/components/Composer.vue", "src/renderer/src/components/CustomProviderForm.vue", "src/renderer/src/styles/base.css"]
      const hits = (await Promise.all(files.map((file) => read(file)))).filter((source) => source.includes(`.${dead} `) || source.includes(`.${dead}.`) || source.includes(`.${dead}:`) || source.includes(`.${dead},`))
      check(`the rule for .${dead}, which no template carries, is gone`, hits.length === 0)
    }
  }

  // --------------------------------------------------------------- R23-5
  section("Round 23 (5): two renderer subscriptions that outlive the tab that made them")
  {
    const bridge = code(await read("src/renderer/src/lib/browser-bridge.ts"))
    const shell = code(await read("src/renderer/src/App.vue"))
    check("the window publishes the current browser bindings independently of panel tabs",
      /watch\([\s\S]{0,170}keyboardCommands\.value[\s\S]{0,170}window\.mcode\.browserKeys/.test(shell) &&
      !/\bwatch\(/.test(bridge))
    const settings = code(await read("src/renderer/src/components/SettingsDialog.vue"))
    check("the settings dialog follows a page asked for while it is already open", /watch\(\s*\(\) => props\.section,/.test(settings))
  }
}
