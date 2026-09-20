import { SUBAGENT_TYPES, type Message } from "@shared/protocol"
import { SUBAGENT_ACTIONS, actorAction, actorTarget, operationInput } from "@shared/subagent"
import type { ToolDefinition } from "./types"
import { ToolError } from "./types"

/** subagents: the tool a subagent asked for structured output ends with, under MiMo's name. */
export const STRUCTURED_OUTPUT = "StructuredOutput"

/** How many times a subagent that ended without it is reminded, as MiMo retries. */
export const STRUCTURED_RETRIES = 2

/** What a subagent that ended without its structured result is told. */
export const STRUCTURED_REMINDER = `You have not returned your result yet. Call ${STRUCTURED_OUTPUT} now, once, with an object that matches its parameters.`

/**
 * The tool a subagent returns structured output through: its parameters are
 * the schema it was given, so the arguments are checked against it before the
 * call counts. A schema that is not an object is wrapped under `result`.
 */
export function structuredOutputTool(schema: Record<string, unknown>): ToolDefinition {
  const wrapped = schema.type !== "object"
  return {
    name: STRUCTURED_OUTPUT,
    description: "Return this task's result as data. Call it once, when the work is done, with an object that matches these parameters; it is your whole answer.",
    parameters: wrapped ? { type: "object", properties: { result: schema }, required: ["result"] } : schema,
    async execute(input) {
      return { output: "Result recorded.", title: STRUCTURED_OUTPUT, metadata: { structured: wrapped ? input.result : input } }
    },
  }
}

/** The structured result a subagent returned since it was last given work, if it did. */
export function structuredResult(messages: readonly Message[]): unknown {
  // A reminder - to return the result, or from the completion gate - does not start new work.
  const since = messages.map((message) => message.role === "user" && !message.synthetic && message.text !== STRUCTURED_REMINDER).lastIndexOf(true)
  for (const message of messages.slice(since + 1).reverse()) {
    if (message.role !== "assistant") continue
    for (const part of [...message.parts].reverse()) {
      if (part.type === "tool" && part.name === STRUCTURED_OUTPUT && part.status === "completed" && part.metadata && "structured" in part.metadata) {
        return part.metadata.structured
      }
    }
  }
  return undefined
}

/**
 * subagents: MiMo's actor tool, under its name and in this app's own words.
 *
 * A subagent is a conversation of its own, with its own history and tools,
 * started and kept by the session runner (`ToolContext.subagents`). `run`
 * waits for its answer, `spawn` leaves it working in the background and has
 * its outcome delivered to the conversation later; the other actions look in
 * on one, wait for one, stop one, give one more work, or list the models one
 * can be given. A call that names no action is a run, as the tool always was.
 */
