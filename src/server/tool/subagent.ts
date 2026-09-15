import { SUBAGENT_TYPES } from "@shared/protocol"
import type { ToolDefinition } from "./types"
import { ToolError } from "./types"

/**
 * subagents: hands a piece of work to a subagent and waits for its answer.
 *
 * The subagent is a conversation of its own, with its own history and tools,
 * started by the session runner (`ToolContext.subagents`). Several calls in one
 * reply run side by side, since the runner runs one reply's calls together.
 */
export const TaskTool: ToolDefinition = {
  name: "task",
  description: [
    "Hand a self-contained piece of work to a subagent and wait for its answer.",
    "The subagent starts with none of this conversation: the prompt is all it knows, so say what to do, where to look, what is already known and what to report back.",
    "Its final message comes back as this call's result; the user does not see it until you pass on what matters.",
    'Use "explore" for work that only reads - finding code, tracing a behaviour, answering a question about the project - and "general" for work that may change files or run commands.',
    "To run several independent tasks at once, make several calls in the same reply. Do not use this for a single quick lookup you can do yourself.",
  ].join(" "),
  parameters: {
    type: "object",
    properties: {
      description: { type: "string", description: "A short name for the task, three to six words, shown to the user" },
      prompt: { type: "string", description: "The complete instructions for the subagent" },
      subagent_type: {
        type: "string",
        enum: [...SUBAGENT_TYPES],
        description: "explore only reads; general can also edit files and run commands",
      },
    },
    required: ["description", "prompt", "subagent_type"],
    additionalProperties: false,
  },
  async execute(input, context) {
    if (!context.subagents) throw new ToolError("A subagent cannot start subagents of its own.")
    const description = String(input.description ?? "").trim()
    const prompt = String(input.prompt ?? "").trim()
    if (!prompt) throw new ToolError("The prompt is empty, so there is nothing to hand over.")
    const type = input.subagent_type === "explore" ? "explore" : "general"
    return context.subagents({ description, prompt, type })
  },
}
