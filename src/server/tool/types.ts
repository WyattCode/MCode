import type { Permissions } from "../permission"
import type { Questions } from "./question"

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
   * subagents: starts a subagent for this call and settles with its answer.
   * Absent inside a subagent, which cannot start subagents of its own.
   */
  subagents?: (spec: SubagentSpec) => Promise<ToolResult>
}

/** subagents: what the task tool asks for. */
export interface SubagentSpec {
  description: string
  prompt: string
  type: "general" | "explore"
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
