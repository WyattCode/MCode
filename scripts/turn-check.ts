/**
 * The turn that thought at length, announced the work and stopped, with nothing
 * done; the last step of a local model's turn; and the task list being drawn as a
 * subagent. The real runner over a fake server, because what matters is what goes
 * on the wire.
 */
import "./fenced-home"
import "./safe-listen"
import { calls, engine, say, wireText } from "./smoke-round5"
import { ANNOUNCED_NOTE, continuationFor } from "../src/server/session/reminders"
import { isLegacySubagentCall } from "../src/shared/subagent"
import { syntaxRunResult } from "../src/server/tool/post-edit-check"
import { TASK_ACTIONS } from "../src/server/tool/task"

let passed = 0
let failed = 0
const check = (name: string, ok: boolean, detail?: unknown) => {
  if (ok) passed++
  else failed++
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${!ok && detail !== undefined ? ` -> ${JSON.stringify(detail)}` : ""}`)
}

console.log("a turn that only announced the work")
const replied = (thought: number, text: string, tool = false) =>
  ({
    role: "assistant",
    parts: [{ type: "reasoning", text: "x".repeat(thought) }, { type: "text", text }, ...(tool ? [{ type: "tool", name: "write", status: "completed" }] : [])],
  }) as never
const counts = () => ({ length: 0, textTool: 0, empty: 0, interrupted: 0 })
const note = (message: never, opening = true, stop = "end_turn", used = counts()) => continuationFor(message, stop, "stop", "m", used, "", opening).note
check("a long think and one line is asked to do the work", note(replied(9000, "我来直接写这个文件。")) === ANNOUNCED_NOTE)
check("the same after a later step is an answer", note(replied(9000, "我来直接写这个文件。"), false) === undefined)
check("a short think and a short answer is an answer", note(replied(300, "是的。")) === undefined)
check("a long think and a long answer is an answer", note(replied(9000, "答".repeat(500))) === undefined)
check("a step that called a tool is not asked", note(replied(9000, "我来写。", true)) === undefined)
check("a reply the limit cut is not this case", note(replied(9000, "我来写。"), true, "max_tokens") !== ANNOUNCED_NOTE)
const twice = counts()
note(replied(9000, "我来写。"), true, "end_turn", twice)
note(replied(9000, "我来写。"), true, "end_turn", twice)
check("it is asked twice at most", note(replied(9000, "我来写。"), true, "end_turn", twice) === undefined)

console.log("on the wire")
const e = await engine()
try {
  const frame = (data: unknown) => `data: ${JSON.stringify(data)}\n\n`
  e.replies.push((response) => {
    response.writeHead(200, { "content-type": "text/event-stream" })
    response.write(frame({ choices: [{ delta: { reasoning_content: "Plan. ".repeat(1_000) } }] }))
    response.write(frame({ choices: [{ delta: { content: "我来直接写这个文件。" } }] }))
    response.end(frame({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5 } }) + "data: [DONE]\n\n")
  })
  e.replies.push(calls([{ name: "read", input: { file_path: "README.md" } }]))
  e.replies.push(say("done"))
  const session = await e.store.create({ directory: e.project, model: e.model })
  await e.runner.prompt({ sessionID: session.id, text: "draw a pelican" })
  await e.idle(session.id)
  check("the announced turn is asked to do the work, and does", e.bodies.length === 3 && wireText(e.bodies[1]).includes(ANNOUNCED_NOTE.slice(0, 60)) && !wireText(e.bodies[0]).includes(ANNOUNCED_NOTE.slice(0, 60)), e.bodies.length)
  const called = (await e.assistants(session.id)).flatMap((message) => message.parts.filter((part) => part.type === "tool"))
  check("and the tool it was asked for runs", called.length === 1, called.length)
} finally {
  await e.close()
}

console.log("the last step")
const local = await engine()
try {
  await local.config.set({ maxSteps: 1 } as never)
  local.replies.push(calls([{ name: "read", input: { file_path: "README.md" } }]))
  // Told not to, and calls a tool anyway.
  local.replies.push(calls([{ name: "read", input: { file_path: "gone.md" } }], "stopping"))
  const session = await local.store.create({ directory: local.project, model: local.model })
  await local.runner.prompt({ sessionID: session.id, text: "go" })
  await local.idle(session.id)
  check("a local server is not told tool_choice none, which would start its cache over", local.bodies.at(-1)?.tool_choice === "auto", local.bodies.at(-1)?.tool_choice)
  check("the tools stay in the request, and it is told in words", (local.bodies.at(-1)?.tools?.length ?? 0) > 0 && wireText(local.bodies.at(-1)).includes("MAXIMUM STEPS REACHED"))
  const replies = await local.assistants(session.id)
  check("a call made on the last step is dropped, not run", replies.length === 2 && !replies[1]!.parts.some((part) => part.type === "tool") && JSON.stringify(replies[1]!.parts).includes("stopping"), replies.length)
  check("and the turn asks nothing more", local.bodies.length === 2, local.bodies.length)
} finally {
  await local.close()
}

console.log("a checker that could not start")
const run = (code: number | null) => ({ code, stdout: "", stderr: "spawn node ENOENT", timedOut: false, aborted: false })
check("says nothing about the edited file", syntaxRunResult("node --check", run(null), "a.js", "a.js", ".", 25) === undefined)
check("while one that ran and failed still reports", syntaxRunResult("node --check", run(1), "a.js", "a.js", ".", 25) !== undefined)

console.log("the task list is not a subagent")
check("no verb of the task tool reads as a saved subagent call", TASK_ACTIONS.every((action) => !isLegacySubagentCall({ type: "tool", name: "task", input: { operation: { action } } })))
check("an old subagent call still does", isLegacySubagentCall({ type: "tool", name: "task", input: { action: "run", prompt: "x" } }))

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
