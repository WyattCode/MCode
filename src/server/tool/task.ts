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

const FETCH_TIMEOUT = 30_000
const MAX_FETCH_BYTES = 400_000

/** Strips markup so the model gets prose instead of a wall of tags. */
function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<\/(p|div|section|article|li|h[1-6]|tr)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

/**
 * Reads at most `limit` bytes and drops the connection.
 *
 * response.text() buys the whole body first and only then truncates, so a URL
 * that streams without end - or simply serves something enormous - is read into
 * memory in full before a single byte is discarded.
 */
async function readCapped(response: Response, limit: number): Promise<{ body: string; truncated: boolean }> {
  const stream = response.body
  if (!stream) return { body: "", truncated: false }

  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let body = ""
  let read = 0
  let truncated = false

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      read += value.byteLength
      if (read >= limit) {
        const keep = value.subarray(0, value.byteLength - (read - limit))
        body += decoder.decode(keep)
        truncated = true
        break
      }
      body += decoder.decode(value, { stream: true })
    }
  } finally {
    await reader.cancel().catch(() => {})
  }

  return { body: truncated ? body : body + decoder.decode(), truncated }
}

export const WebFetchTool: ToolDefinition = {
  name: "webfetch",
  description:
    "Fetch a URL and return its text content, with HTML converted to readable prose. Use this to read documentation or an API reference the user pointed at.",
  permission: "webfetch",
  parameters: {
    type: "object",
    properties: {
      url: { type: "string", description: "Absolute http or https URL" },
      format: { type: "string", enum: ["text", "raw"], description: "text strips markup, raw returns the body as sent" },
    },
    required: ["url"],
    additionalProperties: false,
  },
  async execute(input, context) {
    const raw = String(input.url)
    let url: URL
    try {
      url = new URL(raw)
    } catch {
      throw new ToolError(`Not a valid URL: ${raw}`)
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new ToolError(`Only http and https URLs can be fetched, got ${url.protocol}`)
    }

    // Fetching is an outbound request on the user's network, so it is gated
    // like any other side effect.
    await context.permissions.ask({
      signal: context.signal,
      sessionID: context.sessionID,
      messageID: context.messageID,
      callID: context.callID,
      kind: "webfetch",
      title: "Fetch URL",
      subject: url.toString(),
    })

    const timeout = AbortSignal.timeout(FETCH_TIMEOUT)
    const signal = AbortSignal.any([timeout, context.signal])

    const response = await fetch(url, {
      signal,
      headers: { "user-agent": "MCode/0.1 (+https://github.com/)", accept: "text/html,text/plain,application/json,*/*" },
    }).catch((err: Error) => {
      throw new ToolError(`Request failed: ${err.message}`)
    })

    if (!response.ok) throw new ToolError(`HTTP ${response.status} ${response.statusText} from ${url.host}`)

    const contentType = response.headers.get("content-type") ?? ""
    const { body, truncated } = await readCapped(response, MAX_FETCH_BYTES)
    const text = input.format === "raw" || !contentType.includes("html") ? body : htmlToText(body)

    return {
      output: text + (truncated ? "\n\n(truncated)" : ""),
      title: url.host + url.pathname,
      metadata: { url: url.toString(), status: response.status, contentType },
    }
  },
}
