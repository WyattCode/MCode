/**
 * Codex-parity mechanisms: reasoning bash output budget and one-call task plan.
 * Run: esbuild + node, or bun with aliases.
 */
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { applyTask, TaskTool } from "../src/server/tool/task"
import { BashTool } from "../src/server/tool/bash"
import type { ToolContext } from "../src/server/tool/types"

let passed = 0
let failed = 0

function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) {
    passed++
    console.log(`  ok   ${name}`)
  } else {
    failed++
    console.log(`  FAIL ${name}${detail === undefined ? "" : ` -> ${JSON.stringify(detail)}`}`)
  }
}

function throws(name: string, fn: () => unknown) {
  try {
    fn()
    check(name, false, "did not throw")
  } catch {
    check(name, true)
  }
}

const now = 1_000
const owner = "smoke"

const first = applyTask(
  [],
  {
    action: "plan",
    plan: [
      { step: "one", status: "pending" },
      { step: "two", status: "in_progress" },
      { step: "three", status: "pending" },
    ],
  },
  { owner, subagent: false, now },
)

check("first plan creates three tasks", first.tasks.length === 3)
check("first plan ids", first.tasks.map((task) => task.id).join(",") === "T1,T2,T3")
check("first plan statuses", first.tasks.map((task) => task.status).join(",") === "open,in_progress,open")
check("first plan output has T2", first.result.output.includes("T2 [in_progress]"))
check("first plan metadata ids", JSON.stringify(first.result.metadata?.ids) === JSON.stringify(["T1", "T2", "T3"]))

const second = applyTask(
  first.tasks,
  {
    action: "plan",
    plan: [
      { step: "one", status: "completed" },
      { step: "two", status: "completed" },
      { step: "three", status: "in_progress" },
    ],
  },
  { owner, subagent: false, now: now + 1 },
)

check("second plan reuses ids", second.tasks.map((task) => task.id).join(",") === "T1,T2,T3")
check("second plan T1 done", second.tasks[0]?.status === "done")
check("second plan T1 ended", second.tasks[0]?.ended === now + 1)
check("second plan T2 done", second.tasks[1]?.status === "done")
check("second plan T3 in_progress", second.tasks[2]?.status === "in_progress")

const third = applyTask(
  second.tasks,
  {
    action: "plan",
    plan: [{ step: "four", status: "pending" }],
  },
  { owner, subagent: false, now: now + 2 },
)

check("third plan adds T4", third.tasks.length === 4 && third.tasks[3]?.id === "T4")
check("third plan leaves T3", third.tasks[2]?.status === "in_progress")

const aliases = applyTask(
  [],
  {
    action: "plan",
    plan: [
      { step: "alias open", status: "open" },
      { step: "alias done", status: "done" },
    ],
  },
  { owner, subagent: false, now },
)

check("alias open maps to open", aliases.tasks[0]?.status === "open")
check("alias done maps to done", aliases.tasks[1]?.status === "done")
check("alias done ended", aliases.tasks[1]?.ended === now)

throws("two in_progress throws", () =>
  applyTask(
    [],
    {
      action: "plan",
      plan: [
        { step: "a", status: "in_progress" },
        { step: "b", status: "in_progress" },
      ],
    },
    { owner, subagent: false, now },
  ),
)

throws("empty plan throws", () => applyTask([], { action: "plan", plan: [] }, { owner, subagent: false, now }))

throws("missing step throws", () =>
  applyTask([], { action: "plan", plan: [{ status: "pending" }] }, { owner, subagent: false, now }),
)

check("task tool exposes plan action", TaskTool.parameters.properties?.operation?.properties?.plan !== undefined)
check("task tool exposes explanation", TaskTool.parameters.properties?.operation?.properties?.explanation !== undefined)

async function main() {
  const directory = mkdtempSync(join(tmpdir(), "mcode-smoke-p1-"))
  try {
    const command = `node -e "process.stdout.write('x'.repeat(200000))" # raw`

    const baseContext = {
      sessionID: "session",
      messageID: "message",
      callID: "call",
      directory,
      permissions: {
        ask: async () => undefined,
        action: () => "allow",
      },
      questions: {
        ask: async () => undefined,
      },
      signal: new AbortController().signal,
      progress: () => {},
      snapshot: async () => {},
      toolOutputs: undefined,
    }

    const reasoningContext = {
      ...baseContext,
      maxOutputTokens: 1000,
    } as unknown as ToolContext

    const explicitContext = {
      ...baseContext,
    } as unknown as ToolContext

    const reasoning = await BashTool.execute({ command, cmd: command }, reasoningContext)
    check("reasoning context truncates output", reasoning.output.length < 20000, reasoning.output.length)
    check("reasoning context marks truncated", reasoning.metadata?.truncated === true, reasoning.metadata)

    const explicit = await BashTool.execute({ command, cmd: command, max_output_tokens: 100000 }, explicitContext)
    check("explicit budget keeps output", explicit.output.length >= 200000, explicit.output.length)
    check("explicit budget not truncated", explicit.metadata?.truncated !== true, explicit.metadata)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }

  console.log(`${passed} passed / ${failed} failed`)
  if (failed) process.exit(1)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
