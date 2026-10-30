import type { AssistantMessage, Message, ProviderStatus, SessionInfo, Usage } from "@shared/protocol"

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
  /** The figure is the compaction's estimate of the next request, not a count a provider reported. */
  estimated?: boolean
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
  compacted?: SessionInfo["compacted"],
): ContextReading | undefined {
  const message = lastSpendingTurn(messages)
  if (!message?.usage) return undefined

  /*
   * A compaction since that turn replaced the conversation it measured. No
   * request has gone out since, so there is no count to read - and the ring
   * went on showing the size of what had just been thrown away until the
   * reader said something more. The compaction left its estimate of the next
   * request, and that stands until a turn reports a real one.
   *
   * Which turn that is, is decided by where it sits in the transcript rather
   * than by the clock. A turn after the compaction's boundary is a request
   * made against the compacted conversation, so its count is the truth even
   * when its timestamps are equal to or behind the mark's: a turn that
   * overflowed half way through is compacted and asked again inside the same
   * second, and the two replies cannot be told apart by time at all. Only
   * when the boundary message is no longer in the transcript - an edited or
   * deleted conversation - does the timestamp decide, as it always did.
   */
  const reported = message.time.completed ?? message.time.created
  const boundary = compacted?.messageID
  const boundaryAt = boundary === undefined ? -1 : messages.findIndex((entry) => entry.id === boundary)
  const afterBoundary = boundaryAt >= 0 && messages.indexOf(message) > boundaryAt
  const estimated =
    compacted?.estimate !== undefined && !afterBoundary && (boundaryAt >= 0 || reported <= compacted.at) ? compacted.estimate : undefined

  /*
   * The window belongs to the model that ran that turn, which is not
   * necessarily the one the session is set to now: the model can be changed
   * mid-conversation, and those tokens were spent against the old one's limit.
   */
  const provider = providers.find((entry) => entry.id === message.model.provider)
  const model = provider?.models.find((entry) => entry.id === message.model.model)
  const window = model?.contextWindow
  const usage: Usage =
    estimated === undefined ? message.usage : { input: estimated, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }
  const used = tokensOf(usage)

  return {
    ...(estimated === undefined ? {} : { estimated: true }),
    message,
    usage,
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
