import type { AssistantMessage, Message, ProviderStatus, Usage } from "@shared/protocol"

/**
 * What a session has spent, and roughly on what.
 *
 * Two places ask this and they must not answer differently: the ring in the
 * session header, which says how full the model's context is, and the Context
 * view that the ring opens, which takes the same figure apart. Worked out
 * separately, the ring could show 41% beside a panel whose own sum came to
 * something else, and nothing on screen would tell the reader which of the two
 * to believe. So the arithmetic lives once, here, and both read it.
 */

/**
 * Every token a turn was charged for.
 *
 * The whole of it: what the model wrote and what it thought before writing are
 * carried into the next request just as the prompt is, so a count that leaves
 * them out is not the size of the context, it is the size of part of it.
 */
export function tokensOf(usage: Usage | undefined): number {
  if (!usage) return 0
  return usage.input + usage.output + usage.reasoning + usage.cacheRead + usage.cacheWrite
}

/**
 * The last turn that actually spent something.
 *
 * Not merely the last turn that arrived with a usage object attached: a turn
 * can finish with every count at zero - aborted before the provider answered,
 * or refused - and that message still carries usage. Taking it emptied the ring
 * on a conversation that was in fact nearly full, and the ring then filled
 * again on the next reply, which reads as a fault in the app rather than as the
 * truth about the session.
 */
export function lastSpendingTurn(messages: readonly Message[]): AssistantMessage | undefined {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]
    if (message.role !== "assistant") continue
    if (tokensOf(message.usage) <= 0) continue
    return message
  }
  return undefined
}

export interface ContextReading {
  /** The turn every figure below was read off. */
  message: AssistantMessage
  usage: Usage
  /** All five token figures added together. */
  used: number
  /** The model's advertised context window, where the app knows it. */
  window?: number
  /**
   * How much of that window the turn took, as a whole number.
   *
   * Deliberately not capped. A turn can be sent a context larger than the limit
   * the model advertises, and saying 118% is the only way the reader finds that
   * out; it is the ring drawn from this that has to stop at full.
   */
  percent?: number
  /** The provider's own name, falling back to the id the turn recorded. */
  provider: string
  /** Likewise the model's. */
  model: string
}

/**
 * How full the model's context is, read from the last turn that spent anything.
 *
 * Read from one turn rather than from the session's rolling totals: those add
 * every turn together and would pass 100% on a long conversation while the
 * context itself was nowhere near full.
 */
export function readContext(
  messages: readonly Message[],
  providers: readonly ProviderStatus[],
): ContextReading | undefined {
  const message = lastSpendingTurn(messages)
  if (!message?.usage) return undefined

  /*
   * The window belongs to the model that ran that turn, which is not
   * necessarily the one the session is set to now: the model can be changed
   * mid-conversation, and those tokens were spent against the old one's limit.
   */
  const provider = providers.find((entry) => entry.id === message.model.provider)
  const model = provider?.models.find((entry) => entry.id === message.model.model)
  const window = model?.contextWindow
  const used = tokensOf(message.usage)

  return {
    message,
    usage: message.usage,
    used,
    window,
    percent: window ? Math.round((used / window) * 100) : undefined,
    /*
     * The id rather than a dash when the provider is not in the list. A turn
     * run against a provider since disconnected still happened, and its name is
     * the only thing left that says which one it was.
     */
    provider: provider?.name ?? message.model.provider,
    model: model?.name ?? message.model.model,
  }
}

export type BreakdownKey = "system" | "user" | "assistant" | "tool" | "other"

export interface BreakdownSegment {
  key: BreakdownKey
  tokens: number
  /** Exact share of the input, for the width of a bar. */
  share: number
  /** The same share to one decimal, for the number beside the swatch. */
  percent: number
}

/**
 * Four characters to a token.
 *
 * A rule of thumb rather than a tokeniser: running a real one over an entire
 * transcript in the renderer would cost more than the answer is worth, and the
 * answer is a bar chart of proportions, not a bill. It is the same ratio the
 * reference uses for the same picture.
 */
const CHARS_PER_TOKEN = 4