export const ActorTool: ToolDefinition = {
  name: "actor",
  description: [
    "Hand work to subagents: conversations of their own, with their own history and tools. Pass the action and its fields inside an operation object.",
    "",
    "- spawn (the usual choice): start a subagent in the background and get its actor_id straight away. You keep working while it runs, and several can run at once. When it finishes, fails, is cancelled or seems stuck, a notification arrives in this conversation, and if you have already finished your reply it starts a new turn. Needs description, prompt and subagent_type; model, task_id, output_schema and command are optional.",
    "- run: start a subagent and wait for its final message, which comes back as this call's result. It holds up this turn, so keep it for a short lookup whose answer you need before you can decide anything else. Needs description, prompt and subagent_type; model, timeout_ms (default 600000), task_id, output_schema and command are optional. A call without an action is a run.",
    "- status: where a subagent stands, without waiting. Needs actor_id.",
    "- wait: wait until a subagent is idle and get its result, or a timeout status after timeout_ms (default 600000). Needs actor_id. Only wait when you have nothing else to do until it answers.",
    "- cancel: stop a running subagent. Needs actor_id; cancelling one that is idle changes nothing.",
    "- send: give a subagent more work. The message joins its own history, so it keeps everything it has done, and an idle subagent takes another turn; you are notified when that turn ends. Needs to_actor_id and content.",
    "- models: list the models a subagent can be given through model. vision: true lists only models that read images; limit caps the list (default 50).",
    "",
    "A new subagent knows nothing of this conversation: the prompt is all it has, so say what to do, where to look, what is already known and what to report back. The user does not see its answer until you pass on what matters.",
    'Use "explore" for work that only reads - finding code, tracing a behaviour, answering a question about the project - and "general" for work that may change files or run commands. Do not use this for a single quick lookup you can do yourself.',
    "actor_id values (explore-1, general-2) are subagents; they are not the T1, T1.2 ids of the task tool.",
    'Examples: {"operation":{"action":"spawn","description":"Find the config loader","prompt":"...","subagent_type":"explore"}} {"operation":{"action":"wait","actor_id":"explore-1"}}',
    "",
    /*
     * The agent types, and what each may do. MiMo composes this list at request
     * time because its agent types are configurable; MCode's are these two and
     * nothing else, so naming them here says the same thing without making the
     * tool list depend on the turn.
     */
    "Available agent types and what each one may do:",
    "- explore: reads only. It has read, glob, grep, list, webfetch and bash, and every tool that changes a file is refused to it. Use it to find where something lives, trace how a behaviour works, or answer a question about the project. Because it cannot change anything, it needs no permission from the user and is the cheaper of the two.",
    "- general: the same reading tools plus edit, write and the rest, so it can change files and run commands that do. Use it when the task is to make a change, not to find something out. Its writes and commands are put to the user under the same permission rules as your own.",
    "Neither can start subagents of its own, and neither can message another conversation.",
  ].join("\n"),
  parameters: {
    type: "object",
    properties: {
      operation: {
        type: "object",
        description: "What to do, and its fields",
        properties: {
          action: { type: "string", enum: [...SUBAGENT_ACTIONS], description: "What to do; spawn unless you must wait for the answer in this turn" },
          description: { type: "string", description: "run, spawn: a short name for the task, three to five words, shown to the user" },
          prompt: { type: "string", description: "run, spawn: the complete instructions for the subagent" },
          subagent_type: {
            type: "string",
            enum: [...SUBAGENT_TYPES],
            description: "run, spawn: explore only reads; general can also edit files and run commands",
          },
          model: { type: "string", description: "run, spawn: provider/model to use instead of this conversation's model; see the models action" },
          task_id: {
            type: "string",
            description:
              "run, spawn: the id of the task tool's task this subagent works on (T1, T2.1), when it works on one; an id the task tool has not returned in this conversation is dropped and the call says so. A subagent given one has to leave a record of its work on that task before it can finish, and is sent back for it if it does not.",
          },
          output_schema: {
            type: "object",
            description: "run, spawn: a JSON Schema; the subagent then ends by returning one object that matches it, and that object is its result instead of prose",
          },
          command: { type: "string", description: "run, spawn: the slash command that started this work, if one did" },
          actor_id: { type: "string", description: "status, wait, cancel: the actor_id that spawn or run returned, such as explore-1" },
          to_actor_id: { type: "string", description: "send: the actor_id of the subagent to send to" },
          content: { type: "string", description: "send: the follow-up for the subagent" },
          timeout_ms: { type: "number", description: "run, wait: how long to wait, in milliseconds" },
          vision: { type: "boolean", description: "models: only models that read images" },
          limit: { type: "number", description: "models: at most this many" },
        },
        required: ["action"],
      },
    },
  },
  async execute(raw, context) {
    const control = context.subagents
    if (!control) throw new ToolError("A subagent cannot start or manage subagents of its own.")
    // MiMo's shape, or the same fields written flat, as MiMo also takes them.
    const input = operationInput(raw)
    const action = actorAction(input)
    const text = (value: unknown) => (typeof value === "string" ? value.trim() : "")
    const count = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined)

    if (action === "run" || action === "spawn") {
      const description = text(input.description)
      const prompt = text(input.prompt)
      // MiMo's run and spawn need all three; a missing type is no longer taken to mean general.
      const missing = [!description && "description", !prompt && "prompt", !text(input.subagent_type) && "subagent_type"].filter(Boolean)
      if (missing.length) throw new ToolError(`${action} needs ${missing.join(", ")}.`)
      if (!(SUBAGENT_TYPES as readonly unknown[]).includes(input.subagent_type)) {
        throw new ToolError(`Unknown subagent_type "${text(input.subagent_type)}"; use one of ${SUBAGENT_TYPES.join(", ")}, as the tool description lists them.`)
      }
      const schema = input.output_schema
      const spec = {
        description,
        prompt,
        type: input.subagent_type === "explore" ? ("explore" as const) : ("general" as const),
        model: text(input.model) || undefined,
        taskID: text(input.task_id) || undefined,
        command: text(input.command) || undefined,
        outputSchema: schema && typeof schema === "object" && !Array.isArray(schema) ? (schema as Record<string, unknown>) : undefined,
      }
      return action === "run" ? control.run(spec, count(input.timeout_ms)) : control.spawn(spec)
    }
    if (action === "models") return control.models({ vision: input.vision === true, limit: count(input.limit) })

    const target = actorTarget(input)
    if (!target) throw new ToolError(`The ${action} action needs the actor_id that spawn or run returned${action === "send" ? ", as to_actor_id" : ""}.`)
    if (action === "status") return control.status(target)
    if (action === "wait") return control.wait(target, count(input.timeout_ms))
    if (action === "cancel") return control.cancel(target)
    const content = text(input.content)
    if (!content) throw new ToolError("The content is empty, so there is nothing to send.")
    return control.send(target, content)
  },
}
