import type { ToolDefinition } from "./types"
import {
  CLAUDE_CODE_AGENT,
  CLAUDE_CODE_NAME,
  LIST_LIMIT_DEFAULT,
  LIST_LIMIT_MAX,
  READ_MESSAGES_DEFAULT,
  READ_MESSAGES_MAX,
  listExternalSessions,
  readExternalSession,
  type ExternalSessionSummary,
} from "../external-sessions"

/*
 * session chat: the two tools that look at another coding tool's own saved
 * conversations, as MiMo's session-chat set offers them beside the four that
 * reach this app's own.
 *
 * Both only read. What the model reads back is English, as MiMo's two are -
 * the four beside them speak Chinese because MiMo's do, and these do not.
 *
 * A folder that cannot be read, an id that names nothing, an argument that
 * does not fit: each comes back as a result the model reads rather than a
 * failed call, which is how MiMo answers all six.
 */

/** How much of a transcript one read hands back, past which the rest is left out. */
const OUTPUT_MAX = 60_000

const text = (value: unknown) => (typeof value === "string" ? value.trim() : "")

/** Whether the id names the one external agent this app can read. */
function isKnownAgent(agentID: string): boolean {
  return agentID === CLAUDE_CODE_AGENT
}

function unknownAgent(agentID: string): string {
  return `No external agent with id ${JSON.stringify(agentID)} can be read from here. The one this app reads is ${CLAUDE_CODE_NAME}, whose id is ${CLAUDE_CODE_AGENT}.`
}

const time = (value?: number) => (value ? new Date(value).toISOString() : "unknown")

function summaryLine(session: ExternalSessionSummary): string {
  return [
    `- session_id=${session.sessionID}`,
    `workspace=${session.project ?? "unknown"}`,
    `first_prompt=${JSON.stringify(session.firstPrompt || "(no readable user prompt)")}`,
    `started_at=${time(session.startedAt)}`,
    `updated_at=${time(session.updatedAt)}`,
    `message_count=${session.messageCount}`,
    ...(session.scanTruncated ? ["scan_truncated=true"] : []),
  ].join("; ")
}

export const ListExternalSessionsTool: ToolDefinition = {
  name: "list_external_sessions",
  description: [
    `List the conversations another coding tool on this machine has saved. ${CLAUDE_CODE_NAME} is the one that can be read, with agent_id ${CLAUDE_CODE_AGENT}.`,
    "Use it when the user asks what they did in that other tool, or where its conversations are kept. It reads that tool's own transcript files and nothing else - not its memory, not its settings.",
    "Only this conversation's project is looked at unless all_projects says otherwise, because a listing across every project on the machine is rarely what was meant.",
    "Each line gives a session_id to pass to read_external_session, the project it ran in, the first thing the user said, when it began and last changed, and how many messages it holds.",
  ].join("\n"),
  parameters: {
    type: "object",
    properties: {
      agent_id: { type: "string", description: `Which external agent to list, e.g. ${CLAUDE_CODE_AGENT}` },
      all_projects: { type: "boolean", description: "Look in every project on this machine rather than only this conversation's; only when the user asked for that" },
      limit: { type: "integer", description: `How many of the newest sessions to return, 1 to ${LIST_LIMIT_MAX}, ${LIST_LIMIT_DEFAULT} when left out` },
    },
    required: ["agent_id"],
    additionalProperties: false,
  },
  async execute(input, context) {
    const agentID = text(input.agent_id)
    if (!isKnownAgent(agentID)) return { output: unknownAgent(agentID), title: agentID || CLAUDE_CODE_AGENT }
    const everywhere = input.all_projects === true
    if (!everywhere && !context.directory) {
      return { output: "Cannot list them: this conversation has no project folder. Set all_projects to true only if the user asked to look across every project." }
    }
    const limit = input.limit === undefined ? undefined : Number(input.limit)
    const { sessions, truncated } = listExternalSessions({ project: everywhere ? undefined : context.directory, limit })
    const where = everywhere ? "any project on this machine" : `this project (${context.directory})`
    if (!sessions.length) {
      const note = truncated ? " The scan stopped at its size limit, so this empty answer may be incomplete." : ""
      return { output: `No ${CLAUDE_CODE_NAME} conversations were found for ${where}.${note}`, title: CLAUDE_CODE_NAME }
    }
    const note = truncated ? "\n[The scan stopped at its size limit, so this list is partial.]" : ""
    return {
      output: [
        `${CLAUDE_CODE_NAME} conversations for ${where} (${sessions.length}, newest first):`,
        ...sessions.map(summaryLine),
        `${note}Pass one of these session_id values to read_external_session to read it.`,
      ].join("\n"),
      title: `${CLAUDE_CODE_NAME} — ${sessions.length}`,
      metadata: { agent: agentID, count: sessions.length, truncated },
    }
  },
}

