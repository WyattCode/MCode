import type { Permissions } from "../permission"
import type { Questions } from "./question"
import type { SessionChat } from "../session/chat"
import type { SkillInfo } from "../skill"
import type { TaskItem } from "@shared/protocol"

export interface ToolContext {
  sessionID: string
  messageID: string
  callID: string
  /** Project root for this session; every path a tool touches resolves under it. */
  directory: string
  permissions: Permissions
  /**
   * Where a tool parks a question it needs the reader to answer.
   *
   * Alongside `permissions` rather than inside it because the two ask different
   * things: a permission asks whether a call may run and has three fixed
   * answers, a question asks the reader to choose between options the model
   * wrote and can be skipped. The reference keeps them as two services for the
   * same reason.
   */
  questions: Questions
  signal: AbortSignal
  /** Streams partial output into the tool card while the tool is still running. */
  progress: (text: string) => void
  /**
   * Records a file's current contents before changing them.
   *
   * Called with an absolute path, before the write. Recording the same path
   * twice in a turn keeps the first reading - the state to go back to is the
   * one the turn started from, not the one the last edit started from.
   */
  snapshot: (target: string) => Promise<void>
  /**
   * The shell the user picked, if any.
   *
   * Passed down rather than read from config here so a tool stays a pure
   * function of its context - and so the setting is resolved once per turn
   * instead of once per call.
   */
  shell?: string
  /**
   * subagents: the actor tool's actions, bound to this call's conversation.
   * Absent inside a subagent, which cannot start or manage subagents of its own.
   */
  subagents?: SubagentControl
  /** session chat: messaging the other conversations. Absent inside a subagent. */
  chat?: SessionChat
  /** skills: every skill this conversation can reach, read fresh from disk. */
  skills?: () => Promise<SkillInfo[]>
  /** tasks: the conversation's task registry; a subagent's is its parent's. */
  tasks?: TaskControl
}

/** tasks: one change to a conversation's task list at a time, by whoever is asking. */
export interface TaskControl {
  update<T>(change: (list: TaskItem[], who: { owner: string; subagent: boolean }) => { list: TaskItem[]; result: T }): Promise<T>
}

/** subagents: what run and spawn ask for. */
export interface SubagentSpec {
  description: string
  prompt: string
  type: "general" | "explore"
  /** `provider/model`, or a model id only one configured provider has; absent takes the parent's. */
  model?: string
  /** The task registry's task it works on (T1, T2.1). */
  taskID?: string
  /** The slash command that started the work. */
  command?: string
  /** A JSON Schema its result must match; it then answers with StructuredOutput instead of prose. */
  outputSchema?: Record<string, unknown>
}

/** subagents: MiMo's actor actions, as the runner carries them out for one conversation. */
export interface SubagentControl {
  run(spec: SubagentSpec, timeoutMs?: number): Promise<ToolResult>
  spawn(spec: SubagentSpec): Promise<ToolResult>
  status(subagentID: string): Promise<ToolResult>
  wait(subagentID: string, timeoutMs?: number): Promise<ToolResult>
  cancel(subagentID: string): Promise<ToolResult>
  send(subagentID: string, message: string): Promise<ToolResult>
  models(options: { vision: boolean; limit?: number }): Promise<ToolResult>
}

export interface ToolResult {
  /** What goes back to the model as the tool_result content. */
  output: string
  /** One-liner for the collapsed card in the UI. */
  title?: string
  /** Structured payload the UI renders specially (diffs, match lists). */
  metadata?: Record<string, unknown>
}

export interface ToolDefinition {
  name: string
  description: string
  /** JSON Schema for the tool input, passed to the provider verbatim. */
  parameters: Record<string, unknown>
  /** Permission bucket; approvals are remembered per bucket. */
  permission?: string
  /** The MCP server an outside tool comes from; absent for this app's own tools. */
  server?: string
  execute(input: Record<string, unknown>, context: ToolContext): Promise<ToolResult>
}

/**
 * A failure the tool expected and can explain - a bad argument, a refused path,
 * a command that exited non-zero. Anything else is a defect and is reported as
 * one, so the two never get confused in the transcript.
 *
 * `code` names an i18n entry so the UI can say it in the user's language; the
 * message stays the English fallback, and is also what the model reads.
 */
export class ToolError extends Error {
  constructor(
    message: string,
    readonly code?: string,
    readonly params?: Record<string, string>,
  ) {
    super(message)
    this.name = "ToolError"
  }
}
