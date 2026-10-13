/**
 * P0 check: tool calls a model wrote as plain text are read back, and the
 * continuation that reads them hands them to the runner rather than an error.
 *
 * Run: `bun scripts/smoke-p0-text-tool-parse.ts` (or `npx tsx`).
 */

import type { AssistantMessage } from "@shared/protocol"
import { parseTextToolCalls } from "../src/server/session/text-tool-parse"
import { continuationFor } from "../src/server/session/reminders"

let passed = 0
let failed = 0

function check(name: string, ok: boolean) {
  if (ok) {
    passed += 1
    console.log(`  ok   ${name}`)
  } else {
    failed += 1
    console.log(`  FAIL ${name}`)
  }
}

/* ------------------------------------------------------------------ shapes */

const XML =
  '<function_calls><invoke name="edit"><parameter name="file_path">a.ts</parameter><parameter name="old_string">x</parameter><parameter name="new_string">y</parameter></invoke></function_calls>'

const xml = parseTextToolCalls(XML)
check("xml: one call", xml.length === 1)
check("xml: name is edit", xml[0]?.name === "edit")
check(
  "xml: parameters present",
  xml[0]?.input?.file_path === "a.ts" && xml[0]?.input?.old_string === "x" && xml[0]?.input?.new_string === "y",
)

const fenced = parseTextToolCalls('```json\n{"name":"bash","arguments":{"command":"ls"}}\n```')
check("json: one call", fenced.length === 1)
check("json: name is bash", fenced[0]?.name === "bash")
check("json: arguments carried", fenced[0]?.input?.command === "ls")

const openai = parseTextToolCalls('{"function":{"name":"read","arguments":"{\\"file_path\\":\\"z.ts\\"}"}}')
check("openai-ish: one call", openai.length === 1)
check("openai-ish: name is read", openai[0]?.name === "read")
check("openai-ish: stringified arguments parsed", openai[0]?.input?.file_path === "z.ts")

check("prose: nothing recovered", parseTextToolCalls("Sure, I will edit a.ts and change x to y with the edit tool.").length === 0)
check("malformed: nothing recovered", parseTextToolCalls('{"name":"edit","arguments":{"file_path":').length === 0)
check("empty: nothing recovered", parseTextToolCalls("").length === 0)

/* --------------------------------------------------------------------- cap */

const many = Array.from(
  { length: 6 },
  (_, index) => `<invoke name="edit"><parameter name="file_path">f${index}.ts</parameter></invoke>`,
).join("")
check("cap: at most five calls", parseTextToolCalls(many).length <= 5 && parseTextToolCalls(many).length === 5)

/* ------------------------------------------------------- continuationFor */

const message = {
  id: "msg_1",
  sessionID: "ses_1",
  role: "assistant",
  model: { provider: "test", model: "test-model" },
  parts: [{ type: "text", id: "prt_1", text: XML }],
  time: { created: Date.now() },
} as unknown as AssistantMessage

const next = continuationFor(message, "end_turn", "tool_calls", "test-model", { length: 0, textTool: 0, empty: 0, interrupted: 0 })
check("continuation: calls recovered", (next.recovered?.length ?? 0) >= 1)
check("continuation: recovered call is the edit", next.recovered?.[0]?.name === "edit")
check("continuation: no error", next.error === undefined)

console.log(`${passed} passed / ${failed} failed`)
if (failed > 0) process.exit(1)