export const ReadExternalSessionTool: ToolDefinition = {
  name: "read_external_session",
  description: [
    `Read one conversation another coding tool on this machine saved. ${CLAUDE_CODE_NAME} is the one that can be read, with agent_id ${CLAUDE_CODE_AGENT}.`,
    "Call list_external_sessions first and pass a session_id exactly as it came back; an id you assembled yourself will not be found.",
    "Only what was said in words comes back. Set include_tools to true only when the user asked for the tool calls too: a transcript's tool arguments and results carry paths, code and sometimes credentials, and handing all of that over by default would be handing over more than was asked for.",
    "Only this conversation's project is looked at unless all_projects says otherwise.",
  ].join("\n"),
  parameters: {
    type: "object",
    properties: {
      agent_id: { type: "string", description: `Which external agent the session belongs to, e.g. ${CLAUDE_CODE_AGENT}` },
      session_id: { type: "string", description: "The id exactly as list_external_sessions gave it" },
      all_projects: { type: "boolean", description: "Look in every project on this machine rather than only this conversation's; only when the user asked for that" },
      include_tools: { type: "boolean", description: "Include the tool calls and their results as well as what was said; left out, only words come back" },
      max_messages: { type: "integer", description: `How many messages at most, 1 to ${READ_MESSAGES_MAX}, ${READ_MESSAGES_DEFAULT} when left out` },
    },
    required: ["agent_id", "session_id"],
    additionalProperties: false,
  },
  async execute(input, context) {
    const agentID = text(input.agent_id)
    if (!isKnownAgent(agentID)) return { output: unknownAgent(agentID), title: agentID || CLAUDE_CODE_AGENT }
    const sessionID = text(input.session_id)
    const everywhere = input.all_projects === true
    if (!everywhere && !context.directory) {
      return { output: "Cannot read it: this conversation has no project folder. Set all_projects to true only if the user asked to look across every project." }
    }
    const withTools = input.include_tools === true
    let found: ReturnType<typeof readExternalSession>
    try {
      found = readExternalSession({
        sessionID,
        project: everywhere ? undefined : context.directory,
        includeTools: withTools,
        maxMessages: input.max_messages === undefined ? undefined : Number(input.max_messages),
      })
    } catch {
      return {
        output: `The transcript for ${sessionID} does not say which project it belongs to within the size this app reads, so it could not be matched to this one. Retry with all_projects set to true if the user meant a session from elsewhere.`,
        title: sessionID,
      }
    }
    if (!found) {
      const where = everywhere ? "any project on this machine" : "this project"
      return { output: `No ${CLAUDE_CODE_NAME} conversation with id ${JSON.stringify(sessionID)} was found for ${where}. Call list_external_sessions to see which ids there are.`, title: sessionID }
    }

    const parts: string[] = []
    let spent = 0
    let cutHere = false
    for (const message of found.messages) {
      const label = message.role === "tool" ? `tool:${message.toolName ?? "unknown"}` : message.role
      const block = `[${time(message.at)}] ${label}\n${message.text}`
      if (spent + block.length > OUTPUT_MAX) {
        cutHere = true
        break
      }
      parts.push(block)
      spent += block.length
    }
    const note = found.truncated || cutHere ? "\n\n[Cut at the size limit; there is more in the transcript.]" : ""
    return {
      output: [
        `${CLAUDE_CODE_NAME} conversation ${sessionID} (${found.messages.length} readable messages, tool calls ${withTools ? "included" : "left out"}):`,
        "",
        parts.join("\n\n") || "(nothing readable)",
      ].join("\n") + note,
      title: sessionID,
      metadata: { agent: agentID, sessionID, messages: found.messages.length, includeTools: withTools, truncated: found.truncated || cutHere },
    }
  },
}