const estimate = (chars: number): number => Math.ceil(chars / CHARS_PER_TOKEN)

/** What a user turn puts into the request, in characters. */
function userChars(message: Message): number {
  if (message.role !== "user") return 0
  let chars = message.text.length
  for (const attachment of message.attachments ?? []) {
    /*
     * Images are sent as image blocks, not as text, so their base64 is not a
     * number of characters the model reads. Counting it would have swamped
     * every other segment with a figure that stands for nothing.
     */
    if (attachment.mime.startsWith("image/")) continue
    chars += attachment.data.length
  }
  return chars
}

/** What an assistant turn puts back, split into prose and tool traffic. */
function assistantChars(message: Message): { assistant: number; tool: number } {
  if (message.role !== "assistant") return { assistant: 0, tool: 0 }
  let assistant = 0
  let tool = 0
  for (const part of message.parts) {
    if (part.type === "text" || part.type === "reasoning") {
      assistant += part.text.length
      continue
    }
    if (part.type !== "tool") continue
    /*
     * Sixteen characters an argument, which is the reference's own stand-in for
     * the serialised call: the arguments themselves are rarely what fills a
     * context, and the results always are.
     */
    tool += Object.keys(part.input).length * 16
    if (part.status === "completed") tool += part.output?.length ?? 0
    else if (part.status === "error") tool += part.error?.length ?? 0
  }
  return { assistant, tool }
}

function segments(tokens: Record<BreakdownKey, number>, input: number): BreakdownSegment[] {
  const keys: BreakdownKey[] = ["system", "user", "assistant", "tool", "other"]
  return keys
    // A segment worth nothing gets no swatch and no row, rather than a legend
    // entry reading 0% that the reader has to work out is not a fault.
    .filter((key) => tokens[key] > 0)
    .map((key) => ({
      key,
      tokens: tokens[key],
      share: (tokens[key] / input) * 100,
      percent: Math.round((tokens[key] / input) * 1000) / 10,
    }))
}

/**
 * Where the input tokens of the last turn probably went.
 *
 * "Probably" is the whole of it: the provider bills one number for the request
 * and never says how it divided. So the transcript is measured in characters,
 * the measurements are scaled to fit the number that was actually billed, and
 * whatever is left over becomes "other" - tool definitions and the framing the
 * provider adds.
 *
 * The system prompt used to be in that leftover too, because the window had no
 * way to read it, and it is big enough to have been a third of the bar with
 * nothing on screen saying so. The panel now asks the server for it, and passes
 * its length here as `system`; a caller that has not got it yet passes nothing
 * and the segment simply drops out, as it always did.
 */
export function estimateBreakdown(
  messages: readonly Message[],
  input: number,
  systemChars = 0,
): BreakdownSegment[] {
  if (!input) return []

  let user = 0
  let assistant = 0
  let tool = 0
  for (const message of messages) {
    user += userChars(message)
    const spoken = assistantChars(message)
    assistant += spoken.assistant
    tool += spoken.tool
  }

  const counted = {
    system: estimate(systemChars),
    user: estimate(user),
    assistant: estimate(assistant),
    tool: estimate(tool),
  }
  const total = counted.system + counted.user + counted.assistant + counted.tool

  // Room to spare: everything measured, and the remainder is what nobody here
  // can see.
  if (total <= input) return segments({ ...counted, other: input - total }, input)

  /*
   * Measured more than was billed, which happens on any conversation the model
   * has been asked to summarise - the older turns are still in the transcript
   * but no longer in the request. Scaled down to fit rather than shown
   * overflowing, because the proportions are still worth something even when
   * the absolute figures are not.
   */
  const scale = input / total
  const scaled = {
    system: Math.floor(counted.system * scale),
    user: Math.floor(counted.user * scale),
    assistant: Math.floor(counted.assistant * scale),
    tool: Math.floor(counted.tool * scale),
  }
  const fitted = scaled.system + scaled.user + scaled.assistant + scaled.tool
  return segments({ ...scaled, other: Math.max(0, input - fitted) }, input)
}
