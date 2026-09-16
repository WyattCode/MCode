import type { Permissions } from "../permission"
import type { Questions } from "./question"
import type { SessionChat } from "../session/chat"
import type { ToolOutputs } from "./truncate"
import type { SkillInfo } from "../skill"
import type { Attachment, TaskItem } from "@shared/protocol"

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
  /** Where outputs the shared cap cut are saved; a tool may read those wherever the project is. */
  toolOutputs?: ToolOutputs
  /** skills: every skill this conversation can reach, read fresh from disk. */
  skills?: () => Promise<SkillInfo[]>
  /** tasks: the conversation's task registry; a subagent's is its parent's. */
  tasks?: TaskControl
  /**
   * plan: what planning allows this conversation, and how it ends.
   *
   * The write tools consult it before they change anything, and plan_exit uses
   * it to put the plan to the user. Absent only where no conversation stands
   * behind the call.
   */
  plan?: PlanControl
}

/** plan: the conversation's planning state, as the runner knows it. */
export interface PlanControl {
  /** The agent this turn began as; planning is read-only, building is not. */
  agent: string
  /**
   * The plan was approved while this turn was running, so the conversation is
   * already a building one and this turn is the last planning one. What is
   * refused here is refused only until the turn ends, and saying so is what
   * keeps a model from spending the rest of the turn retrying.
   */
  switched: boolean
  /** Where this conversation's plan is written, absolute. */
  file: string
  /** Whether planning may write this path: the plan folders, and nothing else. */
  writable(target: string): boolean
  /** plan_exit's Yes: the conversation becomes a building one and is told the plan was approved. */
  approve(): Promise<void>
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
  /**
   * Media this result hands to the model, as MiMo's tool results carry
   * attachments: a file by path, which is read when a request is built, or one
   * with its bytes for something that has no file (an MCP server's picture).
   * A model that cannot read the kind of file gets a line saying so instead,
   * so `output` still has to describe it.
   */
  attachments?: Attachment[]
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
