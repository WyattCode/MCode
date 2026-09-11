import type { Message } from "@shared/protocol"
import { estimateTokens } from "./overflow"

/**
 * What a compaction asks the model for, and how the conversation is put in
 * front of it. The reference's `SessionCompaction` - its template, its
 * instructions, its serializer and its split - kept as they stand.
 *
 * The shape matters more than the wording. MCode used to replay the whole
 * transcript as a live conversation with a one-line system prompt on top, and
 * a model shown 230k tokens of work in progress does the natural thing: it
 * carries on. Both real compactions on the machine this was found on came
 * back as the next step of the task - "Let me grab the last few source-field
 * bounds...", "I'll check the GameCategory enum next" - and replaced hundreds
 * of messages of context with one sentence. The reference quotes the
 * conversation as text inside a single user message and puts the instruction
 * after it, so the last thing the model reads is what to write.
 */

/** The reference's `DEFAULT_KEEP_TOKENS`: how much of the recent end stays word for word. */
export const KEEP_RECENT_TOKENS = 8_000

/** The reference's `TOOL_OUTPUT_MAX_CHARS`. */
const TOOL_OUTPUT_MAX_CHARS = 2_000

/** The reference's `SUMMARY_TEMPLATE`, verbatim. */
const SUMMARY_TEMPLATE = `Output exactly the Markdown structure shown inside <template> and keep the section order unchanged. Do not include the <template> tags in your response.
<template>
## Objective
- [one or two brief sentences describing what the user is trying to accomplish]

## Important Details
- [constraints/preferences, decisions and why, important facts/assumptions, exact context needed to continue, or "(none)"]

## Work State
### Completed
- [finished work, verified facts, or changes made; otherwise "(none)"]

### Active
- [current work, partial changes, or investigation state; otherwise "(none)"]

### Blocked
- [blockers, failing commands, or unknowns; otherwise "(none)"]

## Next Move
1. [immediate concrete action, or "(none)"]
2. [next action if known, or "(none)"]

## Relevant Files
- [file or directory path: why it matters, or "(none)"]
</template>

Rules:
- Keep every section, even when empty.
- Use terse bullets, not prose paragraphs.
- Preserve exact file paths, symbols, commands, error strings, URLs, and identifiers when known.
- Do not mention the summary process or that context was compacted.`

/** The reference's `SUMMARY_UPDATE_INSTRUCTIONS`, verbatim. */
const SUMMARY_UPDATE_INSTRUCTIONS = `The <prior-summary> summarizes everything that happened before the <conversation>. Construct a new summary that combines both. The <prior-summary> is discarded after this: anything you do not carry into the new summary is lost.

When combining:
- Carry forward objectives, constraints, user directives, decisions, and parallel workstreams from the <prior-summary> even when the <conversation> does not mention them. Drop only what is finished and no longer needed.
- The <conversation> is more recent than the <prior-summary>. Where they conflict, the conversation wins: state the corrected fact and drop the old claim.
- Add new progress, decisions, constraints, and context from the conversation.
- Move completed work from "Active" to "Completed".
- If a blocker has been resolved, update the summary to reflect that while keeping any details still needed to continue the work.
- Update "Objective" and "Next Move" to reflect the current work state.`

/** The reference's `truncate`. */
function truncate(value: string): string {
  return value.length <= TOOL_OUTPUT_MAX_CHARS ? value : `${value.slice(0, TOOL_OUTPUT_MAX_CHARS)}\n[truncated]`
}

/** The reference's `serialize`, over MCode's message shapes. */
export function serialize(message: Message): string {
  if (message.role === "user") {
    const files = message.attachments.map((file) => `[Attached ${file.mime}: ${file.path}]`)
    return [`[User]: ${message.text}`, ...files].join("\n")
  }
  return message.parts
    .flatMap((part) => {
      if (part.type === "text") return [`[Assistant]: ${part.text}`]
      if (part.type === "reasoning") return part.text ? [`[Assistant reasoning]: ${part.text}`] : []
      if (part.type !== "tool") return []
      const call = `[Assistant tool call]: ${part.name}(${JSON.stringify(part.input ?? {})})`
      if (part.status === "completed") return [call, `[Tool result]: ${truncate(part.output ?? "")}`]
      if (part.status === "error") return [call, `[Tool error]: ${part.error ?? ""}`]
      return [call]
    })
    .join("\n")
}

/**
 * The reference's `select`: the recent end of the conversation, up to
 * `KEEP_RECENT_TOKENS`, stays word for word after the summary, and everything
 * before it is what the summary covers.
 *
 * `mark` is the last message the summary covers - the one the compaction
 * records, so the model's view afterwards is the summary followed by the kept
 * end. When the whole conversation fits inside the kept end the reference
 * declines to compact; here that is answered by summarising all of it,
 * because a refusal after a provider has already rejected the request for
 * length leaves the turn with nowhere to go.
 */
export function selectForSummary(
  messages: Message[],
  keep = KEEP_RECENT_TOKENS,
): { head: string; recent: string; mark: Message } | undefined {
  const rendered = messages.map((message, index) => ({ index, text: serialize(message) })).filter((entry) => entry.text)
  if (rendered.length === 0) return undefined

  let total = 0
  let split = rendered.length
  for (let at = rendered.length - 1; at >= 0; at--) {
    const next = total + estimateTokens(rendered[at].text.length)
    if (next > keep) break
    total = next
    split = at
  }

  if (split === 0) {
    return {
      head: rendered.map((entry) => entry.text).join("\n\n"),
      recent: "",
      mark: messages[messages.length - 1],
    }
  }
  return {
    head: rendered
      .slice(0, split)
      .map((entry) => entry.text)
      .join("\n\n"),
    recent: rendered
      .slice(split)
      .map((entry) => entry.text)
      .join("\n\n"),
    // The message just before the first one kept, in the unfiltered list, so
    // a message that serialises to nothing is never stranded on either side.
    mark: messages[rendered[split].index - 1],
  }
}

/** The reference's `buildPrompt`. */
export function buildSummaryPrompt(input: { previousSummary?: string; context: string[] }): string {
  const conversation = `Here is the conversation so far:\n\n<conversation>\n${input.context.join("\n\n")}\n</conversation>`
  if (!input.previousSummary) {
    return [
      conversation,
      "Create a new anchored summary from the conversation history in the <conversation> tags above so another coding agent can continue the work.",
      SUMMARY_TEMPLATE,
    ].join("\n\n")
  }
  return [
    conversation,
    `Here is the summary of the conversation before the <conversation> above:\n\n<prior-summary>\n${input.previousSummary}\n</prior-summary>`,
    SUMMARY_UPDATE_INSTRUCTIONS,
    SUMMARY_TEMPLATE,
  ].join("\n\n")
}

/**
 * Whether a reply is a summary at all.
 *
 * Not in the reference, which trusts any non-empty reply. It is here because
 * the failure it catches is the one that was seen: a model that continues the
 * task instead of summarising it returns a sentence, and accepting that
 * replaces the whole conversation with it - silently, with nothing on screen
 * to say the context is gone. The template's first heading is the cheapest
 * sign the instruction was followed; a reply without it is refused, and the
 * provider's own rejection of the original request stands instead.
 */
export function isSummary(text: string): boolean {
  return /^\s*##\s*Objective\b/m.test(text)
}
