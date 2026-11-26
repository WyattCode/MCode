/**
 * Round 80: what a turn is told about its reply language follows the same endpoint answer as the
 * tools it is given.
 *
 * A turn whose endpoint sits on this machine or the LAN runs lean (round 79 established the
 * criterion: `isLocalEndpoint` over `definition(id).baseURL`, never the provider id). The language
 * directive every user message carries used to read the same way on both ends: a two-sentence rule
 * with an exception clause inside it. A 0.6B model does not hold an "unless" branch - it answers in
 * the language of the message and moves on. So the lean turn gets the directive as one imperative
 * sentence, and the exception ("unless the user explicitly asks for another") is named once, in the
 * lean system prefix, where the model already met the tools it has. What never changes is which
 * language: both variants name the interface language, so the language follows the user's choice
 * and only the wording follows the endpoint.
 *
 *   1. `runtimeContext` names the same locale in both wordings, and the lean wording carries no
 *      conditional clause.
 *   2. The lean system prefix keeps its one exception and points the rule at the turn context, so
 *      the two halves add up to one rule rather than two competing ones.
 *   3. Every call site feeds the flag from the endpoint answer (`leanMode(this.isLocal(...))`),
 *     including a message steered mid-turn, which takes the turn's answer and does not form its own.
 */
import fs from "node:fs"
import path from "node:path"
import { runtimeContext } from "../src/server/session/context"
import { agentPrompt } from "../src/server/session/prompts"

const ROOT = process.cwd()
const failures: string[] = []
const check = (cond: boolean, what: string): void => {
  if (!cond) failures.push(what)
}

/** The locale named by a runtime-context block, whatever the wording around it. */
function namedLanguage(block: string): string {
  const match = block.match(/Response language: (.+?)\./)
  return match?.[1] ?? ""
}

function directiveFollowsTheEndpoint(): void {
  delete process.env.MCODE_LEAN
  for (const language of ["zh-CN", "th", undefined]) {
    const full = runtimeContext({ language })
    const lean = runtimeContext({ language, lean: true })
    const name = namedLanguage(full)
    check(name.length > 0, `the full directive names a response language for ${String(language)}`)
    check(namedLanguage(lean) === name, `the lean directive names the same response language (${name}) - the language follows the user's choice, only the wording follows the endpoint`)
    check(full.includes("unless"), "the full directive keeps its exception clause")
    check(!/\bunless\b|except|otherwise/i.test(lean), "the lean directive carries no conditional clause a small model would have to hold")
    check(/Write every reply in it/i.test(lean), `the lean directive is one imperative sentence: ${lean.split("\n").find((line) => line.startsWith("Response language")) ?? "(missing)"}`)
  }
  // The rest of the block is the same block; the switch is only the directive's wording.
  const full = runtimeContext({ language: "zh-CN", directory: "/tmp/where", today: "2026-11-26" })
  const lean = runtimeContext({ language: "zh-CN", directory: "/tmp/where", today: "2026-11-26", lean: true })
  check(full.includes("Working directory: /tmp/where") && lean.includes("Working directory: /tmp/where"), "the working directory rides the same way in both")
  check(full.includes("Today: 2026-11-26") && lean.includes("Today: 2026-11-26"), "the date rides the same way in both")
}

function prefixKeepsTheOneException(): void {
  const lean = agentPrompt(undefined, { local: true, toolNames: [] })
  const full = agentPrompt(undefined, { local: false, toolNames: [] })
  check(/## Reply language/.test(lean), "the lean prefix keeps a reply-language section")
  check(/turn context/i.test(lean), "the lean prefix points the rule at the turn context, where the language is named")
  check(lean.split(/## Reply language/)[1].split("##")[0].match(/\bunless\b/gi)?.length === 1, "the exception is named exactly once in the lean prefix's reply-language section")
  check(/## Reply language/.test(full) && /interface/i.test(full.split(/## Reply language/)[1].split("##")[0]), "the full prefix keeps its paragraph tying the language to the interface setting")
}

function everyCallSiteFollowsTheEndpoint(): void {
  const runner = fs.readFileSync(path.join(ROOT, "src/server/session/runner.ts"), "utf8")
  check(/const runtime = runtimeContext\(\{[^}]*lean: leanMode\(this\.isLocal\(session\)\)/s.test(runner), "the turn's own messages take the lean wording from the endpoint answer")
  check(/runtimeContext\(\{[^}]*lean: steering\.lean/s.test(runner), "a message steered into a turn takes the turn's answer, not a fresh one")
  check(/this\.steering\.set\(child\.id,\s*\{[^}]*lean: leanMode\(this\.isLocal\(child\)\)/s.test(runner), "a subagent's turn opens with its own endpoint answer")
  const launches = [...runner.matchAll(/this\.launch\(\n?([^\n]*)/g)]
  check(launches.length >= 3, `every place that opens a turn passes the flag (${launches.length} launch call sites seen)`)
  for (const call of launches) check(/leanMode\(/.test(call[1]), `a launch call opens its turn without saying whether it runs lean: this.launch(${call[1].slice(0, 120)})`)
  const context = fs.readFileSync(path.join(ROOT, "src/server/session/context.ts"), "utf8")
  check(!/Response language[^`]*\?|\?\s*`Response language/.test(context) || /input\.lean/.test(context), "the wording switch is read off the input's lean flag")
}

function main(): void {
  directiveFollowsTheEndpoint()
  prefixKeepsTheOneException()
  everyCallSiteFollowsTheEndpoint()
  for (const failure of failures) console.log("FAIL:", failure)
  console.log(`\nround80: ${failures.length === 0 ? "PASS" : `FAIL (${failures.length})`}`)
  if (failures.length > 0) process.exitCode = 1
}

main()
