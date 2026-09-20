import { isAbsolute } from "node:path"
import { CHAT_TASK_STATUSES, type ChatTaskStatus } from "@shared/protocol"
import type { ChatContact } from "../session/chat"
import type { ToolContext, ToolDefinition } from "./types"
import { ToolError } from "./types"
import { resolvePath } from "./fs-util"

/*
 * session chat: the four tools a conversation uses to reach the others, as
 * MiMo's session-chat set offers them. The work is done by the runner's
 * `SessionChat`; these only read arguments and word the results.
 *
 * As MiMo's, a message that could not go, a session that could not be made and
 * the like come back as results the model reads, not as failed calls (T10-49),
 * and what the model reads is Chinese where MiMo's is (T10-55). The note for a
 * busy target that turned the call into an async one stays English, as MiMo's does.
 */

function chatOf(context: ToolContext) {
  if (!context.chat) throw new ToolError("子智能体不能给其他会话发消息。")
  return context.chat
}

const text = (value: unknown) => (typeof value === "string" ? value : undefined)
const shown = (value?: string) => value?.trim() || "未填写"

function contactLine(contact: ChatContact): string {
  return `- 「${contact.title}」 id=${contact.id} ${contact.busy ? "忙碌" : "空闲"}；用途=${shown(contact.purpose)}；工作目录=${contact.workspace}；当前任务=${shown(contact.task)}；任务状态=${shown(contact.taskStatus)}`
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
    if (!contacts.length) return { output: "通讯录里还没有别的会话，目前只有这一个。" }
    return { output: `通讯录（${contacts.length} 个会话，最近活跃的在前）：\n${contacts.map(contactLine).join("\n")}` }
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
    if (result.status === "replied") return { output: `「${result.title}」的回复：\n${result.reply}` }
    if (result.status === "queued") {
      return {
        output: result.busy
          ? "The session is busy, so the message was queued and this call switched to async. Do not send it again; the reply will arrive in this conversation as a marked message."
          : "消息已发出，没有等待回复。对方的回复稍后会以标明来源的消息出现在本会话里，在那之前请继续手上的工作。",
      }
    }
    if (result.status === "switched") {
      return {
        output:
          "No reply within 120 seconds, but the session is still working on it, so this call switched to async. Do not send it again; the reply will arrive in this conversation as a marked message.",
      }
    }
    // Stop ends the call the way it ends any other, so the step settles as stopped.
    if (result.status === "stopped") throw new ToolError("回复到达之前，这次调用已被停止。")
    if (result.status === "failed") return { output: `没有收到回复：${result.error}`, metadata: { delivered: false } }
    const candidates = result.candidates?.length ? `\n候选：\n${result.candidates.map(contactLine).join("\n")}` : ""
    return { output: `未送达：${result.error}${candidates}`, metadata: { delivered: false } }
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
    const workspace = text(input.workspace) ?? ""
    /*
     * A new conversation's workspace is its project root, and everything under
     * a project root is read and written without asking. So `create_session`
     * was a way past the sandbox with no question anywhere in it: a workspace
     * of C:\Users\<name> made a conversation that could be told - by the model,
     * or by text the model read somewhere - to go through the whole user
     * folder, and read, glob and grep would each call it inside the project.
     *
     * MiMo asks nothing here either (its renderer POSTs /session?directory= with
     * whatever came in), but the rest of this app does not leave a folder open
     * on the strength of a tool argument, so the folder goes through the same
     * question every path outside the project goes through: one inside this
     * conversation's project (or its repository) is ordinary, one outside asks
     * once and is then remembered for that folder.
     */
    if (isAbsolute(workspace)) await resolvePath(context, workspace)
    const made = await chatOf(context).create({
      name: text(input.name) ?? "",
      purpose: text(input.purpose) ?? "",
      workspace,
      task: text(input.task),
    })
    if (!made.ok) return { output: `会话没有创建：${made.error}`, metadata: { created: false } }
    return { output: `会话已创建：「${made.session.title}」 id=${made.session.id}`, metadata: { sessionID: made.session.id } }
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
      return { output: `会话资料没有更新：task_status 只能是 ${CHAT_TASK_STATUSES.join("、")} 之一。`, metadata: { updated: false } }
    }
    const changed = await chatOf(context).update({
      contactID: text(input.contact_id) ?? "",
      name: text(input.name),
      purpose: text(input.purpose),
      task: text(input.task),
      taskStatus: status as ChatTaskStatus | undefined,
    })
    if (!changed.ok) return { output: `会话资料没有更新：${changed.error}`, metadata: { updated: false } }
    return { output: `会话资料已更新：「${changed.session.title}」 id=${changed.session.id}` }
  },
}
