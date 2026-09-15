import type { ToolDefinition } from "./types"
import { ToolError } from "./types"

export interface Todo {
  id: string
  content: string
  status: "pending" | "in_progress" | "completed" | "cancelled"
}

/** Live todo list per session, mirrored into the UI's task strip. */
const todos = new Map<string, Todo[]>()

export function todosFor(sessionID: string): Todo[] {
  return todos.get(sessionID) ?? []
}

export const TodoWriteTool: ToolDefinition = {
  name: "todowrite",
  description:
    "Record the plan for a multi-step task and keep it current. Send the whole list every time - it replaces the previous one. Mark exactly one item in_progress while you work on it, and complete it before starting the next. Skip this for single-step work.",
  permission: "todowrite",
  parameters: {
    type: "object",
    properties: {
      todos: {
        type: "array",
        description: "The complete list, in the order the work will be done",
        items: {
          type: "object",
          properties: {
            id: { type: "string", description: "Stable identifier, kept across updates" },
            content: { type: "string", description: "Imperative description of the step" },
            status: { type: "string", enum: ["pending", "in_progress", "completed", "cancelled"] },
          },
          required: ["id", "content", "status"],
          additionalProperties: false,
        },
      },
    },
    required: ["todos"],
    additionalProperties: false,
  },
  async execute(input, context) {
    const list = (input.todos as Todo[]) ?? []
    if (!Array.isArray(list)) throw new ToolError("todos must be an array")
    todos.set(context.sessionID, list)

    const done = list.filter((todo) => todo.status === "completed").length
    const active = list.find((todo) => todo.status === "in_progress")
    return {
      output: list.length === 0 ? "Todo list cleared." : `${done}/${list.length} complete.`,
      title: active ? active.content : `${done}/${list.length} complete`,
      metadata: { todos: list },
    }
  },
}
