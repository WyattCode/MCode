import type { Message } from "@shared/protocol"

/**
 * The plan a conversation is working to.
 *
 * What it has produced and what it has read live in @shared/session-files,
 * which the server reads too - the artifacts page answers for every stored
 * session, and both sides have to count a file as produced the same way.
 */
export { sessionFiles, projectRelative, fileKind } from "@shared/session-files"
export type { FileTouch, SessionFiles, FileKind } from "@shared/session-files"

/** One entry of the plan the todowrite tool records. */
export interface Todo {
  id: string
  content: string
  status: string
}

/**
 * The most recent plan in a conversation.
 *
 * Read from the transcript rather than asked for, because the tool's own result
 * carries it and the newest call is by definition the current plan - an earlier
 * one is a plan that has since been rewritten.
 */
export function latestTodos(messages: readonly Message[]): Todo[] {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    // Only an assistant turn runs tools; a user message has no parts at all.
    if (message?.role !== "assistant") continue
    const parts = message.parts
    for (let at = parts.length - 1; at >= 0; at -= 1) {
      const found = (parts[at] as { metadata?: { todos?: Todo[] } }).metadata?.todos
      if (found?.length) return found
    }
  }
  return []
}
