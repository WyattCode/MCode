/**
 * Round 10: how a turn's steps are drawn, item by item against MiMo 26.914
 * (K10-1 … K10-16). Kept apart from smoke.ts the way the earlier rounds are;
 * smoke.ts calls `roundTenStepsChecks` with its own check and section. The
 * pure rules are called directly; what only a window shows is left to the
 * Electron probe.
 */
import type { Check } from "./smoke-round5"
import type { AssistantPart, Message, ToolPart, UserMessage } from "../src/shared/protocol"
import { cleanLiveReply, cleanReply, isDotsOnly, saysSomething } from "../src/shared/reply-clean"
import { opensTurn, turnOpeners } from "../src/shared/steer"
import { buildRows, stagesOf } from "../src/renderer/src/lib/step-rows"

const tool = (id: string, name: string, status: ToolPart["status"] = "completed", extra: Partial<ToolPart> = {}): ToolPart =>
  ({ type: "tool", id, callID: `call_${id}`, name, status, input: {}, time: { created: 1 }, ...extra }) as ToolPart
const text = (id: string, words: string): AssistantPart => ({ type: "text", id, text: words }) as AssistantPart

export async function roundTenStepsChecks(check: Check, section: (name: string) => void): Promise<void> {
  section("Round 10 (K10-6): leaked markup and lone ellipses")
  {
    check("a leaked thinking block is removed", cleanReply("<think>plan it</think>The answer.") === "The answer.")
    check("so is a tool call written as text", cleanReply("Before <tool_call>{\"name\":\"read\"}</tool_call> after") === "Before  after")
    check("an unclosed opener cuts the rest", cleanReply("Visible.\n<tool_call>{\"name\":") === "Visible.")
    check("a function-style call is removed", cleanReply("A<function=read><parameter=path>x</parameter></function>B") === "AB")
    check("a stray closing tag is dropped", cleanReply("done</think>") === "done")
    check("a parameter left on its own is removed", cleanReply("x <parameter=path>a</parameter> y") === "x  y")
    check("markup inside a fenced block stays", cleanReply("```xml\n<think>kept</think>\n```") === "```xml\n<think>kept</think>\n```")
    check("and inside an inline code span", cleanReply("Use `<tool_call>` tags.") === "Use `<tool_call>` tags.")
    check("blank runs are squeezed and line ends trimmed", cleanReply("a  \n\n\n\nb") === "a\n\nb")
    check("an ellipsis alone is no step", isDotsOnly(" … ") && isDotsOnly("。。。") && isDotsOnly("..."))
    check("words with dots are", !isDotsOnly("ok..."))
    check("a thinking block alone says nothing", !saysSomething("<think>only this</think>"))
    check("a live reply holds back a tag still arriving", cleanLiveReply("Working <tool_ca") === "Working")
    check("but not an ordinary less-than", cleanLiveReply("a <b") === "a <b")
    check("nor one inside a code block still being written", cleanLiveReply("```\nx <tool_ca") === "```\nx <tool_ca")
  }

  section("Round 10 (K10-3, K10-6, K10-13): what becomes a row")
  {
    const rows = buildRows([
      tool("r1", "read"),
      text("t1", "…"),
      tool("r2", "read"),
      tool("a1", "actor", "completed", { input: { action: "run", description: "look" } }),
      tool("r3", "read"),
      tool("q1", "question", "running"),
      tool("r4", "read"),
    ])
    const shape = rows.map((row) => (row.kind === "group" ? `${row.actor ? "A" : "G"}${row.items.length}` : row.kind)).join(",")
    check("a lone ellipsis does not break a group", shape.startsWith("G2,"), shape)
    check("a subagent call is a group of its own, closing and closed by other calls", shape === "G2,A1,G2", shape)
    const answered = buildRows([tool("q2", "question", "completed"), tool("r5", "read")])
    check("an answered question is still its own row", answered.map((row) => row.kind).join() === "question,group")
  }

  section("Round 10 (K10-1): MiMo's stages")
  {
    const kinds = ["work", "say", "work", "work", "say", "say"]
    const stages = stagesOf(kinds, (kind) => kind === "say")
    check(
      "work then words make a stage, and work after words starts the next",
      JSON.stringify(stages) === JSON.stringify([
        { start: 0, progressEnd: 1, end: 2 },
        { start: 2, progressEnd: 4, end: 6 },
      ]),
      stages,
    )
    const quiet = stagesOf(["say", "work"], (kind) => kind === "say")
    check("a last stage that said nothing ends where its work ends", JSON.stringify(quiet.at(-1)) === JSON.stringify({ start: 1, progressEnd: 2, end: 2 }), quiet)
    check("words alone are one stage with nothing to fold", JSON.stringify(stagesOf(["say"], (kind) => kind === "say")) === JSON.stringify([{ start: 0, progressEnd: 0, end: 1 }]))
  }

  section("Round 10 (K10-2): a taken steer opens a turn")
  {
    const user = (id: string, extra: Record<string, unknown> = {}) =>
      ({ id, sessionID: "s", role: "user", text: id, attachments: [], time: { created: 1 }, ...extra }) as Message
    const reply = (id: string) => ({ id, sessionID: "s", role: "assistant", model: { provider: "p", model: "m" }, agent: "build", parts: [], time: { created: 1 } }) as Message
    const thread = [user("q1"), reply("a1"), user("s1", { steered: true }), reply("a2"), user("s2", { steered: true }), user("n1", { steered: true, notices: [{ sessionID: "c", subagentID: "x", description: "d", status: "completed" }] })]
    const live = [...turnOpeners(thread, false)].sort().join()
    check("while running: the question and the taken steer open turns, the waiting steer and the notice do not", live === "q1,s1", live)
    const settled = [...turnOpeners(thread, true)].sort().join()
    check("with nothing running the untaken steer is a question of its own", settled === "q1,s1,s2", settled)
    check("an ordinary message always opens one", opensTurn(user("x") as UserMessage, false, false))
  }
}
