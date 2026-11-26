/**
 * Round 81: the turn settles its endpoint once, and every decision of the turn answers to that one.
 *
 * The lean series (rounds 78-80) made the tool list follow the endpoint the turn actually answers
 * from. An independent review of the whole delta found the sentence never carried through: skill
 * discovery, the slash reminders, the opening runtime note and the dispatcher each re-formed the
 * decision from the *persisted* session and *live* provider config. A session persisted remote but
 * routed to a local endpoint (or the `MCODE_LEAN` hatch overruling the endpoint) then told the
 * model about tools its request never carried - or hid skills whose tools it did carry. The fix is
 * one decision, settled once per turn, passed everywhere; not four helpers each guessing.
 *
 *   1. The opening settles `turnModel` (command model, then smart route, then the conversation) and
 *      hands it - as `turnLean` - to the skills, the reminders, the runtime note and the launch.
 *   2. Every skills call takes the finished lean decision (`leanFor` / the turn's `input.local`),
 *      never a raw endpoint locality: the registry leans internally, but `skill.ts` trusts its flag.
 *   3. A steer that joins a running turn takes that turn's settled lean from the steering record.
 *   4. Dispatch answers to the captured `turnLocal` and refuses with the turn's own offered list -
 *      no store reload, no live config read between the request going out and the call landing.
 */
import fs from "node:fs"
import path from "node:path"

const ROOT = process.cwd()
const failures: string[] = []
const check = (cond: boolean, what: string): void => {
  if (!cond) failures.push(what)
}

const runner = fs.readFileSync(path.join(ROOT, "src/server/session/runner.ts"), "utf8")
const dialog = fs.readFileSync(path.join(ROOT, "src/renderer/src/components/SettingsDialog.vue"), "utf8")
const registry = fs.readFileSync(path.join(ROOT, "src/server/tool/registry.ts"), "utf8")

/** Body of one method, from its signature to the next `private ` at the same indent (approximate, stable enough for guards). */
function methodBody(name: string): string {
  const start = runner.indexOf(`private async ${name}(`) >= 0 ? runner.indexOf(`private async ${name}(`) : runner.indexOf(`private ${name}(`)
  const next = runner.indexOf("\n  private ", start + 1)
  return runner.slice(start, next > 0 ? next : undefined)
}

function oneDecisionOneEntry(): void {
  check(runner.includes("private leanFor("), "runner has no single finished-lean entry point (leanFor)")
  check(/leanFor\(session[^)]*\)[\s\S]{0,80}leanMode\(this\.isLocal/.test(methodBody("leanFor")) || methodBody("leanFor").includes("leanMode(this.isLocal(session))"),
    "leanFor is not built from leanMode over the endpoint locality")
  // The registry half of the invariant: raw locality in, lean applied inside.
  check(/export function withheldByLean[\s\S]*?leanMode\(local\)/.test(registry), "withheldByLean no longer applies the env hatch to the raw locality")
}

function openingSettlesTheTurn(): void {
  check(/const namedTurn = this\.turnOverrides\.get\(session\.id\)\?\.model/.test(runner), "opening does not read the command model override")
  check(/namedTurn && this\.config\.definition\(namedTurn\.provider\) && this\.config\.usable\(namedTurn\.provider\)/.test(runner),
    "the command model is not validated the way prepare's withCommandTurn validates it")
  check(/\?\? route\?\.model \?\? session\.model/.test(runner), "the opening model does not fall route then conversation")
  check(runner.includes("const turnLean = this.leanFor({ model: turnModel })"), "turnLean is not settled from the turn's model")
  check(runner.includes("this.remindersFor(input, session.directory, turnLean)"), "opening reminders do not take the turn's decision")
  check(runner.includes("this.runtimeNotes({ ...session, model: turnModel }, first)"), "the opening runtime note still reads the persisted model")
  check(runner.includes("this.launch(session.id, apiKey, controller, false, lead, route, turnLean)"), "the launch still re-forms the lean decision")
}

function skillsTakeTheFinishedDecision(): void {
  check(!/skillsFor\([^)]*this\.isLocal\(/.test(runner), "a skills call still takes a raw endpoint locality")
  check(runner.includes("this.skillsFor(session.directory, this.leanFor(session))"), "the system-prompt skills call does not take leanFor")
  check(runner.includes("this.skillsFor(input.session.directory, leanMode(input.local))"), "the skill tool's list does not take the turn's captured locality")
  check(methodBody("remindersFor").includes("turnLean ?? (session ? this.leanFor(session) : false)"),
    "remindersFor still forms its own decision when the caller settled one")
  check(runner.includes("this.remindersFor(input, undefined, steering.lean)"), "a steer re-forms the lean decision instead of taking the running turn's")
}

function dispatchAnswersToTheTurn(): void {
  const runTool = methodBody("runTool")
  check(runTool.includes("const leanLocal = input.local"), "dispatch still reads locality live at call time")
  check(!/this\.isLocal\(/.test(runTool), "runTool still forms an endpoint decision of its own")
  check(runTool.includes("const available = [...this.offeredTools(input.session)"), "the invalid-tool refusal still answers from the stored session")
  check(runTool.includes("input.session.subagent?.outputSchema"), "the structured-output tool no longer comes from the turn's session")
  const calls = runner.match(/this\.runTool\(\{[^}]*\}\)/g) ?? []
  check(calls.length >= 2 && calls.every((call) => call.includes("local: turnLocal")), "a runTool call site dispatches without the captured locality")
  check(runner.includes("const turnLocal = isLocalEndpoint(session.model.provider, definition.baseURL)"),
    "the turn does not capture locality together with the URL it sends to")
}

function emptyStateCannotLie(): void {
  // The refresh must clear the old page's claim (the empty card included) before the new answer arrives.
  const body = dialog.slice(dialog.indexOf("async function refreshCliPlugins()"))
  const reset = body.indexOf("cliListLoaded.value = false")
  const request = body.indexOf('type: "cliPlugin.list"')
  check(reset >= 0 && request >= 0 && reset < request, "refreshing the plugin list can leave the stale empty state on screen")
}

function main(): void {
  oneDecisionOneEntry()
  openingSettlesTheTurn()
  skillsTakeTheFinishedDecision()
  dispatchAnswersToTheTurn()
  emptyStateCannotLie()
  if (failures.length) {
    console.error(`round81: FAIL (${failures.length})`)
    for (const line of failures) console.error(" -", line)
    process.exitCode = 1
    return
  }
  console.log(`round81: PASS (${11} checks)`)
}
main()
