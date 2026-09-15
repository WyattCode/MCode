import { CHAT_TASK_STATUSES, type ChatTaskStatus } from "@shared/protocol"
import type { ChatContact } from "../session/chat"
import type { ToolContext, ToolDefinition } from "./types"
import { ToolError } from "./types"

/*
 * session chat: the four tools a conversation uses to reach the others, as
 * MiMo's session-chat set offers them. The work is done by the runner's
 * `SessionChat`; these only read arguments and word the results.
 */

function chatOf(context: ToolContext) {
  if (!context.chat) throw new ToolError("A subagent cannot message other sessions.")
  return context.chat
}

const text = (value: unknown) => (typeof value === "string" ? value : undefined)
const shown = (value?: string) => value?.trim() || "not set"

function contactLine(contact: ChatContact): string {
  return `- "${contact.title}" id=${contact.id} ${contact.busy ? "busy" : "idle"}; purpose=${shown(contact.purpose)}; workspace=${contact.workspace}; task=${shown(contact.task)}; status=${shown(contact.taskStatus)}`
}

export const ContactsTool: ToolDefinition = {
  name: "contacts",
  description: [
    "List the other conversations in this app that talk_to_session can reach, most recently active first.",
    "Each line gives the title, the contact id, whether it is busy, and the purpose, workspace, task and task status recorded for it.",
    "Use it to find a target you cannot name exactly, to read that record, or after talk_to_session could not tell which session you meant.",
    "When you already know the exact title or the id, message the session directly instead.",
  ].join(" "),
  parameters: {
    type: "object",
    properties: {
      explanation: { type: "string", description: "One short sentence on why you are looking" },
    },
    required: ["explanation"],
    additionalProperties: false,
  },
  async execute(_input, context) {
    const contacts = await chatOf(context).contacts(context.sessionID)
    if (!contacts.length) return { output: "There is no other session to message yet; this is the only one." }
    return { output: `Contacts (${contacts.length}, most recently active first):\n${contacts.map(contactLine).join("\n")}` }
  },
}

export const TalkToSessionTool: ToolDefinition = {
  name: "talk_to_session",
  description: [
    "Send a message to another conversation in this app. It appears there, visible to the user and marked as coming from this conversation, and runs a real turn; that turn's final message is the reply.",
    "Use it when the user asks you to consult, coordinate with or pass something on to another conversation, or when another conversation holds context this work needs.",
    "Do not use it for one-off helper work that belongs to no other conversation; the task tool is for that.",
    "The other conversation has its own history and cannot see this one, so make the message complete on its own.",
    "Name the target by its exact title in contact, or by contact_id. If a title fits several sessions you are given candidates; retry with one's contact_id.",
    'mode "sync" (the default) waits up to 120 seconds for the reply when the target is free. If the target is busy the message is queued and the call returns at once as async: do not send it again.',
    'mode "async" always returns at once, and the reply arrives in this conversation later as a marked message.',
    "Chains of calls between sessions stop after 5 hops, and a session cannot message itself. Tell the user plainly when a call is refused.",
  ].join(" "),
  parameters: {
    type: "object",
    properties: {
      contact: { type: "string", description: "The target session's exact title" },
      contact_id: { type: "string", description: "The target session's contact id; used instead of contact when given" },
      message: { type: "string", description: "What to say, complete on its own" },
      mode: { type: "string", enum: ["sync", "async"], description: "sync waits for the reply; async returns at once" },
    },
    required: ["message"],
    additionalProperties: false,
  },
  async execute(input, context) {
    const result = await chatOf(context).talk({
      from: context.sessionID,
      contact: text(input.contact),
      contactID: text(input.contact_id),
      message: text(input.message) ?? "",
      mode: input.mode === "async" ? "async" : "sync",
      signal: context.signal,
    })
    if (result.status === "replied") return { output: `Reply from "${result.title}":\n${result.reply}` }
    if (result.status === "queued") {
      return {
        output: result.busy
          ? "The session is busy, so the message was queued and this call switched to async. Do not send it again; the reply will arrive in this conversation as a marked message."
          : "Sent without waiting. The reply will arrive in this conversation later as a marked message; carry on until then.",
      }
    }
    if (result.status === "switched") {
      return {
        output:
          "No reply within 120 seconds, but the session is still working on it, so this call switched to async. Do not send it again; the reply will arrive in this conversation as a marked message.",
      }
    }
    if (result.status === "stopped") throw new ToolError("Stopped before the reply arrived.")
    if (result.status === "failed") throw new ToolError(`No reply: ${result.error}`)
    const candidates = result.candidates?.length ? `\nCandidates:\n${result.candidates.map(contactLine).join("\n")}` : ""
    throw new ToolError(`Not delivered: ${result.error}${candidates}`)
  },
}

export const CreateSessionTool: ToolDefinition = {
  name: "create_session",
  description: [
    "Create a new conversation in this app and record what it is for. It is a real conversation the user sees in the side column, with its own history.",
    "Only create one when the user asks for it, or when work genuinely has to go on in a separate conversation and no suitable one exists; the task tool is for one-off delegated work.",
    "workspace must be an existing absolute folder: do not guess it or silently reuse this conversation's.",
    "The new conversation does nothing until it is sent a message with talk_to_session.",
  ].join(" "),
  parameters: {
    type: "object",
    properties: {
      name: { type: "string", description: "The conversation's title" },
      purpose: { type: "string", description: "What the conversation is responsible for" },
      workspace: { type: "string", description: "The absolute path of an existing folder it works in" },
      task: { type: "string", description: "Its first task, if there is one" },
    },
    required: ["name", "purpose", "workspace"],
    additionalProperties: false,
  },
  async execute(input, context) {
    const made = await chatOf(context).create({
      name: text(input.name) ?? "",
      purpose: text(input.purpose) ?? "",
      workspace: text(input.workspace) ?? "",
      task: text(input.task),
    })
    if (!made.ok) throw new ToolError(`The session was not created: ${made.error}`)
    return { output: `Created the session "${made.session.title}" id=${made.session.id}`, metadata: { sessionID: made.session.id } }
  },
}

export const UpdateSessionTool: ToolDefinition = {
  name: "update_session",
  description: [
    "Change a conversation's title, or the purpose, task and task status recorded for it.",
    "Take the contact id from contacts. An empty purpose or task clears it. task_status is one of idle, working, blocked or done.",
  ].join(" "),
  parameters: {
    type: "object",
    properties: {
      contact_id: { type: "string", description: "The session's contact id" },
      name: { type: "string", description: "A new title" },
      purpose: { type: "string", description: "What the conversation is responsible for" },
      task: { type: "string", description: "What it is working on now" },
      task_status: { type: "string", enum: [...CHAT_TASK_STATUSES], description: "How that task stands" },
    },
    required: ["contact_id"],
    additionalProperties: false,
  },
  async execute(input, context) {
    const status = text(input.task_status)
    if (status !== undefined && !(CHAT_TASK_STATUSES as readonly string[]).includes(status)) {
      throw new ToolError(`task_status must be one of ${CHAT_TASK_STATUSES.join(", ")}.`)
    }
    const changed = await chatOf(context).update({
      contactID: text(input.contact_id) ?? "",
      name: text(input.name),
      purpose: text(input.purpose),
      task: text(input.task),
      taskStatus: status as ChatTaskStatus | undefined,
    })
    if (!changed.ok) throw new ToolError(`The session was not updated: ${changed.error}`)
    return { output: `Updated the session "${changed.session.title}" id=${changed.session.id}` }
  },
}
