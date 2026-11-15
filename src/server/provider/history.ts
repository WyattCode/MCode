import type { AssistantMessage, AssistantPart, Attachment, Message, ModelModalities, ToolPart, UserMessage } from "@shared/protocol"

/**
 * The stored transcript as MiMo shapes it for a provider, in the request only.
 *
 * Every adapter reads its history through this, so the three wire formats
 * agree on the same three rules:
 *
 *  - a tool call that never finished - the turn was stopped, or the app closed
 *    under it - is answered as interrupted rather than dropped, so the model
 *    still sees what it had asked for;
 *  - a user message with nothing to send says "Continue." instead of vanishing;
 *  - a conversation that ends on the model's own words, with no call waiting
 *    on a result, gets a trailing "Continue." from the user, since a request
 *    ending on an assistant message is a prefill to some providers;
 *  - a reply the output limit cut while it was only thinking is sent as where
 *    that thinking had got to (`thoughtDigest`), not dropped as empty.
 */

/** What a call that never finished reads as to the model. */
export const INTERRUPTED_RESULT = "[Tool execution was interrupted]"

/** What a call left unfinished is stored as once the next prompt settles it. */
export const ABORTED_TOOL = "Tool execution aborted"

const CONTINUE = "Continue."

/** How much of a cut-off thinking goes back to the model: some of its opening, more of where it had got to. */
const THOUGHT_HEAD = 1_500
const THOUGHT_TAIL = 6_000

/**
 * A model never reads its own thinking back - providers drop it from the
 * history - so a reply cut at the output limit while it was still thinking
 * looked empty, and the next step planned the whole thing again from nothing.
 * Its opening and the end it reached go back as the reply's text instead, in
 * the request only (reminders.ts THOUGHT_LENGTH_NOTE says to act on it).
 */
export function thoughtDigest(thinking: string): string {
  const text = thinking.trim()
  const kept = text.length <= THOUGHT_HEAD + THOUGHT_TAIL ? text : `${text.slice(0, THOUGHT_HEAD)}\n[…]\n${text.slice(-THOUGHT_TAIL)}`
  return `[My thinking so far - cut off at the output limit before I wrote anything]\n${kept}`
}

/** A reply that reached the output limit with only thinking in it. */
function cutWhileThinking(message: AssistantMessage): boolean {
  return (
    message.finish === "max_tokens" &&
    !message.parts.some((part) => part.type === "tool" || (part.type === "text" && part.text.trim() !== "")) &&
    message.parts.some((part) => part.type === "reasoning" && part.text.trim() !== "")
  )
}

function unfinished(part: ToolPart): boolean {
  return part.status === "pending" || part.status === "running"
}

/** A call stored as interrupted that had already produced output hands the model that output. */
function interruptedWithOutput(part: ToolPart): boolean {
  return part.status === "error" && part.metadata?.interrupted === true && typeof part.output === "string" && part.output !== ""
}

function settled(part: AssistantPart): AssistantPart {
  if (part.type !== "tool") return part
  if (unfinished(part)) return { ...part, status: "error", error: INTERRUPTED_RESULT }
  if (interruptedWithOutput(part)) return { ...part, status: "completed" }
  return part
}

function sendable(message: UserMessage): boolean {
  return Boolean(message.text.trim() || message.attachments?.length || message.annotations?.length)
}

/** Whether an assistant message says anything or asks for anything. */
function spoken(message: AssistantMessage): boolean {
  return message.parts.some((part) => (part.type === "text" && part.text.trim() !== "") || part.type === "tool")
}

/** The word a note uses for one kind of attachment. */
const MEDIA_WORD = { image: "image", pdf: "PDF" } as const

type UnsupportedMedia = keyof typeof MEDIA_WORD

/** Whether a file is a picture or a PDF, the two kinds a model's `inputs` decides by name here. */
function mediaOf(file: Attachment): UnsupportedMedia | undefined {
  if (file.mime.startsWith("image/")) return "image"
  if (file.mime === "application/pdf") return "pdf"
  return undefined
}

function mediaNote(file: Attachment, media: UnsupportedMedia): string {
  const name = file.path.split(/[\\/]/).pop() || file.path
  return `[${name} was attached, but this model cannot read ${MEDIA_WORD[media]} input, so the file was not sent. Tell the user it could not be read.]`
}

/** Replaces a file the target model cannot read with the one line the model reads instead. */
function replacedFile(file: Attachment, media: UnsupportedMedia): Attachment {
  // `byPath` and `copy` go with the payload: nothing may load or send this file later.
  return { path: file.path, mime: file.mime, data: "", byPath: false, note: mediaNote(file, media) }
}

function replaceUnsupported(files: Attachment[] | undefined, inputs: Partial<ModelModalities>): Attachment[] | undefined {
  if (!files?.length) return files
  let changed = false
  const out = files.map((file) => {
    // A loader's own note already stands in for the file; keep the more specific reason.
    if (file.note) return file
    const media = mediaOf(file)
    if (!media || inputs[media]) return file
    changed = true
    return replacedFile(file, media)
  })
  return changed ? out : files
}

/**
 * Replaces every picture and PDF the target model cannot read with a line of
 * text saying so, across the whole transcript.
 *
 * `read` already refuses to attach media the conversation's model cannot take,
 * but a conversation that changes model keeps its old attachments. A provider
 * hands those history records straight to the wire, where an unsupported image
 * is a failed request rather than a note - so the substitution has to happen
 * here, for every message, before an adapter writes it. `byPath` and `copy`
 * are cleared with the bytes, so nothing loads the file again for a request
 * that cannot carry it.
 */
export function unsupportedAttachments(messages: Message[], inputs: Partial<ModelModalities>): Message[] {
  return messages.map((message) => {
    if (message.role === "user") {
      const current = message.attachments ?? []
      const attachments = replaceUnsupported(current, inputs) ?? current
      return attachments === current ? message : { ...message, attachments }
    }
    let changed = false
    const parts = message.parts.map((part) => {
      if (part.type !== "tool") return part
      const attachments = replaceUnsupported(part.attachments, inputs)
      if (attachments === part.attachments) return part
      changed = true
      return { ...part, attachments }
    })
    return changed ? { ...message, parts } : message
  })
}

export function requestHistory(messages: Message[], inputs?: Partial<ModelModalities>): Message[] {
  const out: Message[] = messages.map((message) => {
    if (message.role === "user") return sendable(message) ? message : { ...message, text: CONTINUE }
    if (cutWhileThinking(message)) {
      const thinking = message.parts.map((part) => (part.type === "reasoning" ? part.text : "")).join("\n")
      return { ...message, parts: [{ type: "text", text: thoughtDigest(thinking) }] as AssistantPart[] }
    }
    if (!message.parts.some((part) => part.type === "tool" && (unfinished(part) || interruptedWithOutput(part)))) return message
    return { ...message, parts: message.parts.map(settled) }
  })

  // A trailing reply with nothing in it is dropped; one with words but no calls is answered.
  while (out.length) {
    const last = out[out.length - 1]!
    if (last.role !== "assistant" || spoken(last)) break
    out.pop()
  }
  const last = out[out.length - 1]
  if (last?.role === "assistant" && !last.parts.some((part) => part.type === "tool")) {
    out.push({ id: `${last.id}:continue`, sessionID: last.sessionID, role: "user", text: CONTINUE, attachments: [], time: { created: last.time.created } })
  }
  // MiMo does this after the transcript is shaped, so a note it synthesises is not mistaken for the user's own file.
  return inputs ? unsupportedAttachments(out, inputs) : out
}
