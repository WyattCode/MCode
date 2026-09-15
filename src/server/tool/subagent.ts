import { SUBAGENT_TYPES } from "@shared/protocol"
import { SUBAGENT_ACTIONS, taskAction, taskTarget } from "@shared/subagent"
import type { ToolDefinition } from "./types"
import { ToolError } from "./types"

/**
 * subagents: MiMo's actor tool, under this app's name and in its own words.
 *
 * A subagent is a conversation of its own, with its own history and tools,
 * started and kept by the session runner (`ToolContext.subagents`). `run`
 * waits for its answer, `spawn` leaves it working in the background and has
 * its outcome delivered to the conversation later; the other actions look in
 * on one, wait for one, stop one, give one more work, or list the models one
 * can be given. A call that names no action is a run, as the tool always was.
 */
export const TaskTool: ToolDefinition = {
  name: "task",
  description: [
    "Hand work to subagents: conversations of their own, with their own history and tools. The action field picks what to do.",
    "",
    "- spawn (the usual choice): start a subagent in the background and get its subagent_id straight away. You keep working while it runs, and several can run at once. When it finishes, fails, is cancelled or seems stuck, a notification arrives in this conversation, and if you have already finished your reply it starts a new turn. Needs description, prompt and subagent_type; model is optional.",
    "- run: start a subagent and wait for its final message, which comes back as this call's result. It holds up this turn, so keep it for a short lookup whose answer you need before you can decide anything else. Needs description, prompt and subagent_type; model and timeout_ms (default 600000) are optional. A call without an action is a run.",
    "- status: where a subagent stands, without waiting. Needs subagent_id.",
    "- wait: wait until a subagent is idle and get its result, or a timeout status after timeout_ms (default 600000). Needs subagent_id. Only wait when you have nothing else to do until it answers.",
    "- cancel: stop a running subagent. Needs subagent_id; cancelling one that is idle changes nothing.",
    "- send: give a subagent more work. The message joins its own history, so it keeps everything it has done, and an idle subagent takes another turn; you are notified when that turn ends. Needs subagent_id and message.",
    "- models: list the models a subagent can be given through model. vision: true lists only models that read images; limit caps the list (default 50).",
    "",
    "A new subagent knows nothing of this conversation: the prompt is all it has, so say what to do, where to look, what is already known and what to report back. The user does not see its answer until you pass on what matters.",
    'Use "explore" for work that only reads - finding code, tracing a behaviour, answering a question about the project - and "general" for work that may change files or run commands. Do not use this for a single quick lookup you can do yourself.',
  ].join("\n"),
  parameters: {
    type: "object",
    properties: {
      action: { type: "string", enum: [...SUBAGENT_ACTIONS], description: "What to do; spawn unless you must wait for the answer in this turn" },
      description: { type: "string", description: "run, spawn: a short name for the task, three to six words, shown to the user" },
      prompt: { type: "string", description: "run, spawn: the complete instructions for the subagent" },
      subagent_type: {
        type: "string",
        enum: [...SUBAGENT_TYPES],
        description: "run, spawn: explore only reads; general can also edit files and run commands",
      },
      model: { type: "string", description: "run, spawn: provider/model to use instead of this conversation's model; see the models action" },
      subagent_id: { type: "string", description: "status, wait, cancel, send: the subagent_id that spawn or run returned, such as explore-1" },
      message: { type: "string", description: "send: the follow-up for the subagent" },
      timeout_ms: { type: "number", description: "run, wait: how long to wait, in milliseconds" },
      vision: { type: "boolean", description: "models: only models that read images" },
      limit: { type: "number", description: "models: at most this many" },
    },
    additionalProperties: false,
  },
  async execute(input, context) {
    const control = context.subagents
    if (!control) throw new ToolError("A subagent cannot start or manage subagents of its own.")
    const action = taskAction(input)
    const text = (value: unknown) => (typeof value === "string" ? value.trim() : "")
    const count = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined)

    if (action === "run" || action === "spawn") {
      const description = text(input.description)
      const prompt = text(input.prompt)
      if (!prompt) throw new ToolError("The prompt is empty, so there is nothing to hand over.")
      const type = input.subagent_type === "explore" ? "explore" : "general"
      const model = text(input.model) || undefined
      return action === "run" ? control.run({ description, prompt, type, model }, count(input.timeout_ms)) : control.spawn({ description, prompt, type, model })
    }
    if (action === "models") return control.models({ vision: input.vision === true, limit: count(input.limit) })

    const target = taskTarget(input)
    if (!target) throw new ToolError(`The ${action} action needs the subagent_id that spawn or run returned.`)
    if (action === "status") return control.status(target)
    if (action === "wait") return control.wait(target, count(input.timeout_ms))
    if (action === "cancel") return control.cancel(target)
    const message = text(input.message)
    if (!message) throw new ToolError("The message is empty, so there is nothing to send.")
    return control.send(target, message)
  },
}
