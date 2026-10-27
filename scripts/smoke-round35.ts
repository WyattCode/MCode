/**
 * Round 35: coding capability, measured by scripts/bench.
 *
 * The first thing the benchmark turned up: a turn that probes and never
 * changes anything. One run spent eight minutes and 177 steps convinced that
 * Node's Date was broken, every command different and every one succeeding,
 * so none of MiMo's loop detectors could see it. `WanderWatch` counts the
 * calls since a file the project already had last changed, and tells the
 * model to stop and think, then to hand over.
 *
 * smoke.ts calls `roundThirtyFiveChecks` with its own check and section.
 */
import fs from "node:fs/promises"
import path from "node:path"
import type { ToolPart } from "@shared/protocol"
import type { Check } from "./smoke-round5"
import { WANDER_CALLS, WanderWatch } from "../src/server/session/loop-health"

const root = process.cwd()

export async function roundThirtyFiveChecks(check: Check, section: (name: string) => void): Promise<void> {
  section("Round 35: a turn that probes and never changes the project is told to stop")
  {
    const call = (name: string, input: Record<string, unknown>, extra: Partial<ToolPart> = {}): ToolPart => ({
      type: "tool",
      id: `prt_${Math.random().toString(36).slice(2)}`,
      callID: "c",
      name,
      status: "completed",
      input,
      time: { created: 0 },
      ...extra,
    })
    const probe = (n: number) => call("bash", { command: `node -e "console.log(${n})"` }, { output: String(n), metadata: { exit: 0 } })
    const feed = (watch: WanderWatch, count: number, from = 0) => {
      for (let n = 0; n < count; n++) watch.consume(probe(from + n))
    }

    const watch = new WanderWatch()
    feed(watch, WANDER_CALLS - 1)
    check("nineteen successful probes are not yet a problem", watch.note() === undefined)
    feed(watch, 1, 100)
    const first = watch.note()
    check("the twentieth is: the model is told to stop and think", /stop and write down/.test(first ?? "") && /language or a library/.test(first ?? ""), first)
    check("told once, not again on the next call", (watch.consume(probe(200)), watch.note()) === undefined)

    feed(watch, WANDER_CALLS - 1, 300)
    const second = watch.note()
    check("twenty more and it is told to hand over to the user", /Stop investigating/.test(second ?? "") && /concrete next step/.test(second ?? ""), second)
    feed(watch, WANDER_CALLS * 2, 400)
    check("and after that it is left alone", watch.note() === undefined)

    const moving = new WanderWatch()
    feed(moving, WANDER_CALLS - 1)
    moving.consume(call("edit", { file_path: "src/dates.js", old_string: "a", new_string: "b" }, { metadata: { path: "src/dates.js", diff: "-a\n+b" } }))
    feed(moving, WANDER_CALLS - 1, 500)
    check("an edit to a file the project had starts the count again", moving.note() === undefined)

    const probing = new WanderWatch()
    probing.consume(call("write", { file_path: "probe.js", content: "x" }, { metadata: { path: "probe.js", created: true } }))
    for (let n = 0; n < WANDER_CALLS; n++) probing.consume(call("edit", { file_path: "probe.js", old_string: String(n), new_string: String(n + 1) }, { metadata: { path: "probe.js", diff: "-" } }))
    check("writing and rewriting its own probe script is not progress", probing.note() !== undefined)

    const failing = new WanderWatch()
    failing.consume(call("edit", { file_path: "src/a.js", old_string: "a", new_string: "b" }, { status: "error", error: "old_string not found" }))
    feed(failing, WANDER_CALLS - 1, 600)
    check("an edit that failed changed nothing, so it does not reset the count", failing.note() !== undefined)

    const unsettled = new WanderWatch()
    for (let n = 0; n < WANDER_CALLS; n++) unsettled.consume(call("bash", { command: "x" }, { status: "running" }))
    check("only settled calls are counted", unsettled.note() === undefined)

    const runner = await fs.readFile(path.join(root, "src", "server", "session", "runner.ts"), "utf8")
    const settle = runner.slice(runner.indexOf("private settleForLoops("), runner.indexOf("private settleForLoops(") + 600)
    check("every settled call is counted, as the other detectors' are", /watch\.wander\.consume\(part\)/.test(settle))
    const afterTools = runner.slice(runner.indexOf("const calls = new Semaphore(STEP_TOOL_LIMIT)"), runner.indexOf("const calls = new Semaphore(STEP_TOOL_LIMIT)") + 900)
    check("and once a step's tools are done, the note goes into the next request", /wander\.note\(\)/.test(afterTools) && /notes\.set\(assistant\.id/.test(afterTools))
    check("the watch starts afresh with every turn, with the others", /loopWatches\.delete\(sessionID\)/.test(runner) && /new LoopMonitor\(sessionID\), wander: new WanderWatch\(\)/.test(runner))
  }
}
